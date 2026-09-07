import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  BatchedService,
  advanceIndex,
  MAX_SOURCE_BYTES,
} from "../cloudflare/batched.js";
import { GitHub } from "../src/github.js";
import type { Env } from "../cloudflare/worker.js";

test("24 MB repository: durable progress, file shards, paging, context, retry, revision isolation and incremental reuse", async (t) => {
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
    let rev = "a".repeat(40),
      reads = 0,
      failOnce = true,
      hijack = true;
    const contents = (path: string) =>
      path === "charge.ts"
        ? "export function charge(n:number){ return n; }"
        : path === "consumer.ts"
          ? "import {charge} from './charge.js'; export const buy=()=>charge(1);"
          : path + "\n" + "documentation ".repeat(17000);
    const paths = [
      "charge.ts",
      "consumer.ts",
      ...Array.from({ length: 100 }, (_, i) => `docs-${i}.md`),
    ];
    t.mock.method(
      GitHub.prototype,
      "api",
      async (_name: string, _inst: number, route: string) => {
        if (route.startsWith("/git/ref/")) return { object: { sha: rev } };
        if (route.startsWith("/git/commits/")) return { tree: { sha: "tree" } };
        if (route.startsWith("/git/trees/"))
          return {
            tree: paths.map((path) => ({
              path,
              type: "blob",
              mode: "100644",
              sha: path,
              size: Buffer.byteLength(contents(path)),
            })),
          };
        if (route.startsWith("/git/blobs/")) {
          if (failOnce) {
            failOnce = false;
            throw new Error("temporary transport failure");
          }
          if (hijack) {
            hijack = false;
            await DB.prepare(
              "UPDATE index_jobs SET owner='replacement',lease=? WHERE tenant='test'",
            )
              .bind(Date.now() + 120000)
              .run();
          }
          reads++;
          return {
            encoding: "base64",
            content: Buffer.from(
              contents(route.slice("/git/blobs/".length)),
            ).toString("base64"),
          };
        }
        throw new Error("Unexpected route");
      },
    );
    const s = new BatchedService(env);
    const start = await s.connect(p, "owner/repo", "main", 1);
    assert.equal(start.status, "discovering");
    assert.equal(reads, 0);
    let job = (await s.record(p, start.id)).latest_job!;
    await assert.rejects(
      () => advanceIndex(env, p.tenant, job),
      /temporary transport/,
    );
    assert.notEqual((await s.job(p.tenant, job)).phase, "failed");
    await advanceIndex(env, p.tenant, job);
    assert.equal(
      (await s.job(p.tenant, job)).done,
      0,
      "stale worker cannot checkpoint",
    );
    assert.equal(
      (await s.job(p.tenant, job)).owner,
      "replacement",
      "stale worker cannot release replacement lease",
    );
    await DB.prepare("UPDATE index_jobs SET lease=0 WHERE tenant=? AND id=?")
      .bind(p.tenant, job)
      .run();
    for (
      let n = 0;
      n < 100 && (await s.job(p.tenant, job)).phase !== "ready";
      n++
    )
      await advanceIndex(env, p.tenant, job);
    const status = await s.status(p, start.id);
    assert.equal(status.status, "ready");
    assert.equal(status.files, 102);
    assert.ok(status.sourceBytes > 23_500_000);
    const objects = await SOURCE.list();
    assert.ok(objects.objects.length >= 102);
    assert.ok(objects.objects.every((o) => o.size < 600000));
    const page = await s.mapPage(p, start.id);
    assert.equal(page.visibleFiles, 50);
    assert.ok(page.nextCursor);
    const other = await s.mapPage(p, start.id, page.nextCursor!);
    assert.notEqual(page.nodes[0].path, other.nodes[0].path);
    await assert.rejects(
      () => s.mapPage({ ...p, tenant: "other" }, start.id),
      /not found/,
    );
    const task = await s.begin(p, start.id, "charge", 2000);
    assert.ok(task.context.items.some((f) => f.path === "charge.ts"));
    assert.ok(
      (await s.graph(p, task)).edges.some(
        (e) => e.from === "consumer.ts" && e.to === "charge.ts",
      ),
    );
    const section = await s.read(
      p,
      task.id,
      "charge.ts",
      1,
      2,
      "Inspect charging implementation",
    );
    assert.match(section.content, /function charge/);
    const change = await s.submit(p, task.id, "remove charge", [
      { path: "charge.ts", content: null },
    ]);
    assert.equal((await s.validate(p, change.id)).validation?.passed, false);
    const valid = await s.submit(p, task.id, "Handle zero amounts", [
      {
        path: "charge.ts",
        content: "export function charge(n:number){ return Math.max(0,n); }",
      },
    ]);
    assert.equal((await s.validate(p, valid.id)).validation?.passed, true);
    s.provider.publish = async () => ({
      url: "https://example.invalid/draft/1",
      number: 1,
      branch: "caelogram/test",
    });
    assert.equal((await s.publish(p, valid.id, true)).status, "published");
    const before = reads;
    rev = "b".repeat(40);
    await s.connect(p, "owner/repo", "main", 1);
    assert.equal((await s.mapPage(p, start.id)).revision, task.base);
    job = (await s.record(p, start.id)).latest_job!;
    for (
      let n = 0;
      n < 100 && (await s.job(p.tenant, job)).phase !== "ready";
      n++
    )
      await advanceIndex(env, p.tenant, job);
    assert.equal(reads, before);
    assert.equal((await s.graph(p, task)).revision, task.base);
    assert.equal((await s.mapPage(p, start.id)).revision, rev);
    await s.remove(p, start.id);
    await assert.rejects(() => s.mapPage(p, start.id), /complete index/);
    for (const prior of (
      await DB.prepare("SELECT id FROM index_jobs WHERE tenant=?")
        .bind(p.tenant)
        .all<{ id: string }>()
    ).results)
      for (
        let n = 0;
        n < 100 && (await s.job(p.tenant, prior.id)).phase !== "deleted";
        n++
      )
        await advanceIndex(env, p.tenant, prior.id);
    assert.equal(
      (await DB.prepare("SELECT count(*) AS n FROM index_files WHERE tenant=?")
        .bind(p.tenant)
        .first<{ n: number }>())!.n,
      0,
    );
    assert.equal(MAX_SOURCE_BYTES, 2_000_000_000);
  } finally {
    await mf.dispose();
  }
});
