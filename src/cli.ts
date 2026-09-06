#!/usr/bin/env node
import { Command } from "commander";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { mapExistingRepository } from "./local.js";
import { context } from "./graph.js";
import { assert } from "./security.js";
import { z } from "zod";
const configPath = resolve(homedir(), ".config/caelogram/config.json");
const config = () =>
  existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
async function call(name: string, input: unknown) {
  const c = config(),
    url = process.env.CAELOGRAM_URL ?? c.url ?? "http://localhost:4310",
    token = process.env.CAELOGRAM_TOKEN ?? c.token;
  assert(token, "Run caelogram login or set CAELOGRAM_TOKEN");
  const u = new URL(url);
  assert(
    u.protocol === "https:" || ["localhost", "127.0.0.1"].includes(u.hostname),
    "Remote service requires HTTPS",
  );
  const response = await fetch(`${url}/api/tools/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.json();
  assert(response.ok, body.error ?? "Request failed", response.status);
  return body;
}
const program = new Command()
  .name("caelogram")
  .description("The living map between your AI and your code.")
  .version("0.1.0");
program
  .command("login")
  .option("--url <url>", "Service origin", "http://localhost:4310")
  .description(
    "Read an issued Caelogram access token from CAELOGRAM_TOKEN; never a GitHub token",
  )
  .action(async ({ url }) => {
    const token = process.env.CAELOGRAM_TOKEN;
    assert(
      token,
      "Set CAELOGRAM_TOKEN to an issued token (browser OIDC login is a launch gate)",
    );
    const u = new URL(url);
    assert(
      u.protocol === "https:" ||
        ["localhost", "127.0.0.1"].includes(u.hostname),
      "Remote service requires HTTPS",
    );
    const r = await fetch(`${url}/api/tools/list_repositories`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert(r.ok, "Token was not accepted");
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, JSON.stringify({ url, token }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    console.log(
      "Authenticated. Credentials stored with owner-only file permissions.",
    );
  });
program
  .command("connect <repository>")
  .requiredOption(
    "--installation <id>",
    "Tenant-bound GitHub App installation ID",
  )
  .option("--branch <branch>", "Existing branch", "main")
  .description("Map an existing GitHub repository, without modifying it")
  .action(async (name, o) =>
    print(
      await call("connect_repository", {
        name,
        branch: o.branch,
        installationId: Number(o.installation),
      }),
    ),
  );
program
  .command("map [directory]")
  .option("--ref <ref>", "Commit or branch", "HEAD")
  .option("--task <task>", "Inspect a bounded context package")
  .option("--budget <tokens>", "Estimated token budget", "6000")
  .description(
    "Map an EXISTING local Git checkout at a committed revision; ignores uncommitted work",
  )
  .action(async (directory = ".", o) => {
    const graph = await mapExistingRepository(directory, o.ref);
    if (o.task)
      print(
        context(
          graph,
          o.task,
          z.coerce.number().int().min(500).max(16000).parse(o.budget),
        ),
      );
    else {
      const output = resolve(directory, ".caelogram/map.json");
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      writeFileSync(
        output,
        JSON.stringify(
          {
            revision: graph.revision,
            nodes: graph.nodes,
            edges: graph.edges,
            warnings: graph.warnings,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      print({
        revision: graph.revision,
        files: graph.files.length,
        symbols: graph.nodes.length - graph.files.length,
        relationships: graph.edges.filter((e) => e.kind !== "contains").length,
        output,
        warnings: graph.warnings,
      });
    }
  });
program
  .command("begin <repoId> <task>")
  .option("--budget <tokens>", "Context budget", "6000")
  .action(async (repoId, prompt, o) =>
    print(
      await call("begin_change", { repoId, prompt, budget: Number(o.budget) }),
    ),
  );
program
  .command("submit <taskId> <file>")
  .requiredOption("--title <title>", "Changeset title")
  .description(
    "Submit a JSON array of {path, content}; content null deletes a file",
  )
  .action(async (taskId, file, o) =>
    print(
      await call("submit_changeset", {
        taskId,
        title: o.title,
        edits: JSON.parse(readFileSync(resolve(file), "utf8")),
      }),
    ),
  );
program
  .command("validate <changesetId>")
  .action(async (changesetId) =>
    print(await call("validate_changeset", { changesetId })),
  );
program
  .command("publish <changesetId>")
  .requiredOption(
    "--acknowledge-warnings",
    "Confirm draft publication after reviewing validation warnings",
  )
  .action(async (changesetId, o) =>
    print(
      await call("publish_pull_request", {
        changesetId,
        acknowledgeWarnings: o.acknowledgeWarnings,
      }),
    ),
  );
program
  .command("sync <repoId>")
  .action(async (repoId) => print(await call("sync_repository", { repoId })));
program
  .command("status")
  .action(async () => print(await call("list_repositories", {})));
program
  .command("init")
  .option("--client <client>", "claude, cursor, or codex", "claude")
  .description(
    "Print integration configuration; does not overwrite agent settings",
  )
  .action(({ client }) => {
    const c = config(),
      url =
        (process.env.CAELOGRAM_URL ?? c.url ?? "http://localhost:4310") +
        "/mcp";
    if (client === "codex")
      console.log(
        `[mcp_servers.caelogram]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "CAELOGRAM_TOKEN"`,
      );
    else {
      assert(
        ["claude", "cursor"].includes(client),
        "Choose claude, cursor, or codex",
      );
      print({
        mcpServers: {
          caelogram: {
            ...(client === "claude" ? { type: "http" } : {}),
            url,
            headers: { Authorization: "Bearer ${CAELOGRAM_TOKEN}" },
          },
        },
      });
    }
  });
program.command("doctor").action(async () => {
  const c = config();
  print({
    node: process.version,
    nodeSupported: Number(process.versions.node.split(".")[0]) >= 24,
    service: process.env.CAELOGRAM_URL ?? c.url ?? "http://localhost:4310",
    tokenConfigured: !!(process.env.CAELOGRAM_TOKEN ?? c.token),
    githubCredentialsRequiredInClient: false,
  });
});
program.parseAsync().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
