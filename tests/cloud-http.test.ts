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
    assert.equal(
      ((await metadata.json()) as any).resource,
      "https://caelogram.test",
    );
  } finally {
    await mf.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
