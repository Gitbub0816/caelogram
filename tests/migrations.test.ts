import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = "cloudflare/migrations";
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Wrangler splits a migration into statements on semicolons. The test loaders in
// this suite split on newlines. A semicolon inside a comment or a string literal
// is therefore invisible locally and fatal on `d1 migrations apply` — which is
// exactly how a broken migration reached production once already.
test("no migration hides a semicolon inside a comment or a string literal", () => {
  assert(files.length > 0);
  for (const file of files) {
    const text = readFileSync(`${dir}/${file}`, "utf8");
    text.split("\n").forEach((line, index) => {
      const where = `${file}:${index + 1}`;
      for (const comment of line.match(/\/\*[\s\S]*?\*\//g) ?? [])
        assert(
          !comment.includes(";"),
          `${where}: semicolon inside a comment would split the statement — ${comment}`,
        );
      for (const literal of line.match(/'(?:[^']|'')*'/g) ?? [])
        assert(
          !literal.includes(";"),
          `${where}: semicolon inside a string literal would split the statement — ${literal}`,
        );
    });
  }
});

// The suite's loaders execute one line at a time, so a statement wrapped across
// lines silently never runs.
test("every migration statement fits on one line and is terminated", () => {
  for (const file of files) {
    const text = readFileSync(`${dir}/${file}`, "utf8");
    text.split("\n").forEach((raw, index) => {
      const line = raw.trim();
      if (!line) return;
      assert(
        line.endsWith(";"),
        `${file}:${index + 1}: statement is not terminated on its own line`,
      );
    });
  }
});

test("migrations are numbered uniquely and in sequence", () => {
  const numbers = files.map((f) => Number(f.slice(0, 4)));
  assert.deepEqual(
    numbers,
    numbers.map((_, i) => i + 1),
    `migration numbering has a gap or duplicate: ${files.join(", ")}`,
  );
});
