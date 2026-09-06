import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { eligible, index } from "./graph.js";
import { assert } from "./security.js";
import type { Graph, SourceFile } from "./types.js";
const exec = promisify(execFile);
export async function mapExistingRepository(
  directory: string,
  ref = "HEAD",
  previous?: Graph,
) {
  const cwd = resolve(directory);
  assert(!ref.startsWith("-") && !ref.includes("\0"), "Invalid Git ref");
  const git = async (args: string[]) =>
    (
      await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        maxBuffer: 30_000_000,
        timeout: 60000,
        encoding: "utf8",
      })
    ).stdout;
  const revision = (
    await git(["rev-parse", "--verify", `${ref}^{commit}`])
  ).trim();
  assert(/^[a-f0-9]{40,64}$/.test(revision), "Invalid commit");
  const tree = (await git(["ls-tree", "-r", "-z", "-l", revision]))
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const [metadata, path] = row.split("\t");
      const [mode, type, sha, size] = metadata.trim().split(/\s+/);
      return { mode, type, sha, size: Number(size), path };
    })
    .filter(
      (e) =>
        e.type === "blob" &&
        ["100644", "100755"].includes(e.mode) &&
        eligible(e.path) &&
        e.size <= 256000,
    );
  assert(
    tree.length <= 5000 && tree.reduce((s, e) => s + e.size, 0) <= 25_000_000,
    "MVP limit: 5,000 eligible files / 25 MB",
  );
  const files: SourceFile[] = [];
  for (let i = 0; i < tree.length; i += 8)
    files.push(
      ...(await Promise.all(
        tree
          .slice(i, i + 8)
          .map(async (e) => ({
            path: e.path,
            sha: e.sha,
            content:
              previous?.files.find((f) => f.path === e.path && f.sha === e.sha)
                ?.content ?? (await git(["cat-file", "blob", e.sha])),
          })),
      )),
    );
  return index(files, revision, previous);
}
