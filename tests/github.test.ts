import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../src/github.js";
const base = "a".repeat(40);
class GitHubDouble extends GitHub {
  requests: { route: string; method: string; body: any }[] = [];
  moved = false;
  refCreated = false;
  existingPr = false;
  override async api(
    _name: string,
    _id: number,
    route: string,
    method = "GET",
    body?: any,
  ): Promise<any> {
    this.requests.push({ route, method, body });
    if (route.startsWith("/pulls?"))
      return this.existingPr
        ? [{ html_url: "https://github.com/owner/repo/pull/7", number: 7 }]
        : [];
    if (route === "/git/ref/heads/main")
      return { object: { sha: this.moved ? "b".repeat(40) : base } };
    if (route === `/git/commits/${base}`) return { tree: { sha: "base-tree" } };
    if (route === "/git/blobs") return { sha: "new-blob" };
    if (route === "/git/trees") return { sha: "new-tree" };
    if (route === "/git/commits") return { sha: "new-commit" };
    if (route === "/git/refs") {
      this.refCreated = true;
      return {};
    }
    if (route === "/pulls")
      return { html_url: "https://github.com/owner/repo/pull/7", number: 7 };
    throw new Error("Unexpected route " + route);
  }
}
test("GitHub publisher uses exact parent and service branch, never writes the base ref", async () => {
  const github = new GitHubDouble();
  const result = await github.publish(
    "owner/repo",
    "main",
    base,
    1,
    "change-id",
    "Update module",
    [{ path: "src/file.ts", content: "export const value = 2;" }],
  );
  assert.equal(result.number, 7);
  assert.deepEqual(
    github.requests.find((r) => r.route === "/git/commits")?.body.parents,
    [base],
  );
  assert.equal(
    github.requests.find((r) => r.route === "/git/refs")?.body.ref,
    "refs/heads/caelogram/change-id",
  );
  assert.equal(
    github.requests.find((r) => r.route === "/pulls")?.body.draft,
    true,
  );
  assert(!github.requests.some((r) => r.method === "PATCH" || r.body?.force));
  assert.equal(
    github.requests.filter((r) => r.route === "/git/ref/heads/main").length,
    2,
  );
});
test("GitHub publisher rejects moved heads without branch or PR creation", async () => {
  const github = new GitHubDouble();
  github.moved = true;
  await assert.rejects(
    () =>
      github.publish(
        "owner/repo",
        "main",
        base,
        1,
        "change-id",
        "Update module",
        [{ path: "src/file.ts", content: "x" }],
      ),
    /Base branch moved/,
  );
  assert(!github.refCreated);
  assert(!github.requests.some((r) => r.method === "POST"));
});
test("GitHub retry finds previously created PR without another write", async () => {
  const github = new GitHubDouble();
  github.existingPr = true;
  const result = await github.publish(
    "owner/repo",
    "main",
    base,
    1,
    "change-id",
    "Update module",
    [],
  );
  assert.equal(result.number, 7);
  assert(!github.requests.some((r) => r.method === "POST"));
});
