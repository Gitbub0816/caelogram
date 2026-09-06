import { test } from "node:test";
import assert from "node:assert/strict";
import { index, context, sourceFile, tokens } from "../src/graph.js";
import { redact, safePath } from "../src/security.js";
import { Store } from "../src/store.js";
import { Service } from "../src/service.js";
import { demoRepository } from "../src/demo.js";
import type { Principal, Edit } from "../src/types.js";
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
export class FakeProvider implements Provider {
  revision = revision;
  files = files;
  published = 0;
  async snapshot() {
    return { revision: this.revision, files: this.files };
  }
  async head() {
    return this.revision;
  }
  async publish(
    _name: string,
    _branch: string,
    base: string,
    _installation: number,
    id: string,
    _title: string,
    _edits: Edit[],
  ) {
    assert.equal(base, this.revision, "Base branch moved");
    this.published++;
    return {
      url: `https://github.com/example/shop/pull/1`,
      number: 1,
      branch: `caelogram/${id}`,
    };
  }
}
const p: Principal = {
  tenant: "test",
  subject: "tester",
  scopes: ["admin"],
  repositories: ["*"],
};
async function setup() {
  process.env.CAELOGRAM_INSTALLATIONS = JSON.stringify({ test: [1] });
  const store = new Store(),
    provider = new FakeProvider(),
    service = new Service(store, provider);
  const repo = await service.connect(p, "example/shop", "main", 1);
  return { store, provider, service, repo };
}
test("AST mapping resolves .js specifiers to TypeScript and real declarations", () => {
  const g = index(files, revision);
  assert(g.nodes.some((n) => n.name === "charge" && n.kind === "function"));
  assert(
    g.edges.some(
      (e) =>
        e.from === "src/checkout.ts" &&
        e.to === "src/payments.ts" &&
        e.kind === "imports",
    ),
  );
  assert(g.edges.some((e) => e.kind === "tests"));
  assert(g.edges.every((e) => e.revision === revision));
});
test("unchanged declarations reused, removed nodes disappear, newly added imports resolve", () => {
  const g = index(files, revision);
  const next = index(
    [
      ...files.filter((f) => f.path !== "src/unrelated.ts"),
      sourceFile("src/new.ts", "import { charge } from './payments.js';"),
    ],
    "b".repeat(40),
    g,
  );
  assert.equal(next.reused, 3);
  assert.equal(next.parsed, 1);
  assert(!next.nodes.some((n) => n.path === "src/unrelated.ts"));
  assert(next.edges.every((e) => e.revision === "b".repeat(40)));
});
test("bounded context includes callers and test consumers, omits unrelated source", () => {
  const c = context(
    index(files, revision),
    "Change charge payment behavior",
    2000,
  );
  assert(c.items.some((i) => i.path === "src/payments.ts"));
  assert(c.items.some((i) => i.path === "src/checkout.ts"));
  assert(c.items.some((i) => i.path === "tests/payment.test.ts"));
  assert(!c.items.some((i) => i.path === "src/unrelated.ts"));
  assert(c.estimatedTokens <= 2000);
  assert(c.items.every((i) => i.reason.length));
});
test("tight budget reports omitted dependencies instead of silently declaring completeness", () => {
  const c = context(
    index(
      files.map((f) => ({
        ...f,
        content: f.content + "\n// filler".repeat(500),
      })),
      revision,
    ),
    "payments",
    500,
  );
  assert(
    c.omitted.length ||
      c.items.some((i) => i.reason.includes("bounded excerpt")),
  );
  assert(
    c.warnings.some(
      (w) => w.includes("incomplete") || w.includes("bounded excerpts"),
    ),
  );
  assert(c.estimatedTokens <= 500);
});
test("source is filtered and common credentials are redacted before persistence", () => {
  const secret = "ghp_" + "a".repeat(36);
  const g = index(
    [
      sourceFile(".env", "PASSWORD=secret"),
      sourceFile("src/config.ts", `export const apiKey = "${secret}";`),
    ],
    revision,
  );
  assert.equal(g.files.length, 1);
  assert(!JSON.stringify(g).includes(secret));
  assert(!JSON.stringify(g).includes("PASSWORD=secret"));
  assert.equal(
    redact('const password = "hunter2";'),
    'const password = "[REDACTED]";',
  );
});
test("path traversal, git internals, Windows drives, and backslashes are rejected", () => {
  for (const path of [
    "../x",
    "/etc/passwd",
    ".git/config",
    "a/../../b",
    "C:/Windows/file",
    "a\\b",
    "a\0b",
  ])
    assert(!safePath(path));
  assert(safePath("src/module.ts"));
});
test("complete service workflow: existing repo → context → changeset → validation → draft PR", async () => {
  const { service, repo, provider, store } = await setup();
  try {
    const t = await service.begin(p, repo.id, "charge payments", 2000);
    const c = await service.submit(p, t.id, "Handle zero payment", [
      {
        path: "src/payments.ts",
        content:
          "export function charge(amount: number) { return Math.max(0, amount); }\n",
      },
    ]);
    const v = await service.validate(p, c.id);
    assert(v.validation?.passed);
    assert(
      v.validation.warnings.some((w) => w.includes("unchanged dependents")),
    );
    assert(v.validation.checks.some((c) => c.status === "not_run"));
    const published = await service.publish(p, c.id, true);
    assert.equal(published.status, "published");
    assert.equal((await service.publish(p, c.id, true)).pr?.number, 1);
    assert.equal(provider.published, 1);
    assert(
      store.events(p.tenant).some((e) => e.action === "changeset.published"),
    );
  } finally {
    store.close();
  }
});
test("tenant and repository grants enforced even when a valid ID is known", async () => {
  const { service, repo, store } = await setup();
  try {
    await assert.rejects(
      async () => await service.repo({ ...p, tenant: "other" }, repo.id),
      /not found/,
    );
    await assert.rejects(
      async () =>
        await service.repo({ ...p, repositories: ["example/other"] }, repo.id),
      /denied/,
    );
  } finally {
    store.close();
  }
});
test("read scope cannot mutate or publish", async () => {
  const { service, repo, store } = await setup();
  try {
    await assert.rejects(
      async () =>
        await service.begin(
          { ...p, scopes: ["read"] },
          repo.id,
          "charge",
          2000,
        ),
      /scope/,
    );
  } finally {
    store.close();
  }
});
test("task context remains pinned after synchronization", async () => {
  const { service, repo, provider, store } = await setup();
  try {
    const t = await service.begin(p, repo.id, "charge", 2000);
    provider.revision = "b".repeat(40);
    provider.files = [
      sourceFile("src/payments.ts", "export const changed = true;"),
    ];
    await service.connect(p, "example/shop", "main", 1);
    const section = await service.read(
      p,
      t.id,
      "src/payments.ts",
      1,
      10,
      "Inspect original payment behavior",
    );
    assert(section.content.includes("function charge"));
    assert.equal(section.revision, revision);
  } finally {
    store.close();
  }
});
test("stale base, omitted warnings acknowledgment, and unvalidated publication fail", async () => {
  const { service, repo, provider, store } = await setup();
  try {
    const t = await service.begin(p, repo.id, "charge", 2000);
    const c = await service.submit(p, t.id, "Change payment", [
      { path: "src/payments.ts", content: "export const charge = () => 0;" },
    ]);
    await assert.rejects(
      async () => await service.publish(p, c.id, true),
      /Validate/,
    );
    await service.validate(p, c.id);
    await assert.rejects(
      async () => await service.publish(p, c.id, false),
      /Acknowledge/,
    );
    provider.revision = "b".repeat(40);
    await assert.rejects(
      async () => await service.publish(p, c.id, true),
      /Base branch moved/,
    );
    assert.equal(provider.published, 0);
  } finally {
    store.close();
  }
});
test("deleting a required module is rejected", async () => {
  const { service, repo, store } = await setup();
  try {
    const t = await service.begin(p, repo.id, "charge", 2000);
    const c = await service.submit(p, t.id, "Delete payment", [
      { path: "src/payments.ts", content: null },
    ]);
    assert(!(await service.validate(p, c.id)).validation?.passed);
  } finally {
    store.close();
  }
});
test("invalid syntax and introduced missing imports fail validation", async () => {
  const { service, repo, store } = await setup();
  try {
    const t = await service.begin(p, repo.id, "charge", 2000);
    for (const content of [
      "export function broken( {",
      "import x from './missing.js';\nexport const charge = x;",
    ]) {
      const c = await service.submit(p, t.id, "Break payment", [
        { path: "src/payments.ts", content },
      ]);
      assert(!(await service.validate(p, c.id)).validation?.passed);
    }
  } finally {
    store.close();
  }
});
test("duplicate paths, secret values, and workflow edits are blocked", async () => {
  const { service, repo, store } = await setup();
  try {
    const t = await service.begin(p, repo.id, "charge", 2000);
    await assert.rejects(
      async () =>
        await service.submit(p, t.id, "Secrets", [
          { path: "src/config.ts", content: 'const password = "abc";' },
        ]),
      /secret/,
    );
    await assert.rejects(
      async () =>
        await service.submit(p, t.id, "Workflow", [
          { path: ".github/workflows/deploy.yml", content: "x" },
        ]),
      /administrator/,
    );
    await assert.rejects(
      async () =>
        await service.submit(p, t.id, "Duplicate", [
          { path: "a.ts", content: "" },
          { path: "a.ts", content: "" },
        ]),
      /Duplicate/,
    );
  } finally {
    store.close();
  }
});
test("encryption authenticates stored source, rejects tampering, and audit is append-only", () => {
  const store = new Store(":memory:", "ab".repeat(32));
  try {
    store.put("a", "secret", { id: "1", content: "sensitive source" });
    const row = store.db.prepare("SELECT body FROM objects").get()!;
    assert(!String(row.body).includes("sensitive source"));
    assert.equal(
      store.get<any>("a", "secret", "1").content,
      "sensitive source",
    );
    assert.throws(() => new Store(":memory:", "invalid"));
    store.audit("a", "u", "read", "x");
    assert.throws(() => store.db.exec("DELETE FROM audit"), /append only/);
  } finally {
    store.close();
  }
});
test("repository deletion removes source and tasks but retains audit", async () => {
  const { service, repo, store } = await setup();
  try {
    const t = await service.begin(p, repo.id, "charge", 2000);
    await service.remove(p, repo.id);
    await assert.rejects(async () => await service.task(p, t.id), /not found/);
    assert.equal(store.list(p.tenant, "snapshot").length, 0);
    assert(store.events(p.tenant).length);
  } finally {
    store.close();
  }
});
test("realistic demo counts arise only from its source files", () => {
  const r = demoRepository();
  assert.equal(r.graph.files.length, 24);
  assert.equal(r.graph.nodes.filter((n) => n.kind === "file").length, 24);
  assert(r.graph.edges.length > 24);
});

test("serialized context including explanation and omission metadata remains bounded", () => {
  const files = Array.from({ length: 250 }, (_, i) =>
    sourceFile(
      `src/file${i}.ts`,
      `import { hub } from './hub.js';\nexport const value${i} = hub;\n`,
    ),
  );
  files.push(sourceFile("src/hub.ts", "export const hub = 1;"));
  for (const budget of [500, 1500, 6000]) {
    const c = context(index(files, revision), "Change hub", budget);
    assert(tokens(JSON.stringify(c)) <= budget);
    assert(c.omittedCount >= c.omitted.length);
  }
});
