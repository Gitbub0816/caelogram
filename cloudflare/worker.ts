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
export interface Env {
  DB: D1Database;
  SOURCE: R2Bucket;
  ASSETS: Fetcher;
  REQUEST_LIMIT: RateLimit;
  PUBLIC_ORIGIN: string;
  DATA_KEY: string;
  JWKS_URL: string;
  ISSUER: string;
  AUDIENCE: string;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  INSTALLATIONS: string;
}
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function service(env: Env) {
  return new Service(
    new CloudStore(env.DB, env.SOURCE, env.DATA_KEY),
    new GitHub({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
    }),
    JSON.parse(env.INSTALLATIONS || "{}"),
  );
}
async function principal(req: Request, env: Env): Promise<Principal> {
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
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url),
    path = url.pathname;
  if (path.startsWith("/api/") || path === "/mcp") {
    const limit = await env.REQUEST_LIMIT.limit({
      key: req.headers.get("CF-Connecting-IP") || "local",
    });
    assert(limit.success, "Request limit reached; retry in one minute", 429);
  }
  if (path === "/health") return reply({ status: "ok", runtime: "cloudflare" });
  if (path.startsWith("/.well-known/oauth-protected-resource"))
    return reply({
      resource: env.PUBLIC_ORIGIN,
      authorization_servers: env.ISSUER ? [env.ISSUER] : [],
      scopes_supported: ["read", "write", "publish", "admin"],
      bearer_methods_supported: ["header"],
    });
  const origin = req.headers.get("origin");
  assert(
    !origin || origin === (env.PUBLIC_ORIGIN || url.origin),
    "Origin rejected",
    403,
  );
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
      s = service(env);
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
    if (path.startsWith("/api/repositories/") && req.method === "DELETE")
      return reply(
        await s.store.exclusive(p.tenant, () =>
          s.remove(p, decodeURIComponent(path.slice(18))),
        ),
      );
    throw new Fault(404, "Route not found");
  }
  return env.ASSETS.fetch(req);
}
export async function processCloudJobs(env: Env) {
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
        for (const { tenant } of rows.results) {
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
  async fetch(req: Request, env: Env) {
    let response: Response;
    try {
      response = await route(req, env);
    } catch (e) {
      response = reply(
        {
          error:
            e instanceof Fault
              ? e.message
              : e instanceof z.ZodError
                ? "Invalid request fields"
                : "Request failed",
        },
        e instanceof Fault ? e.status : e instanceof z.ZodError ? 400 : 500,
      );
    }
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
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
