import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { BatchedService, advanceIndex } from "../cloudflare/batched.js";
import { GitHub } from "../src/github.js";
import { tokens, BRIEF_BUDGET } from "../src/graph.js";
import type { Env } from "../cloudflare/worker.js";

// The hosted index answers the brief from aggregate D1 queries, never from a
// serialized graph, so this checks the counts against the indexed rows.
test("hosted repository brief is bounded and built from indexed rows", async (t) => {
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
    const DB = await mf.getD1Database("DB"),
      SOURCE = await mf.getR2Bucket("SOURCE");
    for (const file of readdirSync("cloudflare/migrations").sort())
      for (const sql of readFileSync("cloudflare/migrations/" + file, "utf8")
        .trim()
        .split("\n"))
        await DB.prepare(sql).run();
    const env = {
      DB,
      SOURCE,
      DATA_KEY: "a".repeat(64),
      INSTALLATIONS: '{"test":[1]}',
    } as unknown as Env;
    const p = {
      tenant: "test",
      subject: "tester",
      scopes: ["admin"],
      repositories: ["owner/repo"],
    };
    const contents: Record<string, string> = {
      "src/core/hub.ts": "export function hub(n: number) {\n  return n;\n}\n",
      "src/api/charge.ts":
        "import { hub } from '../core/hub.js';\nexport const charge = (n: number) => hub(n);\n",
      "src/api/refund.ts":
        "import { hub } from '../core/hub.js';\nexport const refund = (n: number) => hub(-n);\n",
      "README.md": "# Sample\n",
    };
    const paths = Object.keys(contents);
    t.mock.method(
      GitHub.prototype,
      "api",
      async (_name: string, _inst: number, route: string) => {
        if (route.startsWith("/git/ref/"))
          return { object: { sha: "b".repeat(40) } };
        if (route.startsWith("/git/commits/")) return { tree: { sha: "tree" } };
        if (route.startsWith("/git/trees/"))
          return {
            tree: paths.map((path) => ({
              path,
              type: "blob",
              mode: "100644",
              sha: path,
              size: Buffer.byteLength(contents[path]),
            })),
          };
        if (route.startsWith("/git/blobs/"))
          return {
            encoding: "base64",
            content: Buffer.from(
              contents[route.slice("/git/blobs/".length)],
            ).toString("base64"),
          };
        throw new Error("Unexpected route");
      },
    );
    const s = new BatchedService(env);
    const start = await s.connect(p, "owner/repo", "main", 1);
    const job = (await s.record(p, start.id)).latest_job!;
    for (
      let n = 0;
      n < 100 && (await s.job(p.tenant, job)).phase !== "ready";
      n++
    )
      await advanceIndex(env, p.tenant, job);
    const brief = await s.brief(p, start.id);
    assert(tokens(JSON.stringify(brief)) <= BRIEF_BUDGET);
    assert.equal((brief as any).nodes, undefined);
    assert.equal(brief.files, 4);
    assert.equal(brief.hubs[0].path, "src/core/hub.ts");
    assert.equal(brief.hubs[0].dependents, 2);
    assert.deepEqual(brief.subsystems.map((x) => x.path).sort(), [
      ".",
      "src/api",
      "src/core",
    ]);
    assert(brief.entrypoints.some((e) => e.path === "src/api/charge.ts"));
    assert(
      brief.truncated.some((x) => x.what.includes("symbol")),
      "hosted brief must say per-directory symbol counts are unavailable",
    );
    await assert.rejects(
      () => s.brief({ ...p, tenant: "other" }, start.id),
      /not found/,
    );
    // Paging still reports relationships that leave the page.
    const page: any = await s.mapPage(p, start.id, "", "src/api");
    assert.equal(page.visibleFiles, 2);
    assert.equal(page.boundaryEdgeCount, 2);
    assert(
      page.boundaryEdges.every((e: any) => e.offPage === "src/core/hub.ts"),
    );
  } finally {
    await mf.dispose();
  }
});
