import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { index, context, sourceFile } from "../src/graph.js";
import { mapExistingRepository } from "../src/local.js";
import { Store } from "../src/store.js";
import { Service } from "../src/service.js";
import type { Graph } from "../src/types.js";
const results: any[] = [];
async function measure(
  name: string,
  g: Graph,
  indexMs: number,
  prompt: string,
) {
  const start = performance.now(),
    c = context(g, prompt, 6000),
    contextMs = performance.now() - start;
  const t0 = performance.now(),
    updated = index(g.files, g.revision, g),
    incrementalMs = performance.now() - t0;
  const store = new Store();
  const p = {
    tenant: "benchmark",
    subject: "benchmark",
    scopes: ["admin"],
    repositories: ["*"],
  };
  process.env.CAELOGRAM_INSTALLATIONS = JSON.stringify({ benchmark: [1] });
  const provider = {
    async snapshot() {
      return { revision: g.revision, files: g.files };
    },
    async head() {
      return g.revision;
    },
    async publish() {
      return {
        url: "https://example.invalid/test-provider-only",
        number: 1,
        branch: "caelogram/test",
      };
    },
  };
  const service = new Service(store, provider);
  const repo = await service.connect(p, "benchmark/repo", "main", 1),
    task = service.begin(p, repo.id, prompt, 6000);
  // Safe additive edit exercises submission/validation/publication state at each size; does not modify third-party repositories.
  const change = service.submit(p, task.id, "Document benchmark execution", [
    {
      path: "caelogram-benchmark.md",
      content: "# Benchmark\nTest provider publication only.\n",
    },
  ]);
  const validation = service.validate(p, change.id);
  if (!validation.validation?.passed)
    throw new Error("Benchmark validation failed");
  const published = await service.publish(p, change.id, true);
  results.push({
    name,
    revision: g.revision,
    files: g.files.length,
    symbols: g.nodes.length - g.files.length,
    relationships: g.edges.filter((e) => e.kind !== "contains").length,
    indexMs: Math.round(indexMs),
    contextMs: Math.round(contextMs),
    unchangedReindexMs: Math.round(incrementalMs),
    declarationsReusedFiles: updated.reused,
    selectedFiles: c.items.length,
    omittedRelatedFiles: c.omittedCount,
    estimatedContextTokens: c.estimatedTokens,
    estimatedIndexedSourceTokens: c.sourceTokens,
    publication: published.status,
    publicationTransport: "test provider; no GitHub side effect",
    precisionRecall: "not measured",
  });
  store.close();
}
for (const size of [5, 250, 2500]) {
  const files = Array.from({ length: size }, (_, i) =>
    sourceFile(
      `src/region${Math.floor(i / 25)}/component${i}.ts`,
      `${i % 25 ? `import { component${i - 1} } from './component${i - 1}.js';\n` : ""}export function component${i}() { return ${i % 25 ? `component${i - 1}() + 1` : "0"}; }\n`,
    ),
  );
  const start = performance.now(),
    g = index(files, "a".repeat(40));
  await measure(
    `synthetic-${size}`,
    g,
    performance.now() - start,
    "Change component2 behavior",
  );
}
for (const directory of process.argv.slice(2)) {
  const start = performance.now(),
    g = await mapExistingRepository(directory);
  await measure(
    directory.split("/").pop()!,
    g,
    performance.now() - start,
    directory.includes("fastify")
      ? "Change request route handling"
      : "Change is assertion behavior",
  );
}
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  method:
    "Single local run; wall clock is environment dependent. Token counts are UTF-8 byte estimates, not agent billing. Synthetic repositories are labeled. Existing repository fixtures are read-only Git snapshots.",
  results,
};
writeFileSync("docs/benchmark.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
