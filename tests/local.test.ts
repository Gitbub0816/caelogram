import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mapExistingRepository } from "../src/local.js";
test("map an existing git repository: committed source, no untracked secrets or dirty edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caelogram-existing-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await mkdir(join(dir, "src"));
    await writeFile(
      join(dir, "src/index.ts"),
      "export function existing() { return true; }\n",
    );
    git("add", ".");
    git("commit", "-m", "Existing project");
    await writeFile(join(dir, "src/index.ts"), "export const dirty = true;");
    await writeFile(join(dir, ".env"), "SECRET=not-for-index");
    const g = await mapExistingRepository(dir);
    assert.equal(g.files.length, 1);
    assert(g.nodes.some((n) => n.name === "existing"));
    assert(!g.nodes.some((n) => n.name === "dirty"));
    assert(!JSON.stringify(g).includes("not-for-index"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
