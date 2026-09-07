#!/usr/bin/env node
import { Command } from "commander";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { mapExistingRepository } from "./local.js";
import { context } from "./graph.js";
import { assert } from "./security.js";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_SCOPE,
  deviceLogin,
  discover,
  expired,
  liveDeps,
  refreshCredentials,
  revokeToken,
  type Credentials,
  type ServerMetadata,
} from "./auth.js";
import { z } from "zod";

const VERSION = "0.1.0";
const DEFAULT_URL = "http://localhost:4310";
const configPath = resolve(homedir(), ".config/caelogram/config.json");

type Config = {
  url?: string;
  clientId?: string;
  metadata?: ServerMetadata;
  credentials?: Credentials;
  /** Legacy field written by the pre-OAuth environment-token login. */
  token?: string;
};

const config = (): Config =>
  existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};

function save(next: Config) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

const serviceUrl = (c: Config = config()) =>
  process.env.CAELOGRAM_URL ?? c.url ?? DEFAULT_URL;

const clientId = (c: Config = config()) =>
  process.env.CAELOGRAM_CLIENT_ID ?? c.clientId ?? DEFAULT_CLIENT_ID;

function requireServiceTransport(url: string) {
  const u = new URL(url);
  assert(
    u.protocol === "https:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname),
    "Remote service requires HTTPS",
  );
}

/**
 * The bearer token for an API call. `CAELOGRAM_TOKEN` wins so CI can run
 * non-interactively; otherwise the stored OAuth access token is used and
 * silently refreshed when it is about to expire.
 */
async function accessToken(): Promise<string> {
  if (process.env.CAELOGRAM_TOKEN) return process.env.CAELOGRAM_TOKEN;
  const c = config();
  const deps = liveDeps();
  if (c.credentials?.accessToken) {
    if (!expired(c.credentials, deps)) return c.credentials.accessToken;
    assert(
      c.credentials.refreshToken,
      "The stored access token expired; run caelogram login",
      401,
    );
    const metadata = c.metadata ?? (await discover(serviceUrl(c), deps));
    const credentials = await refreshCredentials(
      metadata,
      clientId(c),
      c.credentials.refreshToken,
      deps,
    );
    save({ ...c, metadata, credentials });
    return credentials.accessToken;
  }
  assert(
    c.token,
    "Run caelogram login, or set CAELOGRAM_TOKEN for non-interactive use",
    401,
  );
  return c.token;
}

const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function call(name: string, input: unknown) {
  const url = serviceUrl();
  const token = await accessToken();
  requireServiceTransport(url);
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
  .version(VERSION);

program
  .command("login")
  .option("--url <url>", "Service origin", DEFAULT_URL)
  .option("--scope <scope>", "Requested scope", DEFAULT_SCOPE)
  .option("--client-id <id>", "OAuth client identifier", DEFAULT_CLIENT_ID)
  .description(
    "Authenticate through the OAuth 2.0 device authorization grant. " +
      "For CI, set CAELOGRAM_TOKEN instead of logging in; it overrides stored credentials.",
  )
  .action(async (o) => {
    const url = String(o.url).replace(/\/$/, "");
    requireServiceTransport(url);
    const deps = liveDeps();
    const id = process.env.CAELOGRAM_CLIENT_ID ?? o.clientId;
    const { metadata, credentials } = await deviceLogin(url, id, o.scope, deps);
    save({ url, clientId: id, metadata, credentials });
    console.log(
      "Authenticated. Credentials stored with owner-only file permissions at " +
        configPath,
    );
  });

program
  .command("logout")
  .description("Revoke the stored tokens and delete the local credential file")
  .action(async () => {
    const c = config();
    if (!existsSync(configPath)) return console.log("No stored credentials.");
    const deps = liveDeps();
    let revoked = false;
    if (c.credentials?.accessToken) {
      const metadata =
        c.metadata ?? (await discover(serviceUrl(c), deps).catch(() => null));
      if (metadata) {
        const id = clientId(c);
        if (c.credentials.refreshToken)
          revoked =
            (await revokeToken(
              metadata,
              id,
              c.credentials.refreshToken,
              "refresh_token",
              deps,
            )) || revoked;
        revoked =
          (await revokeToken(
            metadata,
            id,
            c.credentials.accessToken,
            "access_token",
            deps,
          )) || revoked;
      }
    }
    rmSync(configPath, { force: true });
    console.log(
      revoked
        ? "Tokens revoked and local credentials removed."
        : "Local credentials removed. The server exposed no revocation endpoint, so tokens remain valid until they expire.",
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
  .command("index-status <repoId>")
  .description("Show background indexing progress for a connected repository")
  .action(async (repoId) => print(await call("index_status", { repoId })));
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
    const url = serviceUrl() + "/mcp";
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
  const credentials = c.credentials;
  print({
    version: VERSION,
    node: process.version,
    nodeSupported: Number(process.versions.node.split(".")[0]) >= 24,
    service: serviceUrl(c),
    configPath: existsSync(configPath) ? configPath : null,
    authentication: process.env.CAELOGRAM_TOKEN
      ? "CAELOGRAM_TOKEN environment variable"
      : credentials
        ? "OAuth device grant"
        : c.token
          ? "legacy stored token"
          : "none",
    accessTokenExpiresAt: credentials?.expiresAt
      ? new Date(credentials.expiresAt).toISOString()
      : null,
    refreshTokenStored: !!credentials?.refreshToken,
    authorizationServer: c.metadata?.issuer ?? null,
    githubCredentialsRequiredInClient: false,
  });
});
program.parseAsync().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
