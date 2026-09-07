import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { CloudStore } from "../cloudflare/store.js";
import {
  startGitHub,
  finishGitHub,
  availableRepositories,
  clerkIdentity,
  clerkIssuer,
} from "../cloudflare/onboarding.js";
import {
  issueAgentToken,
  agentIdentity,
  listAgentTokens,
} from "../cloudflare/agent-tokens.js";
import type { Env } from "../cloudflare/worker.js";

test("Clerk identity rejects wrong origin/expired sessions and ignores caller-supplied tenant grants", async (t) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ keys: [jwk] }),
  );
  const env = {
    CLERK_ISSUER: "https://clerk-test.example",
    PUBLIC_ORIGIN: "https://app.example",
  } as Env;
  async function session(extra: Record<string, unknown> = {}, expired = false) {
    return new SignJWT({
      sid: "sess_test",
      azp: env.PUBLIC_ORIGIN,
      tenant: "victim",
      repositories: ["*"],
      ...extra,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("user_a")
      .setIssuer(env.CLERK_ISSUER!)
      .setIssuedAt()
      .setExpirationTime(expired ? "0s" : "60s")
      .sign(privateKey);
  }
  const request = (token: string) =>
    new Request("https://app.example/api/tools/list_repositories", {
      headers: { Authorization: `Bearer ${token}` },
    });
  assert.deepEqual(await clerkIdentity(request(await session()), env), {
    subject: "user_a",
    tenant: "user:user_a",
    tenants: ["user:user_a"],
    scopes: ["admin"],
    repositories: [],
  });
  await assert.rejects(
    () => clerkIdentity(new Request("https://app.example/api/config"), env),
    /Sign in/,
  );
  await assert.rejects(
    async () =>
      clerkIdentity(
        request(await session({ azp: "https://evil.example" })),
        env,
      ),
    /Invalid or expired/,
  );
  await assert.rejects(
    async () => clerkIdentity(request(await session({}, true)), env),
    /Invalid or expired/,
  );
});

test("Clerk issuer falls back to the Frontend API encoded in its publishable key", () => {
  const domain = "clerk.caelogram.com";
  const key = `pk_live_${Buffer.from(`${domain}$`).toString("base64url")}`;
  assert.equal(
    clerkIssuer({ CLERK_PUBLISHABLE_KEY: key } as Env),
    `https://${domain}`,
  );
});

test("self-service OAuth binds browser and tenant, rejects replay, rotates encrypted tokens and filters GitHub grants", async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      compatibilityDate: "2026-09-01",
      d1Databases: ["DB"],
      r2Buckets: ["SOURCE"],
    }),
  );
  try {
    const db = await mf.getD1Database("DB"),
      bucket = await mf.getR2Bucket("SOURCE");
    for (const file of readdirSync("cloudflare/migrations").sort())
      for (const sql of readFileSync("cloudflare/migrations/" + file, "utf8")
        .trim()
        .split("\n"))
        await db.prepare(sql).run();
    const env = {
      DB: db,
      SOURCE: bucket,
      DATA_KEY: "a".repeat(64),
      PUBLIC_ORIGIN: "https://app.example",
      GITHUB_CLIENT_ID: "app-client",
      GITHUB_CLIENT_SECRET: "test-client-secret",
      GITHUB_APP_SLUG: "caelogram-test",
    } as unknown as Env;
    const store = new CloudStore(env.DB, env.SOURCE, env.DATA_KEY),
      p = {
        subject: "user_a",
        tenant: "user:user_a",
        scopes: ["admin"],
        repositories: ["owner/writable"],
      };
    let exchanges = 0,
      refreshes = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          const body = JSON.parse(String(init?.body));
          if (body.grant_type === "refresh_token") {
            refreshes++;
            assert.equal(body.refresh_token, "test-refresh");
          } else exchanges++;
          return Response.json({
            access_token: "test-access",
            expires_in: 28800,
            refresh_token: "test-refresh",
            refresh_token_expires_in: 15897600,
          });
        }
        if (url === "https://api.github.com/user")
          return Response.json({ id: 10 });
        if (url.endsWith("/user/installations?per_page=100"))
          return Response.json({
            total_count: 2,
            installations: [{ id: 1 }, { id: 2, suspended_at: "2026-01-01" }],
          });
        if (url.includes("/user/installations/1/repositories"))
          return Response.json({
            total_count: 4,
            repositories: [
              {
                full_name: "owner/writable",
                default_branch: "main",
                permissions: { push: true },
                owner: { login: "owner", id: 42, type: "Organization" },
              },
              {
                full_name: "owner/readonly",
                permissions: { push: false },
                owner: { login: "owner", id: 42, type: "Organization" },
              },
              {
                full_name: "owner/archived",
                permissions: { push: true },
                archived: true,
                owner: { login: "owner", id: 42, type: "Organization" },
              },
              {
                full_name: "mystery/unknown-owner",
                default_branch: "main",
                permissions: { push: true },
              },
            ],
          });
        throw new Error("Unexpected outbound request: " + url);
      },
    );
    const start = await startGitHub(p, env),
      state = new URL(start.url).searchParams.get("state");
    assert(start.cookie.includes("HttpOnly; Secure; SameSite=Lax"));
    const callback = (cookie = start.cookie.split(";")[0]) =>
      new Request(
        `https://app.example/auth/github/callback?state=${state}&code=sample`,
        { headers: { Cookie: cookie } },
      );
    await assert.rejects(
      () => finishGitHub(callback("caelogram_oauth=forged"), env, store),
      /invalid/,
    );
    assert.equal(exchanges, 0);
    const result = await finishGitHub(callback(), env, store);
    assert.equal(result.status, 303);
    assert.equal(
      result.headers.get("Location"),
      "https://app.example/?connect=github",
    );
    await assert.rejects(
      () => finishGitHub(callback(), env, store),
      /already used/,
    );
    assert.equal(exchanges, 1);
    await assert.rejects(
      () => store.get("user:user_b", "github-link", "current"),
      /not found/,
    );
    const link = await store.get<any>(p.tenant, "github-link", "current");
    await store.put(p.tenant, "github-link", {
      ...link,
      expiresAt: Date.now() - 1,
    });
    // The repository whose owner GitHub did not describe is omitted, never
    // assigned to a guessed workspace.
    assert.deepEqual(await availableRepositories(store, p.tenant, env), [
      {
        name: "owner/writable",
        branch: "main",
        installationId: 1,
        owner: { login: "owner", id: 42, type: "org" },
        tenant: "gh:org:42",
      },
    ]);
    await availableRepositories(store, p.tenant, env);
    assert.equal(refreshes, 1);
    const rows = await db
      .prepare("SELECT object_key FROM objects WHERE kind='github-link'")
      .all<{ object_key: string }>();
    assert(
      !(await (await bucket.get(rows.results[0].object_key))!.text()).includes(
        "test-access",
      ),
    );
    const issued = await issueAgentToken(env, p, {
      label: "Codex",
      repositories: p.repositories,
      hours: 1,
    });
    const agent = await agentIdentity(issued.token, env);
    assert.deepEqual(agent.scopes, ["read", "write"]);
    assert.equal(agent.tenant, p.tenant);
    assert.deepEqual(agent.repositories, p.repositories);
    await assert.rejects(
      () =>
        issueAgentToken(env, agent, {
          label: "escalate",
          repositories: p.repositories,
        }),
      /owner/,
    );
    await assert.rejects(
      () =>
        issueAgentToken(env, p, {
          label: "other",
          repositories: ["owner/private"],
        }),
      /denied/,
    );
    assert.equal(
      (await listAgentTokens(env, { ...p, tenant: "user:user_b" })).length,
      0,
    );
    const saved = await db
      .prepare("SELECT hash FROM agent_tokens")
      .first<{ hash: string }>();
    assert.notEqual(saved?.hash, issued.token);
    await db
      .prepare("UPDATE agent_tokens SET expires=0 WHERE id=?")
      .bind(issued.id)
      .run();
    await assert.rejects(
      () => agentIdentity(issued.token, env),
      /expired or revoked/,
    );
    await store.remove(p.tenant, "github-link", "current");
    assert.deepEqual(await availableRepositories(store, p.tenant, env), []);
  } finally {
    await mf.dispose();
  }
});
