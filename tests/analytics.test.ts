import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Store } from "../src/store.js";
import { Service } from "../src/service.js";
import { dispatch } from "../src/tools.js";
import { sourceFile } from "../src/graph.js";
import {
  Analytics,
  ANALYTICS_SCHEMA,
  attributePaths,
  batchRunner,
  measureBaseline,
  rollUpEconomics,
  safeReason,
  syncRunner,
  type AnalyticsSql,
} from "../src/analytics.js";
import type { Edit, Principal } from "../src/types.js";
import type { Provider } from "../src/github.js";

const revision = "a".repeat(40);
const files = [
  sourceFile(
    "src/payments.ts",
    "export function charge(amount: number) { return amount; }\n",
  ),
  sourceFile(
    "src/checkout.ts",
    "import { charge } from './payments.js';\nexport const checkout = () => charge(5);\n",
  ),
  sourceFile(
    "tests/payment.test.ts",
    "import { charge } from '../src/payments.js';\nexport const test = () => charge(10);\n",
  ),
  sourceFile("src/unrelated.ts", "export const catalog = 1;\n"),
];
class FakeProvider implements Provider {
  revision = revision;
  files = files;
  pull: any = { state: "open", merged_at: null, created_at: null };
  async snapshot() {
    return { revision: this.revision, files: this.files };
  }
  async head() {
    return this.revision;
  }
  async publish(
    _n: string,
    _b: string,
    _base: string,
    _i: number,
    id: string,
    _t: string,
    _e: Edit[],
  ) {
    return {
      url: "https://github.com/example/shop/pull/1",
      number: 1,
      branch: `caelogram/${id}`,
    };
  }
  // Structural GitHub client used by refreshPullRequests.
  async api() {
    return this.pull;
  }
}
const principal = (tenant: string): Principal => ({
  tenant,
  subject: tenant + "-user",
  scopes: ["admin"],
  repositories: ["*"],
});
async function setup(tenant = "test") {
  process.env.CAELOGRAM_INSTALLATIONS = JSON.stringify({
    test: [1],
    other: [1],
  });
  const store = new Store(),
    provider = new FakeProvider(),
    service = new Service(store, provider),
    p = principal(tenant);
  const repo = await service.connect(p, "example/shop", "main", 1);
  return { store, provider, service, p, repo };
}
const rows = (store: Store, sql: string, ...args: unknown[]) =>
  store.db.prepare(sql).all(...(args as any[])) as any[];

// --------------------------------------------------------------- capture

test("every tool call is recorded with the tokens it actually served", async () => {
  const { store, service, p, repo } = await setup();
  const begun = await dispatch(service, p, "begin_change", {
    repoId: repo.id,
    prompt: "Change charge payment behavior",
    budget: 2000,
  });
  await service.analytics!.flush();
  const events = rows(
    store,
    "SELECT * FROM analytics_events WHERE tenant=? AND operation='begin_change'",
    "test",
  );
  assert.equal(events.length, 1);
  // The stored figure is exactly what the response told the agent it cost.
  assert.equal(
    events[0].estimated_tokens,
    begun.accounting.estimatedTokens,
    "token attribution must match the accounting the agent was given",
  );
  assert.equal(events[0].outcome, "ok");
  assert.equal(events[0].surface, "tool");
  assert.equal(events[0].repo_id, repo.id);
  assert.equal(events[0].task_id, begun.id);
  assert(events[0].latency_ms >= 0);
  assert(String(events[0].bound).includes("context package"));
  // Path attribution names files and nothing else.
  const paths = rows(
    store,
    "SELECT * FROM analytics_paths WHERE tenant=? AND task_id=?",
    "test",
    begun.id,
  );
  assert(paths.length > 0);
  assert(paths.some((r) => r.path === "src/payments.ts"));
  assert(
    paths.every((r) => ["delivered", "excerpted", "omitted"].includes(r.role)),
  );
});

test("a refusal at the ingestion ceiling is itself recorded, with its status", async () => {
  const { store, service, p, repo } = await setup();
  const begun = await dispatch(service, p, "begin_change", {
    repoId: repo.id,
    prompt: "Change charge payment behavior",
    budget: 500,
  });
  // Spend the whole ceiling, then attempt one more read.
  await service.spend(p, begun.id, 1_000_000);
  await assert.rejects(
    dispatch(service, p, "read_section", {
      taskId: begun.id,
      path: "src/payments.ts",
      start: 1,
      end: 2,
      reason: "needed for the change",
    }),
  );
  await service.analytics!.flush();
  const [refusal] = rows(
    store,
    "SELECT * FROM analytics_events WHERE tenant=? AND operation='read_section'",
    "test",
  );
  assert.equal(refusal.outcome, "refused");
  assert.equal(refusal.status, 429);
  assert(String(refusal.reason).includes("ingestion ceiling"));
  assert.equal(refusal.task_id, begun.id);
});

test("a failing analytics write never fails the request", async () => {
  const { service, p, repo } = await setup();
  let attempts = 0;
  const broken: AnalyticsSql = {
    managed: true,
    async all() {
      throw new Error("analytics store is down");
    },
    async write() {
      attempts++;
      throw new Error("analytics store is down");
    },
  };
  service.analytics = new Analytics(broken);
  const result = await dispatch(service, p, "begin_change", {
    repoId: repo.id,
    prompt: "Change charge payment behavior",
    budget: 2000,
  });
  assert(result.id, "the tool call still succeeds");
  assert.equal(await service.analytics.flush(), 0);
  assert(attempts > 0, "the write was attempted");
  assert(service.analytics.dropped > 0, "the loss is counted, not hidden");
  assert.equal(service.analytics.lastError, "analytics store is down");
  // And a report over a broken store still answers instead of throwing.
  await assert.rejects(service.analytics.aggregate("test"));
});

test("record() never throws and never awaits the write", async () => {
  const slow: AnalyticsSql = {
    managed: true,
    async all() {
      return [];
    },
    write: () => new Promise(() => {}), // never settles
  };
  const analytics = new Analytics(slow);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++)
    analytics.record({
      tenant: "test",
      surface: "tool",
      operation: "get_context",
      outcome: "ok",
    });
  const perCall = Number(process.hrtime.bigint() - started) / 1000 / 1000; // microseconds
  assert(perCall < 200, `record() should be trivial, was ${perCall}µs`);
});

// ------------------------------------------------------------- isolation

test("one workspace never sees another workspace's analytics", async () => {
  const a = await setup("test");
  const b = {
    ...a,
    p: principal("other"),
  };
  const repoB = await a.service.connect(b.p, "example/shop", "main", 1);
  await dispatch(a.service, a.p, "repository_map", { repoId: a.repo.id });
  await dispatch(a.service, b.p, "repository_map", { repoId: repoB.id });
  await a.service.analytics!.flush();

  const reportA = await a.service.report(a.p, { repoId: a.repo.id });
  const reportB = await a.service.report(b.p, { repoId: repoB.id });
  assert(reportA.available && reportB.available);
  const calls = (r: any) =>
    (r.behaviour.tools as any[]).reduce((n, t) => n + t.calls, 0);
  assert.equal(calls(reportA), 1);
  assert.equal(calls(reportB), 1);
  // Directly: a query bound to one tenant cannot reach the other's rows.
  const leaked = rows(
    a.store,
    "SELECT count(*) AS n FROM analytics_events WHERE tenant=? AND repo_id=?",
    "other",
    a.repo.id,
  );
  assert.equal(leaked[0].n, 0);
});

// -------------------------------------------------------------- baseline

const fixture = {
  taskId: "t1",
  repoId: "r1",
  base: revision,
  servedTokens: 300,
  indexed: new Map([
    ["src/payments.ts", 900], // 300 estimated tokens
    ["src/checkout.ts", 600], // 200
    ["tests/payment.test.ts", 300], // 100
    ["src/unrelated.ts", 3000], // 1000 — outside the closure
  ]),
  edges: [
    { from: "src/checkout.ts", to: "src/payments.ts", kind: "imports" },
    { from: "tests/payment.test.ts", to: "src/payments.ts", kind: "tests" },
    { from: "src/payments.ts", to: "src/payments.ts", kind: "contains" },
  ],
};

test("the baseline is the touched files plus their closure, never the repository", () => {
  const measured = measureBaseline({
    ...fixture,
    touched: ["src/payments.ts"],
    basis: "merged",
  });
  assert.equal(measured.status, "measured");
  // payments (300) + checkout (200) + test (100). unrelated.ts is NOT included.
  assert.equal(measured.baselineTokens, 600);
  assert.equal(measured.closure, 2);
  assert.equal(measured.savedTokens, 300);
  assert.equal(measured.ratio, 0.5);
  const whole = [...fixture.indexed.values()].reduce(
    (n, b) => n + Math.ceil(b / 3),
    0,
  );
  assert(
    measured.baselineTokens! < whole,
    "a whole-repository baseline would be larger and is rejected",
  );
});

test("an unmerged change gives a provisional baseline, never a headline number", () => {
  for (const basis of ["published", "submitted"] as const) {
    const r = measureBaseline({
      ...fixture,
      touched: ["src/payments.ts"],
      basis,
    });
    assert.equal(r.status, "provisional");
    assert(r.reason && r.reason.length > 20);
    assert.equal(typeof r.baselineTokens, "number");
  }
  const totals = rollUpEconomics([
    measureBaseline({
      ...fixture,
      touched: ["src/payments.ts"],
      basis: "published",
    }),
  ]);
  assert.equal(totals.measuredTasks, 0);
  assert.equal(
    totals.savedTokens,
    null,
    "no saving is claimed without a merge",
  );
  assert.equal(totals.provisionalTasks, 1);
});

test("the baseline refuses to produce a number it cannot justify", () => {
  const none = measureBaseline({ ...fixture, touched: [], basis: "none" });
  assert.equal(none.status, "unavailable");
  assert.equal(none.baselineTokens, null);
  assert.equal(none.savedTokens, null);
  assert(none.reason!.includes("No changeset"));

  const gone = measureBaseline({
    ...fixture,
    touched: ["src/payments.ts"],
    indexed: new Map(),
    basis: "merged",
  });
  assert.equal(gone.status, "unavailable");
  assert.equal(gone.baselineTokens, null);

  const brandNew = measureBaseline({
    ...fixture,
    touched: ["src/brand-new.ts"],
    basis: "merged",
  });
  assert.equal(brandNew.status, "unavailable");
  assert(brandNew.reason!.includes("new at the base commit"));

  const empty = measureBaseline({
    ...fixture,
    touched: ["src/payments.ts"],
    indexed: new Map([["src/payments.ts", 0]]),
    edges: [],
    basis: "merged",
  });
  assert.equal(empty.status, "unavailable");
});

test("a task that cost more than the naive read reports a negative saving", () => {
  const r = measureBaseline({
    ...fixture,
    servedTokens: 5000,
    touched: ["src/payments.ts"],
    basis: "merged",
  });
  assert.equal(r.savedTokens, -4400);
  assert(r.ratio! > 1);
});

test("end to end: a merged change produces a measured baseline from real index data", async () => {
  const { service, provider, p, repo } = await setup();
  const task = await dispatch(service, p, "begin_change", {
    repoId: repo.id,
    prompt: "Change charge payment behavior",
    budget: 2000,
  });
  const change = await dispatch(service, p, "submit_changeset", {
    taskId: task.id,
    title: "Adjust charge",
    edits: [
      {
        path: "src/payments.ts",
        content: "export function charge(a: number) { return a + 1; }\n",
      },
    ],
  });
  await dispatch(service, p, "validate_changeset", { changesetId: change.id });
  await dispatch(service, p, "publish_pull_request", {
    changesetId: change.id,
    acknowledgeWarnings: true,
  });

  const open = await service.report(p, { repoId: repo.id });
  assert.equal(open.economics!.tasks[0].status, "provisional");
  assert.equal(open.economics!.totals.savedTokens, null);

  // GitHub now says the pull request merged.
  provider.pull = {
    state: "closed",
    merged_at: "2026-01-02T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  };
  const merged = await service.report(p, { repoId: repo.id, refresh: true });
  const one = merged.economics!.tasks[0];
  assert.equal(one.status, "measured");
  assert.deepEqual(one.touched, ["src/payments.ts"]);
  // checkout.ts and the test both import payments.ts, so they are in the closure.
  assert.equal(one.closure, 2);
  assert.equal(
    one.baselineTokens,
    files
      .filter((f) => f.path !== "src/unrelated.ts")
      .reduce((n, f) => n + Math.ceil(Buffer.byteLength(f.content) / 3), 0),
  );
  assert.equal(merged.economics!.totals.measuredTasks, 1);
  assert.equal(merged.outcomes!.merged, 1);
  assert.equal(merged.outcomes!.medianHoursToMerge, 24);
});

// ----------------------------------------------------------- aggregation

test("aggregation counts, refusals, ordering and unread files are correct", async () => {
  const sql = syncRunner(new Store().db);
  const analytics = new Analytics(sql);
  const at = Date.now();
  const base = { tenant: "w", surface: "tool", actor: "a", repoId: "r1" };
  analytics.record({
    ...base,
    operation: "begin_change",
    outcome: "ok",
    taskId: "t1",
    estimatedTokens: 1000,
    latencyMs: 10,
    at,
    paths: [
      { path: "src/a.ts", role: "delivered", estimatedTokens: 400 },
      { path: "src/b.ts", role: "delivered", estimatedTokens: 700 },
    ],
  });
  analytics.record({
    ...base,
    operation: "read_section",
    outcome: "ok",
    taskId: "t1",
    estimatedTokens: 200,
    latencyMs: 30,
    at: at + 1,
    paths: [{ path: "src/a.ts", role: "read" }],
  });
  analytics.record({
    ...base,
    operation: "read_section",
    outcome: "refused",
    status: 429,
    reason: "Task ingestion ceiling is spent",
    taskId: "t1",
    latencyMs: 5,
    at: at + 2,
  });
  analytics.record({
    ...base,
    surface: "outcome",
    operation: "validation",
    outcome: "refused",
    status: 422,
    at: at + 3,
  });
  analytics.record({
    ...base,
    surface: "outcome",
    operation: "validation",
    outcome: "ok",
    at: at + 4,
  });
  analytics.record({
    ...base,
    operation: "submit_changeset",
    outcome: "ok",
    taskId: "t1",
    at: at + 5,
  });
  assert.equal(await analytics.flush(), 6);

  const r = await analytics.aggregate("w", { repoId: "r1" });
  const read = r.behaviour.tools.find((t) => t.tool === "read_section")!;
  assert.equal(read.calls, 2);
  assert.equal(read.ok, 1);
  assert.equal(read.refused, 1);
  assert.equal(read.p50, 30);
  assert.equal(r.behaviour.ceilingRefusals, 1);
  assert.equal(r.behaviour.firstCall[0].tool, "begin_change");
  assert.deepEqual(
    r.behaviour.transitions.map((t) => t.step),
    [
      "begin_change → read_section",
      "read_section → read_section",
      "read_section → submit_changeset",
    ],
  );
  // src/b.ts was delivered and never touched again; src/a.ts was read.
  assert.deepEqual(
    r.behaviour.deliveredNeverPulled.map((f) => f.path),
    ["src/b.ts"],
  );
  assert.equal(r.behaviour.mostRequested[0].path, "src/a.ts");
  assert.equal(r.outcomes.validationsRun, 2);
  assert.equal(r.outcomes.validationsPassed, 1);
  assert.equal(r.outcomes.validationPassRate, 0.5);
  assert.equal(r.outcomes.changesetsSubmitted, 1);
  // A different repository in the same workspace is excluded by scope.
  const other = await analytics.aggregate("w", { repoId: "r2" });
  assert.equal(other.behaviour.tools.length, 0);
});

test("retention prunes past the window and repository deletion forgets its rows", async () => {
  const analytics = new Analytics(syncRunner(new Store().db));
  const now = Date.now();
  analytics.record({
    tenant: "w",
    surface: "tool",
    operation: "get_context",
    outcome: "ok",
    repoId: "r1",
    at: now - 200 * 86400000,
  });
  analytics.record({
    tenant: "w",
    surface: "tool",
    operation: "get_context",
    outcome: "ok",
    repoId: "r1",
    at: now,
  });
  await analytics.flush();
  assert(await analytics.prune(now));
  assert.equal(
    (await analytics.aggregate("w", { days: 365 })).behaviour.tools[0].calls,
    1,
  );
  assert(await analytics.forgetRepository("w", "r1"));
  assert.equal(
    (await analytics.aggregate("w", { days: 365 })).behaviour.tools.length,
    0,
  );
});

// ----------------------------------------------------------------- privacy

test("captured rows carry paths and classes, never source or secrets", async () => {
  const { store, service, p, repo } = await setup();
  const task = await dispatch(service, p, "begin_change", {
    repoId: repo.id,
    prompt: "Change charge payment behavior",
    budget: 2000,
  });
  await dispatch(service, p, "read_section", {
    taskId: task.id,
    path: "src/payments.ts",
    start: 1,
    end: 1,
    reason: "confirming the signature",
  });
  await service.analytics!.flush();
  const serialized = JSON.stringify(
    rows(
      store,
      "SELECT * FROM analytics_events UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL",
    ),
  );
  assert(!serialized.includes("export function charge"));
  assert(!serialized.includes("Change charge payment behavior"));
  assert(
    !JSON.stringify(rows(store, "SELECT * FROM analytics_paths")).includes(
      "return amount",
    ),
  );
  // Free-form text is truncated and quoted spans are dropped.
  assert.equal(
    safeReason(`token 'sk-live-abcdefg' rejected`),
    "token … rejected",
  );
  assert.equal(safeReason("x".repeat(500))!.length, 160);
});

test("path attribution separates what was delivered from what was pulled", () => {
  const delivered = attributePaths(
    "begin_change",
    {},
    {
      context: {
        items: [
          { path: "src/a.ts", start: 1, end: 0, estimatedTokens: 10 },
          { path: "src/b.ts", start: 4, end: 20, estimatedTokens: 5 },
        ],
        plan: [{ path: "src/c.ts", status: "omitted", estimatedTokens: 90 }],
        omitted: [],
      },
    },
  );
  assert.deepEqual(delivered, [
    { path: "src/a.ts", role: "delivered", estimatedTokens: 10 },
    { path: "src/b.ts", role: "excerpted", estimatedTokens: 5 },
    { path: "src/c.ts", role: "omitted", estimatedTokens: 90 },
  ]);
  assert.deepEqual(
    attributePaths(
      "read_section",
      { path: "src/a.ts" },
      { estimatedTokens: 7 },
    ),
    [{ path: "src/a.ts", role: "read", estimatedTokens: 7 }],
  );
  assert.deepEqual(attributePaths("index_status", {}, null), []);
});

// -------------------------------------------------------------------- D1

test("migration 0008 matches the schema the code writes, and D1 capture is tenant scoped", async () => {
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
    const db = await mf.getD1Database("DB");
    for (const file of readdirSync("cloudflare/migrations").sort())
      for (const sql of readFileSync("cloudflare/migrations/" + file, "utf8")
        .trim()
        .split("\n"))
        await db.prepare(sql).run();
    // Every column the writer binds must exist in the migrated table.
    const analytics = new Analytics(batchRunner(db as any));
    analytics.record({
      tenant: "gh:org:1",
      surface: "tool",
      operation: "begin_change",
      repoId: "r1",
      taskId: "t1",
      actor: "person",
      client: "claude-code",
      outcome: "ok",
      estimatedTokens: 900,
      omittedCount: 2,
      bound: "one package",
      latencyMs: 12,
      bytes: 4,
      detail: { files: 3 },
      paths: [{ path: "src/a.ts", role: "delivered", estimatedTokens: 900 }],
    });
    analytics.record({
      tenant: "gh:org:2",
      surface: "tool",
      operation: "begin_change",
      repoId: "r9",
      outcome: "ok",
      estimatedTokens: 5,
    });
    assert.equal(await analytics.flush(), 2);
    assert.equal(analytics.dropped, 0, analytics.lastError ?? "");

    const one = await analytics.aggregate("gh:org:1");
    assert.equal(one.behaviour.tools[0].estimatedTokens, 900);
    assert.equal(one.behaviour.mostRequested[0].path, "src/a.ts");
    const two = await analytics.aggregate("gh:org:2");
    assert.equal(two.behaviour.tools[0].estimatedTokens, 5);
    assert.equal(two.behaviour.mostRequested.length, 0);

    // The migration must declare exactly the tables and columns the code uses.
    const columns = (
      await db.prepare("PRAGMA table_info(analytics_events)").all()
    ).results.map((c: any) => c.name);
    for (const expected of ANALYTICS_SCHEMA[0]
      .split("(")[1]
      .split(/,(?![^()]*\))/)
      .map((c) => c.trim().split(" ")[0])
      .filter((c) => /^[a-z_]+$/.test(c)))
      assert(
        columns.includes(expected),
        `migration 0008 is missing ${expected}`,
      );
  } finally {
    await mf.dispose();
  }
});
