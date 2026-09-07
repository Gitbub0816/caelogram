import test from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../src/github.js";
import {
  index,
  sourceFile,
  brief,
  tokens,
  BRIEF_BUDGET,
} from "../src/graph.js";

test("oversized source is rejected before any blobs are downloaded", async () => {
  const github = new GitHub(undefined, 2_000_000);
  let blobs = 0;
  github.api = async (_name, _installation, route) => {
    if (route.startsWith("/git/ref/")) return { object: { sha: "revision" } };
    if (route.startsWith("/git/trees/"))
      return {
        tree: Array.from({ length: 20 }, (_, i) => ({
          type: "blob",
          mode: "100644",
          path: `${i}.ts`,
          size: 200000,
          sha: String(i),
        })),
      };
    blobs++;
    throw new Error("Unexpected blob read");
  };
  await assert.rejects(
    github.snapshot("owner/repo", "main", 1),
    /4\.0 MB.*2 MB/,
  );
  assert.equal(blobs, 0);
});

test("dense declarations stop at graph budget", () => {
  assert.throws(
    () =>
      index(
        [
          sourceFile(
            "a.ts",
            Array.from({ length: 100 }, (_, i) => `const v${i}=1;`).join("\n"),
          ),
        ],
        "rev",
        undefined,
        { maxNodes: 10, maxEdges: 20 },
      ),
    /symbol budget/,
  );
});

test("the repository brief cost does not grow with repository size", () => {
  const build = (count: number) =>
    index(
      [
        sourceFile("src/core/hub.ts", "export const hub = 1;\n"),
        ...Array.from({ length: count }, (_, i) =>
          sourceFile(
            `src/area${i % 30}/module${i}.ts`,
            `import { hub } from '../core/hub.js';\nexport const value${i} = hub;\n`,
          ),
        ),
      ],
      "rev",
    );
  const cost = [400, 4000].map((count) =>
    tokens(
      JSON.stringify(
        brief(build(count), {
          id: "r",
          name: "example/large",
          branch: "main",
          status: "ready",
        }),
      ),
    ),
  );
  for (const c of cost) assert(c <= BRIEF_BUDGET, `brief cost ${c}`);
  // A ten-fold larger repository must not cost meaningfully more to orient in.
  assert(Math.abs(cost[1] - cost[0]) <= 60);
});
