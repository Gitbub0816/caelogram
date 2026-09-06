import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Store } from "../src/store.js";
import { Service } from "../src/service.js";
import { createServer } from "../src/server.js";
import { processJobs } from "../src/worker.js";
import { sourceFile } from "../src/graph.js";
import type { Provider } from "../src/github.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const provider: Provider = {
  async snapshot() {
    return {
      revision: "a".repeat(40),
      files: [sourceFile("index.ts", "export function hello() { return 1; }")],
    };
  },
  async head() {
    return "a".repeat(40);
  },
  async publish() {
    return {
      url: "https://github.com/example/app/pull/1",
      number: 1,
      branch: "caelogram/test",
    };
  },
};
test("HTTP authentication, origin checks, demo resolution and MCP lifecycle", async () => {
  const store = new Store(),
    service = new Service(store, provider),
    app = createServer(service, "test-token-long-enough"),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const port = (server.address() as any).port,
    url = `http://127.0.0.1:${port}`;
  try {
    let r = await fetch(url + "/api/tools/list_repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 401);
    assert(r.headers.get("www-authenticate")?.includes("resource_metadata"));
    r = await fetch(url + "/api/demo", {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(r.status, 403);
    r = await fetch(url + "/api/demo/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "payment retry checkout", budget: 3000 }),
    });
    assert.equal(r.status, 200);
    const t = await r.json();
    assert(t.context.items.length);
    assert(t.context.estimatedTokens <= 3000);
    r = await fetch(url + "/api/demo/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x", budget: -1 }),
    });
    assert.equal(r.status, 400);
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer test-token-long-enough" },
        },
      }),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 14);
    const result = await client.callTool({
      name: "list_repositories",
      arguments: {},
    });
    assert(!result.isError);
    await client.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
test("signed webhook receipts deduplicate and synchronize existing repositories", async () => {
  process.env.CAELOGRAM_INSTALLATIONS = JSON.stringify({ local: [42] });
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
  const store = new Store(),
    service = new Service(store, provider),
    p = {
      tenant: "local",
      subject: "test",
      scopes: ["admin"],
      repositories: ["*"],
    };
  const repo = await service.connect(p, "example/app", "main", 42);
  const server = createServer(service, "token").listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const body = JSON.stringify({
        repository: { full_name: "example/app" },
        installation: { id: 42 },
        ref: "refs/heads/main",
      }),
      signature =
        "sha256=" +
        createHmac("sha256", "test-webhook-secret").update(body).digest("hex");
    const send = (sig: string) =>
      fetch(url + "/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-delivery": "delivery-1",
          "x-github-event": "push",
          "x-hub-signature-256": sig,
        },
        body,
      });
    assert.equal((await send("bad")).status, 401);
    assert.equal((await send(signature)).status, 202);
    assert((await (await send(signature)).json()).duplicate);
    await processJobs(service);
    assert.equal(
      store.db.prepare("SELECT status FROM jobs").get()?.status,
      "complete",
    );
    assert.equal((await service.repo(p, repo.id)).graph.reused, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    delete process.env.GITHUB_WEBHOOK_SECRET;
  }
});
