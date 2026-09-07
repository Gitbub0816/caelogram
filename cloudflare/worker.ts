import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createHmac } from "node:crypto";
import { Service } from "../src/service.js";
import { GitHub } from "../src/github.js";
import { dispatch, mcp, schemas, type ToolName } from "../src/tools.js";
import { demoRepository } from "../src/demo.js";
import { context } from "../src/graph.js";
import { assert, Fault, constantEqual } from "../src/security.js";
import type { Principal, Task, Changeset, Repository } from "../src/types.js";
import { CloudStore } from "./store.js";
import { errorDetails } from "./errors.js";
import { BatchedService, advanceIndex } from "./batched.js";
import {
  clerkIdentity,
  clerkIssuer,
  availableRepositories,
  resolveAccess,
  agentWorkspaces,
  identityTenant,
  startGitHub,
  finishGitHub,
} from "./onboarding.js";
import {
  agentIdentity,
  issueAgentToken,
  listAgentTokens,
} from "./agent-tokens.js";
import {
  oauthRoute,
  oauthIdentity,
  looksLikeOAuthToken,
  oauthCleanupStatements,
} from "./oauth.js";
export interface Env {
  INDEX_QUEUE?: Queue<{ tenant: string; job: string }>;
  CLERK_ISSUER?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_APP_SLUG: string;
  DB: D1Database;
  SOURCE: R2Bucket;
  ASSETS: Fetcher;
  REQUEST_LIMIT: RateLimit;
  PUBLIC_ORIGIN: string;
  DATA_KEY: string;
  JWKS_URL: string;
  ISSUER: string;
  /** HMAC key for Caelogram-issued OAuth credentials; falls back to DATA_KEY. */
  OAUTH_SIGNING_KEY?: string;
  AUDIENCE: string;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  INSTALLATIONS: string;
}
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
// Workers cancel un-awaited work the moment a response is returned, so buffered
// analytics would be dropped without a waitUntil hook. Capture stays off the
// response path; the isolate is just kept alive until the write lands.
function service(env: Env, ctx?: ExecutionContext) {
  const s = new BatchedService(env);
  if (ctx && s.analytics) s.analytics.defer = (work) => ctx.waitUntil(work);
  return s;
}
function clerkOriginForCsp(env: Env) {
  try {
    return env.CLERK_ISSUER || env.CLERK_PUBLISHABLE_KEY
      ? clerkIssuer(env)
      : "";
  } catch {
    return "";
  }
}
async function principal(req: Request, env: Env): Promise<Principal> {
  const presented = req.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/)?.[1];
  // A token this authorization server issued. It carries an identity and the
  // scope its owner consented to; repositories are resolved from GitHub below,
  // exactly as they are for a browser session.
  if (
    presented &&
    looksLikeOAuthToken(presented) &&
    (env.CLERK_ISSUER || env.CLERK_PUBLISHABLE_KEY)
  )
    return oauthIdentity(presented, env);
  const bearer = req.headers
    .get("authorization")
    ?.match(/^Bearer (caeg_.+)$/)?.[1];
  if (bearer && (env.CLERK_ISSUER || env.CLERK_PUBLISHABLE_KEY)) {
    const agent = await agentIdentity(bearer, env);
    // The token carries repository names its issuer proved through GitHub; the
    // workspaces holding those repositories follow from the names, not the token.
    agent.tenants = await agentWorkspaces(env, agent);
    return agent;
  }
  if (env.CLERK_ISSUER || env.CLERK_PUBLISHABLE_KEY)
    return clerkIdentity(req, env);
  assert(
    env.JWKS_URL && env.ISSUER && env.AUDIENCE,
    "Authentication is not configured",
    503,
  );
  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  assert(token, "Authentication required", 401);
  try {
    let jwks = jwksCache.get(env.JWKS_URL);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(env.JWKS_URL));
      jwksCache.set(env.JWKS_URL, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.ISSUER,
      audience: env.AUDIENCE,
      algorithms: ["RS256", "ES256"],
      maxTokenAge: "1h",
    });
    assert(
      typeof payload.sub === "string" &&
        typeof payload.tenant === "string" &&
        typeof payload.exp === "number",
      "Missing required identity claims",
      401,
    );
    return {
      subject: payload.sub,
      tenant: payload.tenant,
      scopes: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
      repositories: z.array(z.string()).parse(payload.repositories),
    };
  } catch {
    throw new Fault(401, "Invalid or expired access token");
  }
}
async function textBody(req: Request) {
  const reader = req.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= 2_000_000, "Request exceeds 2 MB", 413);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(bytes);
}
async function json(req: Request) {
  try {
    return JSON.parse(await textBody(req));
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault(400, "Invalid JSON");
  }
}
function reply(data: unknown, status = 200) {
  return Response.json(data, { status });
}
async function route(
  req: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url),
    path = url.pathname;
  if (
    path.startsWith("/api/") ||
    path === "/mcp" ||
    path === "/auth/github/callback" ||
    path === "/token" ||
    path === "/register" ||
    path === "/device_authorization" ||
    path === "/revoke" ||
    path === "/authorize" ||
    path === "/device"
  ) {
    const limit = await env.REQUEST_LIMIT.limit({
      key: req.headers.get("CF-Connecting-IP") || "local",
    });
    assert(limit.success, "Request limit reached; retry in one minute", 429);
  }
  if (path === "/health") return reply({ status: "ok", runtime: "cloudflare" });
  const origin = req.headers.get("origin");
  // The authorization server. Its token, registration, revocation and metadata
  // endpoints are called cross-origin by MCP clients and carry no cookies, so
  // they answer before the browser origin check; the two cookie-authenticated
  // pages (/authorize, /device) enforce the origin themselves on POST.
  if (!(
    (path === "/authorize" || path === "/device") &&
    req.method === "POST" &&
    origin &&
    origin !== (env.PUBLIC_ORIGIN || url.origin)
  )) {
    const handled = await oauthRoute(req, env, path);
    if (handled) return handled;
  } else assert(false, "Origin rejected", 403);
  assert(
    !origin || origin === (env.PUBLIC_ORIGIN || url.origin),
    "Origin rejected",
    403,
  );
  if (path === "/api/config" && req.method === "GET")
    return reply({
      clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || "",
      githubConfigured: Boolean(
        env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.GITHUB_APP_SLUG,
      ),
    });
  if (path === "/auth/github/callback" && req.method === "GET") {
    try {
      return await finishGitHub(req, env, service(env, ctx).store);
    } catch {
      return new Response(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GitHub connection · Caelogram</title><body style="background:#191a1a;color:#ece9e2;font:18px system-ui;padding:10%;max-width:640px"><h1>GitHub connection did not finish</h1><p>The authorization may have expired, been declined, or already been used. No repository was modified. Return to Caelogram and try connecting again.</p><a style="color:#d8bc86" href="/?connect=github">Return to your workspace</a></body></html>',
        {
          status: 400,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Set-Cookie":
              "caelogram_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/auth/github; Max-Age=0",
          },
        },
      );
    }
  }
  if (path === "/webhooks/github" && req.method === "POST") {
    assert(env.GITHUB_WEBHOOK_SECRET, "Webhook not configured", 503);
    const body = await textBody(req),
      signature = req.headers.get("x-hub-signature-256") || "";
    assert(
      constantEqual(
        signature,
        "sha256=" +
          createHmac("sha256", env.GITHUB_WEBHOOK_SECRET)
            .update(body)
            .digest("hex"),
      ),
      "Invalid webhook signature",
      401,
    );
    if (req.headers.get("x-github-event") !== "push")
      return reply({ ignored: true });
    const event = JSON.parse(body),
      id = req.headers.get("x-github-delivery");
    assert(id && id.length <= 200, "Delivery ID required");
    const input = z
      .object({
        name: z.string(),
        ref: z.string(),
        installationId: z.number().int(),
      })
      .parse({
        name: event.repository?.full_name,
        ref: event.ref,
        installationId: event.installation?.id,
      });
    await env.DB.prepare(
      "INSERT OR IGNORE INTO jobs(id,body,updated) VALUES(?,?,?)",
    )
      .bind(id, JSON.stringify(input), new Date().toISOString())
      .run();
    return reply({ queued: true }, 202);
  }
  if (path === "/api/demo" && req.method === "GET") {
    const r = demoRepository();
    return reply({
      ...Service.prototype.summary(r),
      nodes: r.graph.nodes,
      edges: r.graph.edges,
      warnings: r.graph.warnings,
    });
  }
  if (path === "/api/demo/task" && req.method === "POST") {
    const a = schemas.begin_change
        .omit({ repoId: true })
        .parse(await json(req)),
      r = demoRepository();
    return reply({
      id: "demo-task",
      repoId: r.id,
      base: r.graph.revision,
      prompt: a.prompt,
      context: context(r.graph, a.prompt, a.budget),
      createdAt: new Date().toISOString(),
    });
  }
  if (path.startsWith("/api/") || path === "/mcp") {
    const p = await principal(req, env),
      s = service(env, ctx);
    if (env.CLERK_ISSUER || env.CLERK_PUBLISHABLE_KEY) {
      if (
        path.startsWith("/api/github/") ||
        path.startsWith("/api/agent-tokens") ||
        path === "/api/audit" ||
        req.method === "DELETE"
      )
        s.allowed(p, "admin");
      if (path === "/api/agent-tokens" && req.method === "GET")
        return reply(await listAgentTokens(env, p));
      if (path.startsWith("/api/agent-tokens/") && req.method === "DELETE") {
        const id = path.slice("/api/agent-tokens/".length);
        await env.DB.prepare("DELETE FROM agent_tokens WHERE tenant=? AND id=?")
          .bind(p.tenant, id)
          .run();
        await s.store.audit(p.tenant, p.subject, "agent.revoked", id);
        return reply({ revoked: true });
      }
      // Owners can delete data retained under their own identity even after
      // GitHub access is revoked. Workspace data is deleted below, where GitHub
      // has said the caller still has access to the repository.
      if (path.startsWith("/api/repositories/") && req.method === "DELETE") {
        const id = decodeURIComponent(path.slice(18));
        const own = identityTenant(p.subject);
        const repo =
          (await s
            .q("SELECT name FROM index_repos WHERE tenant=? AND id=?", own, id)
            .first<{ name: string }>()) ||
          (await s.store
            .get<Repository>(own, "repo", id)
            .catch(() => null as Repository | null));
        if (repo)
          return reply(
            await s.store.exclusive(own, () =>
              s.remove(
                {
                  ...p,
                  tenant: own,
                  tenants: [own],
                  repositories: [repo.name],
                },
                id,
              ),
            ),
          );
      }
      if (path === "/api/github/start" && req.method === "POST") {
        const start = await startGitHub(p, env);
        return Response.json(
          { url: start.url },
          { headers: { "Set-Cookie": start.cookie } },
        );
      }
      if (path === "/api/github/disconnect" && req.method === "POST") {
        await env.DB.prepare("DELETE FROM access_cache WHERE principal=?")
          .bind(identityTenant(p.subject))
          .run();
        await s.store.exclusive(p.tenant, async () => {
          await s.store.remove(p.tenant, "github-link", "current");
          await env.DB.prepare("DELETE FROM agent_tokens WHERE tenant=?")
            .bind(p.tenant)
            .run();
          await s.store.audit(
            p.tenant,
            p.subject,
            "github.disconnected",
            "current",
          );
        });
        return reply({ disconnected: true });
      }
      // GitHub decides what this person can see. Nothing below this line takes
      // a tenant, repository or role from the request.
      const access = await resolveAccess(s.store, env, p, {
        // The Connect page's explicit refresh must ask GitHub, not the cache.
        force: path === "/api/github/repositories",
      });
      const available = access.repositories;
      // An agent token names the repositories its issuer proved through GitHub,
      // and is narrowed to those. A browser session, and an OAuth token which
      // carries the wildcard instead of a list, reach whatever GitHub grants
      // this person right now — which is the only source of the list either way.
      const everything =
        p.scopes.includes("admin") || p.repositories.includes("*");
      p.repositories = available
        .map((r) => r.name)
        .filter((name) => everything || p.repositories.includes(name));
      p.tenants = access.tenants;
      s.installations = access.installations;
      s.workspaces = access.workspaces;
      // Deployment readiness. Admin-gated and boolean-only — it reports whether a
      // secret is set and whether a table exists, never a value — because the
      // alternative is reading Cloudflare logs to find out that a migration was
      // never applied.
      if (path === "/api/diagnostics" && req.method === "GET") {
        s.allowed(p, "admin");
        const required = [
          "objects",
          "audit",
          "locks",
          "jobs",
          "oauth_states",
          "agent_tokens",
          "index_repos",
          "index_jobs",
          "index_files",
          "index_edges",
          "access_cache",
          "tenant_backfill",
          "oauth_clients",
          "oauth_pending",
          "oauth_codes",
          "oauth_grants",
          "oauth_tokens",
          "oauth_devices",
          "oauth_rate",
        ];
        const present = new Set(
          (
            await env.DB.prepare(
              "SELECT name FROM sqlite_master WHERE type='table'",
            ).all<{ name: string }>()
          ).results.map((r) => r.name),
        );
        let migrations: string[] = [];
        try {
          migrations = (
            await env.DB.prepare(
              "SELECT name FROM d1_migrations ORDER BY id",
            ).all<{ name: string }>()
          ).results.map((r) => r.name);
        } catch {
          // The tracking table itself is absent when nothing has been applied.
        }
        const missing = required.filter((t) => !present.has(t));
        return reply({
          schema: {
            ready: missing.length === 0,
            missingTables: missing,
            appliedMigrations: migrations,
            remedy: missing.length
              ? "wrangler d1 migrations apply caelogram --remote"
              : null,
          },
          configuration: Object.fromEntries(
            [
              "PUBLIC_ORIGIN",
              "CLERK_PUBLISHABLE_KEY",
              "CLERK_ISSUER",
              "GITHUB_APP_ID",
              "GITHUB_APP_SLUG",
              "GITHUB_CLIENT_ID",
              "GITHUB_CLIENT_SECRET",
              "GITHUB_PRIVATE_KEY",
              "GITHUB_WEBHOOK_SECRET",
            ].map((k) => [k, Boolean((env as any)[k])]),
          ),
          bindings: {
            DB: Boolean(env.DB),
            INDEX_QUEUE: Boolean(env.INDEX_QUEUE),
          },
        });
      }
      if (path === "/api/audit" && req.method === "GET") {
        // One trail per workspace: merge the workspaces GitHub still grants,
        // plus this person's own. Another person's identity trail is not theirs.
        const trails = await Promise.all(
          [
            ...new Set([
              identityTenant(p.subject),
              ...available.map((r) => r.tenant),
            ]),
          ].map((tenant) => s.store.events(tenant)),
        );
        return reply(
          trails
            .flat()
            .sort((a: any, b: any) => String(b.at).localeCompare(String(a.at)))
            .slice(0, 100),
        );
      }
      if (path === "/api/github/repositories" && req.method === "GET")
        return reply({
          repositories: available,
          installUrl: `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new`,
        });
      if (path === "/api/agent-tokens" && req.method === "POST") {
        s.allowed(p, "admin");
        const input = await json(req);
        return reply(
          await s.store.exclusive(p.tenant, async () => {
            assert(
              (await listAgentTokens(env, p)).length < 20,
              "Revoke an existing token before creating another",
              429,
            );
            const issued = await issueAgentToken(env, p, input);
            await s.store.audit(p.tenant, p.subject, "agent.issued", issued.id);
            return issued;
          }),
          201,
        );
      }
    }
    if (path === "/mcp") {
      assert(req.method === "POST", "Use stateless Streamable HTTP POST", 405);
      // Buffer only after enforcing the same body cap as REST.
      const parsed = await json(req),
        server = mcp(s, p),
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
      await server.connect(transport);
      try {
        return await transport.handleRequest(req, { parsedBody: parsed });
      } finally {
        await server.close();
      }
    }
    if (path.startsWith("/api/tools/") && req.method === "POST") {
      const name = path.slice(11);
      assert(Object.hasOwn(schemas, name), "Unknown tool", 404);
      return reply(await dispatch(s, p, name as ToolName, await json(req)));
    }
    if (path.startsWith("/api/galaxy/") && req.method === "GET")
      return reply(await s.galaxy(p, decodeURIComponent(path.slice(12))));
    if (path.startsWith("/api/component/") && req.method === "GET") {
      const target = url.searchParams.get("path");
      assert(target, "Provide a file path");
      return reply(
        await s.component(p, decodeURIComponent(path.slice(15)), target),
      );
    }
    if (path.startsWith("/api/history/") && req.method === "GET") {
      const repoId = decodeURIComponent(path.slice(13));
      await s.repo(p, repoId);
      const tasks = (await s.store.list<Task>(p.tenant, "task"))
        .filter((t) => t.repoId === repoId)
        .map((t) => ({
          id: t.id,
          prompt: t.prompt,
          base: t.base,
          createdAt: t.createdAt,
          estimatedTokens: t.context.estimatedTokens,
        }));
      const changes = (await s.store.list<Changeset>(p.tenant, "change"))
        .filter((c) => tasks.some((t) => t.id === c.taskId))
        .map(({ edits, ...c }) => ({ ...c, paths: edits.map((e) => e.path) }));
      return reply({ tasks, changes });
    }
    if (path === "/api/audit" && req.method === "GET") {
      s.allowed(p, "admin");
      return reply(await s.store.events(p.tenant));
    }
    if (path.startsWith("/api/repositories/") && req.method === "DELETE") {
      const id = decodeURIComponent(path.slice(18));
      // Resolve the workspace first so the change lock covers the workspace the
      // index actually lives in, not the caller's own key.
      await s.record(p, id).catch(() => null);
      return reply(await s.store.exclusive(p.tenant, () => s.remove(p, id)));
    }
    throw new Fault(404, "Route not found");
  }
  return env.ASSETS.fetch(req);
}
export async function processCloudJobs(env: Env) {
  const pending = await env.DB.prepare(
    "SELECT tenant,id FROM index_jobs WHERE phase IN ('discovering','indexing','resolving','deleting') AND lease<? ORDER BY created LIMIT 5",
  )
    .bind(Date.now())
    .all<{ tenant: string; id: string }>();
  for (const job of pending.results) {
    if (env.INDEX_QUEUE)
      await env.INDEX_QUEUE.send({ tenant: job.tenant, job: job.id });
    else await advanceIndex(env, job.tenant, job.id);
  }
  // Housekeeping is best-effort and independent. A single failing statement —
  // most often a table an unapplied migration never created — used to abort the
  // whole scheduled run, silently skipping every later step.
  for (const [statement, cutoff] of [
    ["DELETE FROM oauth_states WHERE expires<?", Date.now()],
    ["DELETE FROM agent_tokens WHERE expires<?", Date.now()],
    ["DELETE FROM access_cache WHERE expires<?", Date.now() - 86_400_000],
    ...oauthCleanupStatements(),
  ] as readonly (readonly [string, number])[])
    try {
      await env.DB.prepare(statement).bind(cutoff).run();
    } catch (e) {
      console.error(
        `Scheduled cleanup failed: ${statement} — ${e instanceof Error ? e.message : e}. ` +
          "If this names a missing table, apply the D1 migrations: wrangler d1 migrations apply caelogram --remote",
      );
    }
  const s = service(env);
  // One scheduler at a time, and durable per-tenant mutation locks below.
  await s.store.exclusive("$scheduler", async () => {
    const jobs = await env.DB.prepare(
      "SELECT id,body FROM jobs WHERE status='pending' AND attempts<5 ORDER BY updated LIMIT 3",
    ).all<{ id: string; body: string }>();
    for (const job of jobs.results) {
      try {
        const event = JSON.parse(job.body),
          rows = await env.DB.prepare(
            "SELECT DISTINCT tenant FROM objects WHERE kind='repo'",
          ).all<{ tenant: string }>();
        const batched = await s
          .q(
            "SELECT * FROM index_repos WHERE name=? AND installation=?",
            event.name,
            event.installationId,
          )
          .all<{
            tenant: string;
            name: string;
            branch: string;
            installation: number;
          }>();
        for (const repo of batched.results) {
          if (event.ref !== `refs/heads/${repo.branch}`) continue;
          const grants = repo.tenant.startsWith("user:")
            ? await availableRepositories(s.store, repo.tenant, env)
            : [];
          if (
            repo.tenant.startsWith("user:") &&
            !grants.some(
              (g) =>
                g.name === repo.name && g.installationId === repo.installation,
            )
          )
            continue;
          s.installations = {
            ...s.installations,
            [repo.tenant]: [repo.installation],
          };
          await s.connect(
            {
              tenant: repo.tenant,
              subject: "github-webhook",
              scopes: ["admin"],
              repositories: [repo.name],
            },
            repo.name,
            repo.branch,
            repo.installation,
          );
        }
        for (const { tenant } of rows.results) {
          if (tenant.startsWith("user:") && env.CLERK_ISSUER) {
            const repos = (
              await s.store.list<Repository>(tenant, "repo")
            ).filter(
              (r) =>
                r.name === event.name &&
                r.installationId === event.installationId &&
                event.ref === `refs/heads/${r.branch}`,
            );
            if (!repos.length) continue;
            const grants = await availableRepositories(s.store, tenant, env);
            s.installations = {
              [tenant]: [...new Set(grants.map((r) => r.installationId))],
            };
            for (const r of repos)
              if (
                grants.some(
                  (g) =>
                    g.name === r.name && g.installationId === r.installationId,
                ) &&
                r.name === event.name &&
                r.installationId === event.installationId &&
                event.ref === `refs/heads/${r.branch}`
              ) {
                await s.store.exclusive(tenant, () =>
                  s.connect(
                    {
                      tenant,
                      subject: "github-webhook",
                      scopes: ["admin"],
                      repositories: [r.name],
                    },
                    r.name,
                    r.branch,
                    r.installationId,
                  ),
                );
              }
            continue;
          }
          const repos = await s.store.list<Repository>(tenant, "repo");
          for (const r of repos)
            if (
              r.name === event.name &&
              r.installationId === event.installationId &&
              event.ref === `refs/heads/${r.branch}`
            ) {
              await s.store.exclusive(tenant, () =>
                s.connect(
                  {
                    tenant,
                    subject: "github-webhook",
                    scopes: ["admin"],
                    repositories: [r.name],
                  },
                  r.name,
                  r.branch,
                  r.installationId,
                ),
              );
            }
        }
        await env.DB.prepare(
          "UPDATE jobs SET status='complete',updated=? WHERE id=?",
        )
          .bind(new Date().toISOString(), job.id)
          .run();
      } catch {
        await env.DB.prepare(
          "UPDATE jobs SET attempts=attempts+1,status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,updated=? WHERE id=?",
        )
          .bind(new Date().toISOString(), job.id)
          .run();
      }
    }
  });
}
export default {
  async queue(batch: MessageBatch<unknown>, env: Env) {
    for (const message of batch.messages) {
      try {
        const body = z
          .object({ tenant: z.string(), job: z.string() })
          .parse(message.body);
        await advanceIndex(env, body.tenant, body.job);
        message.ack();
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "index.failed",
            errors: errorDetails(e, env),
          }),
        );
        message.retry({ delaySeconds: 30 });
      }
    }
  },
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const requestId = crypto.randomUUID();
    let response: Response;
    try {
      response = await route(req, env, ctx);
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "request.failed",
          requestId,
          method: req.method,
          path: new URL(req.url).pathname,
          status:
            e instanceof Fault ? e.status : e instanceof z.ZodError ? 400 : 500,
          errors:
            e instanceof z.ZodError
              ? [{ name: "ZodError", message: "Invalid request fields" }]
              : errorDetails(e, env),
        }),
      );
      response = reply(
        {
          requestId,
          error:
            e instanceof Fault
              ? e.message
              : e instanceof z.ZodError
                ? "Invalid request fields"
                : `Request failed. Reference: ${requestId}`,
        },
        e instanceof Fault ? e.status : e instanceof z.ZodError ? 400 : 500,
      );
    }
    const headers = new Headers(response.headers);
    headers.set("X-Request-ID", requestId);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    headers.set(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self' ${clerkOriginForCsp(env)} https://challenges.cloudflare.com https://*.protect.clerk.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://img.clerk.com; connect-src 'self' ${clerkOriginForCsp(env)} https://*.protect.clerk.com:* https://cloudflareinsights.com; frame-src https://challenges.cloudflare.com https://*.protect.clerk.com; worker-src 'self' blob:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'`,
    );
    if (
      new URL(req.url).pathname.startsWith("/api") ||
      new URL(req.url).pathname === "/mcp"
    )
      headers.set("Cache-Control", "no-store");
    if (response.status === 401)
      headers.set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource"`,
      );
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(processCloudJobs(env));
  },
} satisfies ExportedHandler<Env>;
