import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
test("bundled workerd runtime completes 24 MB as independently checkpointed requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "caelogram-batch-test-"));
  let mf: Miniflare | undefined;
  try {
    buildSync({
      entryPoints: [resolve("tests/fixtures/batched-worker.ts")],
      outfile: join(directory, "batched-worker.js"),
      bundle: true,
      format: "esm",
      platform: "node",
      banner: {
        js: 'import {createRequire} from "node:module"; const require=createRequire("/worker.js");',
      },
      define: { __filename: '"/worker.js"', __dirname: '"/"' },
    });
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: readFileSync(join(directory, "batched-worker.js"), "utf8"),
        compatibilityDate: "2026-09-01",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          DATA_KEY: "a".repeat(64),
          INSTALLATIONS: '{"memory-test":[1]}',
        },
        d1Databases: ["DB"],
        r2Buckets: ["SOURCE"],
      }),
    );
    const db = await mf.getD1Database("DB");
    for (const file of readdirSync("cloudflare/migrations").sort())
      for (const sql of readFileSync("cloudflare/migrations/" + file, "utf8")
        .trim()
        .split("\n"))
        await db.prepare(sql).run();
    const start = (await (
      await mf.dispatchFetch("https://test/start")
    ).json()) as any;
    let status = start;
    for (let n = 0; n < 60 && status.status !== "ready"; n++) {
      const response = await mf.dispatchFetch(
        "https://test/step?id=" + start.id,
      );
      assert.equal(response.status, 200, await response.clone().text());
      status = await response.json();
    }
    assert.equal(status.status, "ready");
    assert.equal(status.sourceBytes, 24000000);
    assert.equal(status.processed, 100);
    const map = (await (
      await mf.dispatchFetch("https://test/map?id=" + start.id)
    ).json()) as any;
    assert.equal(map.files, 100);
    assert.equal(map.visibleFiles, 50);
    const oversized = (await (
      await mf.dispatchFetch("https://test/oversized")
    ).json()) as any;
    const rejected = await mf.dispatchFetch(
      "https://test/step?id=" + oversized.id,
    );
    assert.equal(rejected.status, 413);
    assert.match(await rejected.text(), /2 GB/);
    const failed = (await (
      await mf.dispatchFetch("https://test/status?id=" + oversized.id)
    ).json()) as any;
    assert.equal(failed.status, "failed");
    assert.equal(failed.processed, 0);
  } finally {
    await mf?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
