import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "node:fs";
import type { Edit, SourceFile } from "./types.js";
import { assert, Fault } from "./security.js";
import { eligible } from "./graph.js";
export interface Provider {
  snapshot(
    name: string,
    branch: string,
    installationId: number,
    previous?: SourceFile[],
  ): Promise<{ revision: string; files: SourceFile[] }>;
  head(name: string, branch: string, installationId: number): Promise<string>;
  publish(
    name: string,
    branch: string,
    base: string,
    installationId: number,
    id: string,
    title: string,
    edits: Edit[],
  ): Promise<{ url: string; number: number; branch: string }>;
}
export class GitHub implements Provider {
  constructor(private credentials?: { appId: string; privateKey: string }, private sourceBudget = 25_000_000) {}
  private auth?: ReturnType<typeof createAppAuth>;
  async api(
    name: string,
    installationId: number,
    route: string,
    method = "GET",
    body?: unknown,
  ): Promise<any> {
    assert(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name),
      "Invalid repository name",
    );
    assert(
      this.credentials ||
        (process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY_FILE),
      "GitHub App is not configured",
      503,
    );
    this.auth ??= createAppAuth({
      appId: this.credentials?.appId ?? process.env.GITHUB_APP_ID!,
      privateKey:
        this.credentials?.privateKey ??
        readFileSync(process.env.GITHUB_PRIVATE_KEY_FILE!, "utf8"),
    });
    const token = await this.auth({
      type: "installation",
      installationId,
      repositoryNames: [name.split("/")[1]],
    });
    const res = await fetch(`https://api.github.com/repos/${name}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Caelogram",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok)
      throw new Fault(
        res.status === 404 ? 404 : 502,
        `GitHub request failed (${res.status}); inspect installation permissions or rate limits`,
      );
    return res.status === 204 ? null : res.json();
  }
  async head(name: string, branch: string, installationId: number) {
    return (
      await this.api(
        name,
        installationId,
        `/git/ref/heads/${encodeURIComponent(branch)}`,
      )
    ).object.sha as string;
  }
  async snapshot(
    name: string,
    branch: string,
    installationId: number,
    previous: SourceFile[] = [],
  ) {
    const revision = await this.head(name, branch, installationId);
    const tree = await this.api(
      name,
      installationId,
      `/git/trees/${revision}?recursive=1`,
    );
    assert(
      !tree.truncated,
      "Repository tree exceeds MVP ingestion limit; no partial index was committed",
      413,
    );
    const entries = tree.tree.filter(
      (e: any) =>
        e.type === "blob" &&
        ["100644", "100755"].includes(e.mode) &&
        eligible(e.path) &&
        e.size <= 256000,
    );
    assert(
      entries.length <= 5000,
      "MVP supports at most 5,000 eligible files",
      413,
    );
    const eligibleBytes = entries.reduce((s: number, e: any) => s + e.size, 0);
    assert(
      eligibleBytes <= this.sourceBudget,
      `Repository has ${(eligibleBytes / 1_000_000).toFixed(1)} MB of eligible source; hosted indexing currently supports ${this.sourceBudget / 1_000_000} MB. No partial index was published; use caelogram map locally.`,
      413,
    );
    const files: SourceFile[] = [];
    // Bounded concurrency to respect secondary GitHub rate limits.
    for (let i = 0; i < entries.length; i += 2) {
      files.push(
        ...(await Promise.all(
          entries.slice(i, i + 2).map(async (e: any) => {
            const cached = previous.find(
              (f) => f.path === e.path && f.sha === e.sha,
            );
            if (cached) return cached;
            const b = await this.api(
              name,
              installationId,
              `/git/blobs/${e.sha}`,
            );
            assert(b.encoding === "base64", "Unexpected blob encoding");
            return {
              path: e.path,
              sha: e.sha,
              content: Buffer.from(b.content, "base64").toString("utf8"),
            };
          }),
        )),
      );
    }
    assert(files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <= this.sourceBudget, "Downloaded source exceeds runtime budget", 413);
    return { revision, files };
  }
  async publish(
    name: string,
    branch: string,
    base: string,
    installationId: number,
    id: string,
    title: string,
    edits: Edit[],
  ) {
    const serviceBranch = `caelogram/${id}`;
    // Idempotent recovery if a previous request created a PR but its response was lost.
    const existing = await this.api(
      name,
      installationId,
      `/pulls?state=all&head=${encodeURIComponent(name.split("/")[0] + ":" + serviceBranch)}`,
    );
    if (existing[0])
      return {
        url: existing[0].html_url,
        number: existing[0].number,
        branch: serviceBranch,
      };
    assert(
      (await this.head(name, branch, installationId)) === base,
      "Base branch moved; start a new task and revalidate",
      409,
    );
    const commit = await this.api(name, installationId, `/git/commits/${base}`);
    const tree = [];
    for (const edit of edits) {
      if (edit.content === null)
        tree.push({ path: edit.path, mode: "100644", type: "blob", sha: null });
      else {
        const blob = await this.api(
          name,
          installationId,
          "/git/blobs",
          "POST",
          { content: edit.content, encoding: "utf-8" },
        );
        tree.push({
          path: edit.path,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        });
      }
    }
    const newTree = await this.api(name, installationId, "/git/trees", "POST", {
      base_tree: commit.tree.sha,
      tree,
    });
    const next = await this.api(name, installationId, "/git/commits", "POST", {
      message: title,
      tree: newTree.sha,
      parents: [base],
    });
    assert(
      (await this.head(name, branch, installationId)) === base,
      "Base branch moved during publication; no branch created",
      409,
    );
    try {
      await this.api(name, installationId, "/git/refs", "POST", {
        ref: `refs/heads/${serviceBranch}`,
        sha: next.sha,
      });
    } catch (error) {
      // Do not overwrite an existing branch; only recover our own exact changeset tree.
      const ref = await this.head(name, serviceBranch, installationId);
      const prior = await this.api(name, installationId, `/git/commits/${ref}`);
      assert(
        prior.tree.sha === newTree.sha && prior.parents?.[0]?.sha === base,
        "Service branch collision; manual review required",
        409,
      );
    }
    const pr = await this.api(name, installationId, "/pulls", "POST", {
      title,
      head: serviceBranch,
      base: branch,
      draft: true,
      body: `Caelogram changeset ${id}\n\nExact base: ${base}\n\nStatic validation only. Review impact warnings and run required CI before merging. Repository content was treated as untrusted data.`,
    });
    return { url: pr.html_url, number: pr.number, branch: serviceBranch };
  }
}
