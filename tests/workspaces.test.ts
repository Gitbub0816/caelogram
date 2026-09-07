import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { CloudStore } from "../cloudflare/store.js";
import { BatchedService } from "../cloudflare/batched.js";
import { GitHub } from "../src/github.js";
import {
  resolveAccess,
  identityTenant,
  ownerTenant,
  agentWorkspaces,
} from "../cloudflare/onboarding.js";
import type { Env } from "../cloudflare/worker.js";
import type { Principal } from "../src/types.js";

const migrations = readdirSync("cloudflare/migrations").sort();
async function harness(upTo = migrations.length) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      compatibilityDate: "2026-09-01",
      d1Databases: ["DB"],
      r2Buckets: ["SOURCE"],
    }),
  );
  const db = await mf.getD1Database("DB"),
    bucket = await mf.getR2Bucket("SOURCE");
  const apply = async (files: string[]) => {
    for (const file of files)
      for (const sql of readFileSync("cloudflare/migrations/" + file, "utf8")
        .trim()
        .split("\n"))
        await db.prepare(sql).run();
  };
  await apply(migrations.slice(0, upTo));
  const env = {
    DB: db,
    SOURCE: bucket,
    DATA_KEY: "a".repeat(64),
    PUBLIC_ORIGIN: "https://app.example",
    GITHUB_CLIENT_ID: "app-client",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_APP_SLUG: "caelogram-test",
    INSTALLATIONS: "{}",
  } as unknown as Env;
  const store = new CloudStore(db as any, bucket as any, env.DATA_KEY);
  return { mf, db, env, store, apply };
}
function principal(subject: string): Principal {
  return {
    subject,
    tenant: identityTenant(subject),
    tenants: [identityTenant(subject)],
    scopes: ["admin"],
    repositories: [],
  };
}
/** GitHub as the single source of truth, faked: token → what that person may push to. */
function githubFor(grants: Record<string, any[]>, counter: { calls: number }) {
  return async (input: any, init?: RequestInit) => {
    const url = String(input),
      token = String(
        (init?.headers as any)?.Authorization ??
          (input as Request)?.headers?.get?.("authorization") ??
          "",
      ).replace("Bearer ", "");
    counter.calls++;
    if (url.endsWith("/user/installations?per_page=100"))
      return Response.json({
        total_count: 1,
        installations: [{ id: 1 }],
      });
    if (url.includes("/user/installations/1/repositories"))
      return Response.json({
        total_count: (grants[token] ?? []).length,
        repositories: grants[token] ?? [],
      });
    throw new Error("Unexpected outbound request: " + url);
  };
}
const acmeApi = {
  full_name: "acme/api",
  default_branch: "main",
  permissions: { push: true },
  owner: { login: "acme", id: 42, type: "Organization" },
};
const soloTool = {
  full_name: "solo/tool",
  default_branch: "main",
  permissions: { push: true },
  owner: { login: "solo", id: 7, type: "User" },
};
async function link(store: CloudStore, subject: string, token: string) {
  await store.put(identityTenant(subject), "github-link", {
    id: "current",
    token,
    expiresAt: Date.now() + 3_600_000,
  });
}
/** Force the indexer to report a finished map without running one. */
async function markReady(env: Env, tenant: string, repo: string) {
  await env.DB.prepare(
    "UPDATE index_jobs SET phase='ready',files=2,done=2,resolved=2 WHERE tenant=? AND repo=?",
  )
    .bind(tenant, repo)
    .run();
  await env.DB.prepare(
    "UPDATE index_repos SET current_job=latest_job WHERE tenant=? AND id=?",
  )
    .bind(tenant, repo)
    .run();
}

test("an organization repository is one workspace: a colleague GitHub grants access to reads the same index, a stranger cannot", async (t) => {
  const { mf, env, store } = await harness();
  try {
    const counter = { calls: 0 };
    t.mock.method(
      globalThis,
      "fetch",
      githubFor(
        { "token-a": [acmeApi], "token-b": [acmeApi], "token-c": [soloTool] },
        counter,
      ),
    );
    t.mock.method(GitHub.prototype, "head", async () => "b".repeat(40));
    t.mock.method(GitHub.prototype, "api", async () => ({
      tree: { sha: "c".repeat(40) },
    }));
    await link(store, "user_a", "token-a");
    await link(store, "user_b", "token-b");
    await link(store, "user_c", "token-c");

    const s = new BatchedService(env);
    const a = principal("user_a");
    const accessA = await resolveAccess(store, env, a);
    assert.deepEqual(accessA.repositories[0].owner, {
      login: "acme",
      id: 42,
      type: "org",
    });
    assert.equal(accessA.repositories[0].tenant, "gh:org:42");
    assert.equal(
      ownerTenant({ login: "acme", id: 42, type: "org" }),
      "gh:org:42",
    );
    a.repositories = accessA.repositories.map((r) => r.name);
    a.tenants = accessA.tenants;
    s.installations = accessA.installations;
    s.workspaces = accessA.workspaces;
    const connected = await s.connect(a, "acme/api", "main", 1);
    // The index belongs to the GitHub owner, not to the person who made it.
    const owning = await env.DB.prepare(
      "SELECT tenant FROM index_repos WHERE id=?",
    )
      .bind(connected.id)
      .first<{ tenant: string }>();
    assert.equal(owning?.tenant, "gh:org:42");
    await markReady(env, "gh:org:42", connected.id);

    const b = principal("user_b");
    const accessB = await resolveAccess(store, env, b);
    b.repositories = accessB.repositories.map((r) => r.name);
    b.tenants = accessB.tenants;
    const forB = new BatchedService(env);
    const listed = await forB.list(b);
    assert.deepEqual(
      listed.map((r) => [r.id, r.name, r.status]),
      [[connected.id, "acme/api", "ready"]],
    );
    assert.equal((await forB.record(b, connected.id)).name, "acme/api");
    assert.equal(b.tenant, "gh:org:42", "reading moves onto the workspace");

    const c = principal("user_c");
    const accessC = await resolveAccess(store, env, c);
    c.repositories = accessC.repositories.map((r) => r.name);
    c.tenants = accessC.tenants;
    const forC = new BatchedService(env);
    assert.deepEqual(await forC.list(c), []);
    await assert.rejects(
      () => forC.record(c, connected.id),
      /Repository not found/,
    );
  } finally {
    await mf.dispose();
  }
});

test("resolved GitHub access is cached for a few minutes and revocation takes effect when it expires", async (t) => {
  const { mf, env, store, db } = await harness();
  try {
    const counter = { calls: 0 };
    let grants: Record<string, any[]> = { "token-a": [acmeApi] };
    t.mock.method(globalThis, "fetch", (input: any, init?: RequestInit) =>
      githubFor(grants, counter)(input, init),
    );
    t.mock.method(GitHub.prototype, "head", async () => "b".repeat(40));
    t.mock.method(GitHub.prototype, "api", async () => ({
      tree: { sha: "c".repeat(40) },
    }));
    await link(store, "user_a", "token-a");
    const a = principal("user_a");
    const first = await resolveAccess(store, env, a);
    assert.equal(first.cached, false);
    const afterFirst = counter.calls;
    assert(afterFirst > 0);

    const again = await resolveAccess(store, env, a);
    assert.equal(again.cached, true);
    assert.equal(counter.calls, afterFirst, "no GitHub round trip inside TTL");
    // An explicit refresh from the Connect page still asks GitHub.
    assert.equal(
      (await resolveAccess(store, env, a, { force: true })).cached,
      false,
    );
    assert(counter.calls > afterFirst);
    assert.deepEqual(again.repositories, first.repositories);
    const ttl = await db
      .prepare("SELECT refreshed,expires FROM access_cache WHERE principal=?")
      .bind("user:user_a")
      .first<{ refreshed: number; expires: number }>();
    assert.equal(ttl!.expires - ttl!.refreshed, 180_000);

    // Index a repository, then take the GitHub grant away.
    a.repositories = first.repositories.map((r) => r.name);
    a.tenants = first.tenants;
    const s = new BatchedService(env);
    s.installations = first.installations;
    s.workspaces = first.workspaces;
    const connected = await s.connect(a, "acme/api", "main", 1);
    await markReady(env, "gh:org:42", connected.id);

    // An agent token reaches the workspaces holding the repositories its
    // issuer proved through GitHub, and nothing else.
    assert.deepEqual(
      await agentWorkspaces(env, {
        subject: "agent",
        tenant: "user:user_a",
        scopes: ["read"],
        repositories: ["acme/api"],
      }),
      ["user:user_a", "gh:org:42"],
    );

    grants = { "token-a": [] };
    // Still cached: the stale answer stands until the entry expires.
    assert.equal((await resolveAccess(store, env, a)).cached, true);
    await db
      .prepare("UPDATE access_cache SET expires=? WHERE principal=?")
      .bind(Date.now() - 1, "user:user_a")
      .run();
    const revoked = await resolveAccess(store, env, a);
    assert.equal(revoked.cached, false);
    assert.deepEqual(revoked.repositories, []);
    const gone = principal("user_a");
    gone.repositories = revoked.repositories.map((r) => r.name);
    gone.tenants = revoked.tenants;
    const after = new BatchedService(env);
    assert.deepEqual(await after.list(gone), []);
    await assert.rejects(
      () => after.record(gone, connected.id),
      /Repository not found/,
    );
  } finally {
    await mf.dispose();
  }
});

test("migration 0006 records every pre-workspace index and the runtime maps it onto its GitHub owner", async (t) => {
  const { mf, env, store, db, apply } = await harness(migrations.length - 1);
  try {
    // An index created before workspaces existed, under its author's own tenant.
    const legacy = "user:user_legacy";
    await db
      .prepare(
        "INSERT INTO index_repos(tenant,id,name,branch,installation,current_job,latest_job) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        legacy,
        "legacy-repo",
        "acme/api",
        "main",
        1,
        "legacy-job",
        "legacy-job",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO index_jobs(tenant,id,repo,revision,phase,files,done,resolved,created,analyzer_version) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        legacy,
        "legacy-job",
        "legacy-repo",
        "d".repeat(40),
        "ready",
        3,
        3,
        3,
        new Date().toISOString(),
        2,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO index_files(tenant,job,path,sha,bytes,metadata,done,resolved) VALUES(?,?,?,?,?,?,1,1)",
      )
      .bind(legacy, "legacy-job", "src/api.ts", "e".repeat(40), 12, "{}")
      .run();

    await apply([migrations[migrations.length - 1]]);
    const parked = await db.prepare("SELECT * FROM tenant_backfill").all<any>();
    assert.deepEqual(
      parked.results.map((r) => [
        r.old_tenant,
        r.repo_id,
        r.name,
        r.new_tenant,
      ]),
      [[legacy, "legacy-repo", "acme/api", null]],
    );

    const counter = { calls: 0 };
    t.mock.method(
      globalThis,
      "fetch",
      githubFor({ "token-b": [acmeApi] }, counter),
    );
    await link(store, "user_b", "token-b");
    const b = principal("user_b");
    const access = await resolveAccess(store, env, b);
    b.repositories = access.repositories.map((r) => r.name);
    b.tenants = access.tenants;
    assert.deepEqual(access.legacy, [{ tenant: legacy, name: "acme/api" }]);
    assert(access.tenants.includes(legacy));
    const mapped = await db
      .prepare("SELECT new_tenant,linked FROM tenant_backfill")
      .first<{ new_tenant: string; linked: number }>();
    assert.equal(mapped?.new_tenant, "gh:org:42");
    assert(mapped!.linked > 0);

    // The existing index survives untouched and is now readable by everyone
    // GitHub grants the repository to.
    const s = new BatchedService(env);
    const listed = await s.list(b);
    assert.deepEqual(
      listed.map((r) => [r.id, r.name, r.status, r.files]),
      [["legacy-repo", "acme/api", "ready", 3]],
    );
    assert.equal((await s.record(b, "legacy-repo")).name, "acme/api");
    const files = await db
      .prepare("SELECT tenant,path FROM index_files")
      .first<{ tenant: string; path: string }>();
    assert.deepEqual(
      [files?.tenant, files?.path],
      [legacy, "src/api.ts"],
      "rows stay where their encrypted source is bound",
    );

    // Re-indexing updates the surviving index in place instead of forking it.
    t.mock.method(GitHub.prototype, "head", async () => "f".repeat(40));
    t.mock.method(GitHub.prototype, "api", async () => ({
      tree: { sha: "c".repeat(40) },
    }));
    const s2 = new BatchedService(env);
    s2.installations = access.installations;
    s2.workspaces = access.workspaces;
    const again = await s2.connect(b, "acme/api", "main", 1);
    assert.equal(again.id, "legacy-repo");
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS n FROM index_repos").first<any>())
        .n,
      1,
    );
  } finally {
    await mf.dispose();
  }
});
