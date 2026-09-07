import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomBytes, createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Store } from "./store.js";
import { GitHub } from "./github.js";
import { Service } from "./service.js";
import { Fault, assert, constantEqual } from "./security.js";
import { dispatch, mcp, schemas, type ToolName } from "./tools.js";
import { processJobs } from "./worker.js";
import { demoRepository } from "./demo.js";
import { context } from "./graph.js";
import type { Principal, Repository, Task, Changeset } from "./types.js";
const production = process.env.NODE_ENV === "production";
export function createServer(service: Service, devToken?: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  const origin = process.env.CAELOGRAM_ORIGIN ?? "http://localhost:4310";
  app.use((req, res, next) => {
    if (
      req.headers.origin &&
      ![
        origin,
        ...(!production
          ? ["http://localhost:5173", "http://terminal.local:4173"]
          : []),
      ].includes(req.headers.origin)
    )
      return res.status(403).json({ error: "Origin not allowed" });
    next();
  });
  app.get("/api/config", (_req, res) =>
    res.json({ clerkPublishableKey: "", local: true }),
  );
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", version: "0.1.0" }),
  );
  app.get("/.well-known/oauth-protected-resource", (_req, res) =>
    res.json({
      resource: process.env.CAELOGRAM_AUDIENCE ?? origin,
      authorization_servers: process.env.CAELOGRAM_ISSUER
        ? [process.env.CAELOGRAM_ISSUER]
        : [],
      scopes_supported: ["read", "write", "publish", "admin"],
      bearer_methods_supported: ["header"],
    }),
  );
  app.post(
    "/webhooks/github",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res, next) => {
      try {
        const secret = process.env.GITHUB_WEBHOOK_SECRET;
        assert(secret, "Webhook not configured", 503);
        assert(
          constantEqual(
            String(req.headers["x-hub-signature-256"] ?? ""),
            "sha256=" +
              createHmac("sha256", secret).update(req.body).digest("hex"),
          ),
          "Invalid webhook signature",
          401,
        );
        // Persist the event and its synchronization work atomically; retry processing after restarts.
        const id = String(req.headers["x-github-delivery"] ?? "");
        assert(id.length > 0 && id.length < 100, "Missing delivery ID");
        const event = JSON.parse(req.body.toString("utf8"));
        service.store.db.exec("BEGIN IMMEDIATE");
        try {
          const result = service.store.db
            .prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?)")
            .run(id, new Date().toISOString());
          if (result.changes && req.headers["x-github-event"] === "push")
            service.store.db
              .prepare("INSERT INTO jobs(id,body,updated) VALUES(?,?,?)")
              .run(
                id,
                JSON.stringify({
                  name: event.repository?.full_name,
                  installationId: event.installation?.id,
                  ref: event.ref,
                }),
                new Date().toISOString(),
              );
          service.store.db.exec("COMMIT");
          res
            .status(202)
            .json({ received: true, duplicate: result.changes === 0 });
        } catch (e) {
          service.store.db.exec("ROLLBACK");
          throw e;
        }
      } catch (e) {
        next(e);
      }
    },
  );
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/demo", (_req, res) => {
    const r = demoRepository();
    res.json({
      ...service.summary(r),
      nodes: r.graph.nodes,
      edges: r.graph.edges,
      warnings: r.graph.warnings,
    });
  });
  app.post("/api/demo/task", (req, res) => {
    const a = z
      .object({
        prompt: z.string().min(3).max(4000),
        budget: z.number().int().min(500).max(16000).default(3000),
      })
      .parse(req.body);
    const r = demoRepository();
    res.json({
      id: "demo-task",
      repoId: r.id,
      base: r.graph.revision,
      prompt: a.prompt,
      context: context(r.graph, a.prompt, a.budget),
      createdAt: new Date().toISOString(),
    });
  });
  const jwks = process.env.CAELOGRAM_JWKS_URL
    ? createRemoteJWKSet(new URL(process.env.CAELOGRAM_JWKS_URL))
    : null;
  app.use(["/api", "/mcp"], async (req, res, next) => {
    try {
      const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      assert(bearer, "Authentication required", 401);
      let p: Principal;
      if (!production && devToken && constantEqual(bearer, devToken))
        p = {
          tenant: "local",
          subject: "developer",
          scopes: ["admin"],
          repositories: ["*"],
        };
      else {
        assert(
          jwks &&
            process.env.CAELOGRAM_ISSUER &&
            process.env.CAELOGRAM_AUDIENCE,
          "Authentication is not configured",
          401,
        );
        const { payload } = await jwtVerify(bearer, jwks, {
          issuer: process.env.CAELOGRAM_ISSUER,
          audience: process.env.CAELOGRAM_AUDIENCE,
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
        p = {
          subject: payload.sub,
          tenant: payload.tenant,
          scopes:
            typeof payload.scope === "string" ? payload.scope.split(" ") : [],
          repositories: z.array(z.string()).parse(payload.repositories),
        };
      }
      res.locals.principal = p;
      next();
    } catch (e) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      );
      next(
        e instanceof Fault
          ? e
          : new Fault(401, "Invalid or expired access token"),
      );
    }
  });
  app.post("/api/tools/:name", async (req, res, next) => {
    try {
      assert(Object.hasOwn(schemas, req.params.name), "Unknown tool", 404);
      res.json(
        await dispatch(
          service,
          res.locals.principal,
          req.params.name as ToolName,
          req.body,
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/galaxy/:repoId", async (req, res, next) => {
    try {
      res.json(await service.galaxy(res.locals.principal, req.params.repoId));
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/history/:repoId", async (req, res, next) => {
    try {
      const p = res.locals.principal as Principal;
      await service.repo(p, req.params.repoId);
      const tasks = (await service.store.list<Task>(p.tenant, "task"))
        .filter((t) => t.repoId === req.params.repoId)
        .map((t) => ({
          id: t.id,
          prompt: t.prompt,
          base: t.base,
          createdAt: t.createdAt,
          estimatedTokens: t.context.estimatedTokens,
        }));
      const changes = (await service.store.list<Changeset>(p.tenant, "change"))
        .filter((c) => tasks.some((t) => t.id === c.taskId))
        .map(({ edits, ...c }) => ({ ...c, paths: edits.map((e) => e.path) }));
      res.json({ tasks, changes });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/audit", async (req, res, next) => {
    try {
      const p = res.locals.principal as Principal;
      service.allowed(p, "admin");
      res.json(await service.store.events(p.tenant));
    } catch (e) {
      next(e);
    }
  });
  app.delete("/api/repositories/:id", async (req, res, next) => {
    try {
      res.json(await service.remove(res.locals.principal, req.params.id));
    } catch (e) {
      next(e);
    }
  });
  app.post("/mcp", async (req, res, next) => {
    const server = mcp(service, res.locals.principal),
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
    try {
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      next(e);
    }
  });
  app.all("/mcp", (_req, res) =>
    res
      .status(405)
      .set("Allow", "POST")
      .json({ error: "Use Streamable HTTP POST" }),
  );
  app.use(express.static(resolve("public")));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/"))
      return next(new Fault(404, "Route not found"));
    res.sendFile(resolve("public/index.html"));
  });
  app.use(
    (
      e: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        e instanceof Fault ? e.status : e instanceof z.ZodError ? 400 : 500;
      res.status(status).json({
        error:
          status === 500
            ? "Internal request failure"
            : e instanceof Error
              ? e.message
              : "Request failed",
      });
    },
  );
  return app;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (production)
    assert(
      process.env.CAELOGRAM_DATA_KEY &&
        process.env.CAELOGRAM_JWKS_URL &&
        process.env.CAELOGRAM_ORIGIN?.startsWith("https://") &&
        process.env.CAELOGRAM_ISSUER &&
        process.env.CAELOGRAM_AUDIENCE,
      "Production requires encryption, TLS origin, and OIDC configuration",
    );
  const token = process.env.CAELOGRAM_TOKEN ?? randomBytes(32).toString("hex");
  const store = new Store(
    process.env.CAELOGRAM_DB ?? ".data/caelogram.db",
    process.env.CAELOGRAM_DATA_KEY,
  );
  const service = new Service(store, new GitHub());
  let working = false;
  const worker = setInterval(() => {
    if (working) return;
    working = true;
    void processJobs(service).finally(() => {
      working = false;
    });
  }, 5000);
  const server = createServer(service, token).listen(
    Number(process.env.PORT ?? 4310),
    production ? "0.0.0.0" : "127.0.0.1",
    () => {
      console.log("Caelogram listening on port " + (process.env.PORT ?? 4310));
      if (!production && !process.env.CAELOGRAM_TOKEN)
        console.log("Development bearer token (this process only): " + token);
    },
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () =>
      server.close(() => {
        clearInterval(worker);
        store.close();
        process.exit(0);
      }),
    );
}
