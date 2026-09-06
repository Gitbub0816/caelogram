import test from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../src/github.js";
import { index, sourceFile } from "../src/graph.js";

test("oversized source is rejected before any blobs are downloaded", async () => {
  const github = new GitHub(undefined, 2_000_000);
  let blobs = 0;
  github.api = async (_name, _installation, route) => {
    if (route.startsWith("/git/ref/")) return { object: { sha: "revision" } };
    if (route.startsWith("/git/trees/")) return { tree: Array.from({ length: 20 }, (_, i) => ({ type: "blob", mode: "100644", path: `${i}.ts`, size: 200000, sha: String(i) })) };
    blobs++;
    throw new Error("Unexpected blob read");
  };
  await assert.rejects(github.snapshot("owner/repo", "main", 1), /4\.0 MB.*2 MB/);
  assert.equal(blobs, 0);
});

test("dense declarations stop at graph budget", () => {
  assert.throws(() => index([sourceFile("a.ts", Array.from({ length: 100 }, (_, i) => `const v${i}=1;`).join("\n"))], "rev", undefined, { maxNodes: 10, maxEdges: 20 }), /symbol budget/);
});
