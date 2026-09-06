import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { CloudStore } from "../cloudflare/store.js";
import { Service } from "../src/service.js";
import { dispatch } from "../src/tools.js";
import { sourceFile } from "../src/graph.js";
import type { Provider } from "../src/github.js";
const p = {
  tenant: "team-a",
  subject: "test",
  scopes: ["admin"],
  repositories: ["shop/existing"],
};
test("D1/R2: encrypted existing repository → bounded context → validated draft PR, isolation and durable locks", async () => {
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
    for (const statement of readFileSync(
      "cloudflare/migrations/0001_initial.sql",
      "utf8",
    )
      .trim()
      .split("\n"))
      await db.prepare(statement).run();
    const store = new CloudStore(db as any, bucket as any, "a".repeat(64));
    let publications = 0,
      revision = "a".repeat(40);
    const provider: Provider = {
      async snapshot() {
        return {
          revision,
          files: [
            sourceFile(
              "src/payment.ts",
              "export function charge(amount: number) { return amount; }",
            ),
            sourceFile(
              "src/checkout.ts",
              "import {charge} from './payment.js'; export const checkout = () => charge(10);",
            ),
          ],
        };
      },
      async head() {
        return revision;
      },
      async publish(_name, _branch, base) {
        assert.equal(base, revision);
        publications++;
        return {
          url: "https://github.com/shop/existing/pull/1",
          number: 1,
          branch: "caelogram/test",
        };
      },
    };
    const s = new Service(store, provider, { "team-a": [1] });
    const repo: any = await dispatch(s, p, "connect_repository", {
      name: "shop/existing",
      branch: "main",
      installationId: 1,
    });
    assert.equal(repo.files, 2);
    const task: any = await dispatch(s, p, "begin_change", {
      repoId: repo.id,
      prompt: "charge payment",
      budget: 2000,
    });
    assert(task.context.estimatedTokens <= 2000);
    const change: any = await dispatch(s, p, "submit_changeset", {
      taskId: task.id,
      title: "Handle zero amounts",
      edits: [
        {
          path: "src/payment.ts",
          content:
            "export function charge(amount: number) { return Math.max(0, amount); }",
        },
      ],
    });
    await assert.rejects(
      () =>
        dispatch(s, p, "publish_pull_request", {
          changesetId: change.id,
          acknowledgeWarnings: true,
        }),
      /Validate/,
    );
    const validated: any = await dispatch(s, p, "validate_changeset", {
      changesetId: change.id,
    });
    assert(validated.validation.passed);
    await dispatch(s, p, "publish_pull_request", {
      changesetId: change.id,
      acknowledgeWarnings: true,
    });
    await dispatch(s, p, "publish_pull_request", {
      changesetId: change.id,
      acknowledgeWarnings: true,
    });
    assert.equal(publications, 1);
    await assert.rejects(
      () => s.repo({ ...p, tenant: "team-b" }, repo.id),
      /not found/,
    );
    const rows = await db
      .prepare("SELECT object_key FROM objects")
      .all<{ object_key: string }>();
    for (const row of rows.results) {
      const raw = await (await bucket.get(row.object_key))!.text();
      assert(!raw.includes("function charge"));
    }
    await store.exclusive(p.tenant, async () => {
      const second = new CloudStore(db as any, bucket as any, "a".repeat(64));
      await assert.rejects(
        () => second.exclusive(p.tenant, async () => true),
        /in progress/,
      );
    });
    // Ciphertext cannot be relabeled to another tenant, even with an attacker controlling a pointer.
    const row = await db
      .prepare("SELECT object_key FROM objects WHERE kind='repo'")
      .first<{ object_key: string }>();
    await db
      .prepare("INSERT INTO objects VALUES(?,?,?,?)")
      .bind("team-b", "repo", repo.id, row!.object_key)
      .run();
    await assert.rejects(() => store.get("team-b", "repo", repo.id));
    await db.prepare("DELETE FROM objects WHERE tenant='team-b'").run();
    await assert.rejects(
      () => db.prepare("DELETE FROM audit").run(),
      /append only/,
    );
    await store.exclusive(p.tenant, () => s.remove(p, repo.id));
    await assert.rejects(() => s.task(p, task.id), /not found/);
    await store.collectOffline();
    assert.equal((await bucket.list()).objects.length, 0);
    assert((await store.events(p.tenant)).length > 0);
  } finally {
    await mf.dispose();
  }
});
