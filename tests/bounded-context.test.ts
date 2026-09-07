import test from "node:test";
import assert from "node:assert/strict";
import {
  index,
  sourceFile,
  tokens,
  brief,
  BRIEF_BUDGET,
} from "../src/graph.js";
import { Store } from "../src/store.js";
import { Service, MAP_PAGE_FILES, MAP_PAGE_TOKENS } from "../src/service.js";
import { dispatch, mcp, schemas, type ToolName } from "../src/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Edit, Principal } from "../src/types.js";
import type { Provider } from "../src/github.js";

const revision = "c".repeat(40);
const p: Principal = {
  tenant: "test",
  subject: "tester",
  scopes: ["admin"],
  repositories: ["*"],
};
/** A synthetic repository of the shape the owner reports: thousands of files. */
function largeRepository(count = 2500) {
  const files = [
    sourceFile(
      "src/core/hub.ts",
      "export const hub = 1;\nexport function chargePayment(amount: number) {\n  return amount;\n}\n",
    ),
    sourceFile(
      "src/payments/charge.ts",
      "import { chargePayment } from '../core/hub.js';\nexport const charge = (n: number) => chargePayment(n);\n",
    ),
  ];
  for (let i = 0; i < count; i++)
    files.push(
      sourceFile(
        `src/area${i % 40}/module${i}.ts`,
        `import { hub } from '../core/hub.js';\nexport function widget${i}() {\n  return hub + ${i};\n}\n`,
      ),
    );
  return files;
}
class FakeProvider implements Provider {
  constructor(public files = largeRepository()) {}
  revision = revision;
  async snapshot() {
    return { revision: this.revision, files: this.files };
  }
  async head() {
    return this.revision;
  }
  async publish(
    _name: string,
    _branch: string,
    _base: string,
    _installation: number,
    id: string,
    _title: string,
    _edits: Edit[],
  ) {
    return { url: "https://example.invalid/pr/1", number: 1, branch: id };
  }
}
async function setup(files = largeRepository()) {
  process.env.CAELOGRAM_INSTALLATIONS = JSON.stringify({ test: [1] });
  const store = new Store(),
    service = new Service(store, new FakeProvider(files));
  const repo = await service.connect(p, "example/large", "main", 1);
  return { store, service, repo };
}

test("the brief stays tiny for a large repository and counts only indexed entities", () => {
  const graph = index(largeRepository(), revision);
  const record = brief(graph, {
    id: "r",
    name: "example/large",
    branch: "main",
    status: "ready",
  });
  assert(tokens(JSON.stringify(record)) <= BRIEF_BUDGET);
  assert.equal(
    record.files,
    graph.nodes.filter((n) => n.kind === "file").length,
  );
  assert.equal(
    record.symbols,
    graph.nodes.filter((n) => n.kind !== "file").length,
  );
  // Density must match the index: every listed path is a real indexed file.
  const indexed = new Set(graph.files.map((f) => f.path));
  for (const h of record.hubs) assert(indexed.has(h.path));
  for (const e of record.entrypoints) assert(indexed.has(e.path));
  for (const s of record.subsystems)
    assert(graph.files.some((f) => f.path.startsWith(s.path + "/")));
  // The hub every module imports is reported as the most-depended-on file.
  assert.equal(record.hubs[0].path, "src/core/hub.ts");
  assert(record.truncated.length, "large repositories must state what was cut");
});

test("no tool can return an unbounded graph", async () => {
  const { service, store, repo } = await setup();
  try {
    const brief = await dispatch(service, p, "repository_map", {
      repoId: repo.id,
    });
    assert.equal(brief.nodes, undefined);
    assert.equal(brief.edges, undefined);
    assert(brief.accounting.estimatedTokens <= BRIEF_BUDGET + 200);
    const page = await dispatch(service, p, "map_page", { repoId: repo.id });
    assert.equal(page.visibleFiles, MAP_PAGE_FILES);
    assert.equal(
      new Set(page.nodes.map((n: any) => n.path)).size,
      MAP_PAGE_FILES,
    );
    assert(page.nextCursor);
    // A dense page surrenders declarations rather than growing without bound.
    assert(page.accounting.estimatedTokens <= MAP_PAGE_TOKENS + 200);
    assert(
      page.nodes.filter((n: any) => n.kind === "file").length ===
        MAP_PAGE_FILES,
      "file nodes are never the part that gets dropped",
    );
    assert(
      page.accounting.omitted.some((o: any) => o.what.includes("declarations")),
      "dropped declarations must be reported",
    );
    // Whole-index counts stay available, but the payload never carries them all.
    assert(page.files > page.visibleFiles);
    const found = await dispatch(service, p, "find_component", {
      repoId: repo.id,
      query: "widget",
    });
    assert.equal(found.components.length, 30);
    assert(found.matched > 30);
    assert.equal(found.accounting.omitted[0].count, found.matched - 30);
    const task = await dispatch(service, p, "begin_change", {
      repoId: repo.id,
      prompt: "charge payment amount in chargePayment",
      budget: 4000,
    });
    const expanded = await dispatch(service, p, "expand_impact", {
      taskId: task.id,
      paths: ["src/core/hub.ts"],
      depth: 2,
    });
    assert.equal(expanded.components.length, 200);
    assert(expanded.reached > 200);
    assert(expanded.accounting.omitted.length);
  } finally {
    store.close();
  }
});

test("token accounting is present and consistent on every tool", async () => {
  const { service, store, repo } = await setup(
    largeRepository(20).slice(0, 12),
  );
  try {
    const task = await dispatch(service, p, "begin_change", {
      repoId: repo.id,
      prompt: "charge payment amount",
      budget: 3000,
    });
    const change = await dispatch(service, p, "submit_changeset", {
      taskId: task.id,
      title: "Bound the charge",
      edits: [
        {
          path: "src/payments/charge.ts",
          content: "export const charge = 1;\n",
        },
      ],
    });
    const calls: [ToolName, any][] = [
      ["list_repositories", {}],
      ["repository_map", { repoId: repo.id }],
      ["index_status", { repoId: repo.id }],
      ["map_page", { repoId: repo.id }],
      ["find_component", { repoId: repo.id, query: "hub" }],
      ["get_context", { taskId: task.id }],
      [
        "expand_impact",
        { taskId: task.id, paths: ["src/core/hub.ts"], depth: 1 },
      ],
      [
        "read_section",
        {
          taskId: task.id,
          path: "src/core/hub.ts",
          start: 1,
          end: 4,
          reason: "Confirm the charge signature before editing it",
        },
      ],
      [
        "source_search",
        {
          taskId: task.id,
          query: "chargePayment",
          reason: "Locate remaining callers of the charged amount",
        },
      ],
      ["changeset_status", { changesetId: change.id }],
      ["validate_changeset", { changesetId: change.id }],
      ["sync_repository", { repoId: repo.id }],
    ];
    for (const [name, input] of calls) {
      const body = await dispatch(service, p, name, input);
      const a = body.accounting;
      assert(a, `${name} carries no accounting`);
      assert(a.estimatedTokens > 0, name);
      assert(
        Math.abs(a.estimatedTokens - tokens(JSON.stringify(body))) <= 20,
        `${name} accounting must describe its own response`,
      );
      assert(/not model token billing/.test(a.estimate), name);
      assert(a.bound.length > 10, name);
      assert(Array.isArray(a.omitted), name);
      for (const o of a.omitted) assert(o.what && o.why, name);
    }
    // Task tools carry the remaining ingestion ceiling and it only shrinks.
    let previous = Infinity;
    for (const input of [1, 2, 3]) {
      const body = await dispatch(service, p, "read_section", {
        taskId: task.id,
        path: "src/core/hub.ts",
        start: input,
        end: input + 1,
        reason: "Re-read the charged amount to justify the edit",
      });
      assert(body.accounting.task);
      assert(body.accounting.task.remaining < previous);
      assert.equal(
        body.accounting.task.remaining,
        Math.max(
          0,
          body.accounting.task.pullBudget - body.accounting.task.spent,
        ),
      );
      previous = body.accounting.task.remaining;
    }
    // begin_change reports the ceiling it established.
    assert.equal(task.accounting.task.pullBudget, 12000);
    // Every tool name is reachable through a schema, so no tool escapes the wrapper.
    for (const name of Object.keys(schemas))
      assert(typeof (schemas as any)[name].parse === "function", name);
  } finally {
    store.close();
  }
});

test("the plan ranks evidenced candidates and respects the budget", async () => {
  const { service, store, repo } = await setup();
  try {
    for (const budget of [800, 2000, 6000]) {
      const task = await dispatch(service, p, "begin_change", {
        repoId: repo.id,
        prompt: "chargePayment amount in the payments area",
        budget,
      });
      const c = task.context;
      assert(tokens(JSON.stringify(c)) <= budget);
      assert(c.estimatedTokens <= budget);
      assert(c.plan.length, "a plan must be returned");
      const indexed = new Set(
        (await service.repo(p, repo.id)).graph.files.map((f) => f.path),
      );
      for (const entry of c.plan) {
        assert(indexed.has(entry.path), "plans never name unindexed files");
        assert(entry.reason.length > 8 && entry.evidence.length > 8);
        assert(entry.estimatedTokens > 0);
        assert(
          ["included", "excerpted", "omitted"].includes(entry.status),
          entry.status,
        );
      }
      // Delivered items must be exactly the plan entries that claim delivery.
      const delivered = new Set(c.items.map((i: any) => i.path));
      for (const entry of c.plan)
        assert.equal(delivered.has(entry.path), entry.status !== "omitted");
      // The payment files outrank the 2,500 lookalike modules.
      assert(
        ["src/payments/charge.ts", "src/core/hub.ts"].includes(c.plan[0].path),
        c.plan[0].path,
      );
    }
  } finally {
    store.close();
  }
});

test("a justified section read stays within its cap and the task ceiling is enforced", async () => {
  const { service, store, repo } = await setup(largeRepository(6));
  try {
    const task = await dispatch(service, p, "begin_change", {
      repoId: repo.id,
      prompt: "chargePayment",
      budget: 500,
    });
    await assert.rejects(
      () =>
        dispatch(service, p, "read_section", {
          taskId: task.id,
          path: "src/core/hub.ts",
          start: 1,
          end: 400,
          reason: "Attempt to read the entire file at once",
        }),
      /200 lines/,
    );
    await assert.rejects(
      () =>
        dispatch(service, p, "read_section", {
          taskId: task.id,
          path: "src/core/hub.ts",
          start: 1,
          end: 4,
          reason: "short",
        }),
      /reason|Explain|at least/i,
    );
    const section = await dispatch(service, p, "read_section", {
      taskId: task.id,
      path: "src/core/hub.ts",
      start: 1,
      end: 4,
      reason: "Confirm the charge signature before editing it",
    });
    assert(section.content.includes("chargePayment"));
    assert(section.estimatedTokens <= 4000);
    assert.equal(section.revision, revision);
    // Spend the ceiling, then further reads are refused rather than served.
    await service.spend(p, task.id, 1_000_000);
    await assert.rejects(
      () =>
        dispatch(service, p, "read_section", {
          taskId: task.id,
          path: "src/core/hub.ts",
          start: 1,
          end: 4,
          reason: "Try to keep reading after the ceiling is spent",
        }),
      /ingestion ceiling/,
    );
  } finally {
    store.close();
  }
});

test("map pages report cross-page relationships instead of dropping them", async () => {
  const files = [
    sourceFile("src/aaa/root.ts", "export const root = 1;\n"),
    ...Array.from({ length: 60 }, (_, i) =>
      sourceFile(
        `src/zzz/consumer${String(i).padStart(3, "0")}.ts`,
        "import { root } from '../aaa/root.js';\nexport const use = root;\n",
      ),
    ),
  ];
  const { service, store, repo } = await setup(files);
  try {
    const page = await dispatch(service, p, "map_page", { repoId: repo.id });
    assert.equal(page.visibleFiles, MAP_PAGE_FILES);
    assert(page.boundaryEdgeCount > 0);
    assert(
      page.boundaryEdges.every(
        (e: any) => e.offPage && e.evidence.includes("Static module specifier"),
      ),
    );
    assert(page.warnings.some((w: string) => w.includes("boundaryEdges")));
    const second = await dispatch(service, p, "map_page", {
      repoId: repo.id,
      after: page.nextCursor,
    });
    assert(second.visibleFiles > 0);
    assert(
      second.nodes.every((n: any) => n.path > page.nextCursor),
      "paging must not repeat files",
    );
    const filtered = await dispatch(service, p, "map_page", {
      repoId: repo.id,
      query: "aaa",
    });
    assert(
      filtered.nodes.every((n: any) => n.path.includes("aaa")),
      "a path query must filter the page",
    );
  } finally {
    store.close();
  }
});

test("the brief and the task package are MCP resources, with prompt templates", async () => {
  const { service, store, repo } = await setup(largeRepository(6));
  try {
    const task = await dispatch(service, p, "begin_change", {
      repoId: repo.id,
      prompt: "chargePayment amount",
      budget: 1500,
    });
    const server = mcp(service, p);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const listed = await client.listResources();
      assert(
        listed.resources.some(
          (r) => r.uri === `caelogram://repository/${repo.id}/brief`,
        ),
      );
      const read = await client.readResource({
        uri: `caelogram://repository/${repo.id}/brief`,
      });
      const brief = JSON.parse(String(read.contents[0].text));
      assert.equal(brief.nodes, undefined);
      assert.equal(brief.edges, undefined);
      assert(brief.accounting.estimatedTokens <= BRIEF_BUDGET + 200);
      const packaged = await client.readResource({
        uri: `caelogram://task/${task.id}/context`,
      });
      const context = JSON.parse(String(packaged.contents[0].text));
      assert(context.plan.length);
      assert(
        context.accounting.task.remaining < context.accounting.task.pullBudget,
      );
      const prompts = await client.listPrompts();
      assert.deepEqual(prompts.prompts.map((x) => x.name).sort(), [
        "plan_change",
        "review_context",
      ]);
      const prompt = await client.getPrompt({
        name: "plan_change",
        arguments: { repoId: repo.id, task: "Reject negative charges" },
      });
      const text = String((prompt.messages[0].content as any).text);
      assert(text.includes(repo.id));
      assert(text.includes("read_section"));
    } finally {
      await client.close();
    }
  } finally {
    store.close();
  }
});
