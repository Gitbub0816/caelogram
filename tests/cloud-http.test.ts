import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import ts from "typescript";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
test("bundled Cloudflare Worker runs demo, context, origin checks and fail-closed authentication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "caelogram-worker-test-"));
  const config = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    readFileSync("wrangler.jsonc", "utf8"),
  ).config;
  config.main = resolve("cloudflare/worker.ts");
  delete config.assets;
  delete config.$schema;
  writeFileSync(join(directory, "wrangler.json"), JSON.stringify(config));
  execFileSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--dry-run",
      "--config",
      join(directory, "wrangler.json"),
      "--outdir",
      directory,
    ],
    { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: readFileSync(join(directory, "worker.js"), "utf8"),
      compatibilityDate: "2026-09-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { PUBLIC_ORIGIN: "https://caelogram.test" },
      d1Databases: ["DB"],
      r2Buckets: ["SOURCE"],
      ratelimits: {
        REQUEST_LIMIT: {
          namespace_id: "1001",
          simple: { limit: 120, period: 60 },
        },
      },
    }),
  );
  try {
    const configuration = await mf.dispatchFetch(
      "https://caelogram.test/api/config",
    );
    assert.equal(configuration.status, 200);
    assert.deepEqual(await configuration.json(), {
      clerkPublishableKey: "",
      githubConfigured: false,
    });
    const callback = await mf.dispatchFetch(
      "https://caelogram.test/auth/github/callback?state=forged&code=fake",
    );
    assert.equal(callback.status, 400);
    assert.match(callback.headers.get("Content-Type") || "", /text\/html/);
    assert.match(await callback.text(), /Return to your workspace/);
    const demo = await mf.dispatchFetch("https://caelogram.test/api/demo");
    assert.equal(demo.status, 200);
    assert.equal(((await demo.json()) as any).files, 24);
    assert.equal(demo.headers.get("Cache-Control"), "no-store");
    const task = await mf.dispatchFetch(
      "https://caelogram.test/api/demo/task",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "payment authorization", budget: 2000 }),
      },
    );
    assert.equal(task.status, 200);
    assert(((await task.json()) as any).context.estimatedTokens <= 2000);
    assert.equal(
      (
        await mf.dispatchFetch("https://caelogram.test/api/demo", {
          headers: { Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await mf.dispatchFetch(
          "https://caelogram.test/api/tools/list_repositories",
          { method: "POST", body: "{}" },
        )
      ).status,
      503,
    );
    const metadata = await mf.dispatchFetch(
      "https://caelogram.test/.well-known/oauth-protected-resource",
    );
    const resource = (await metadata.json()) as any;
    assert.equal(resource.resource, "https://caelogram.test");
    // RFC 9728: the deployment names an authorization server, and it is itself.
    assert.deepEqual(resource.authorization_servers, [
      "https://caelogram.test",
    ]);
    // RFC 8414: the bundled worker really does serve the document an MCP client
    // reads next, with every endpoint it needs to reach.
    const server = await mf.dispatchFetch(
      "https://caelogram.test/.well-known/oauth-authorization-server",
    );
    assert.equal(server.status, 200);
    const as = (await server.json()) as any;
    assert.deepEqual(
      {
        authorization_endpoint: as.authorization_endpoint,
        token_endpoint: as.token_endpoint,
        registration_endpoint: as.registration_endpoint,
        revocation_endpoint: as.revocation_endpoint,
        device_authorization_endpoint: as.device_authorization_endpoint,
        code_challenge_methods_supported: as.code_challenge_methods_supported,
      },
      {
        authorization_endpoint: "https://caelogram.test/authorize",
        token_endpoint: "https://caelogram.test/token",
        registration_endpoint: "https://caelogram.test/register",
        revocation_endpoint: "https://caelogram.test/revoke",
        device_authorization_endpoint:
          "https://caelogram.test/device_authorization",
        code_challenge_methods_supported: ["S256"],
      },
    );
    assert(
      as.grant_types_supported.includes(
        "urn:ietf:params:oauth:grant-type:device_code",
      ),
    );
    // Registration is reachable in the deployed bundle; without the D1 schema
    // applied it fails loudly rather than silently accepting a client.
    const registration = await mf.dispatchFetch(
      "https://caelogram.test/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://client.test/cb"] }),
      },
    );
    assert.equal(registration.status, 500);
  } finally {
    await mf.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
