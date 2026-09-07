# Caelogram

**The living map between your AI and your code.**

Caelogram is a provider-independent context and change layer for **existing GitHub repositories**. GitHub remains canonical. Agents receive bounded structural context and submit explicit changesets; a GitHub App opens draft pull requests at an exact base commit.

This repository contains an executable alpha, not a production SaaS launch. See [architecture](docs/architecture.md), [integration research](docs/integrations.md), [implementation status and launch gates](docs/roadmap.md), and [verification](docs/verification.md).

## Run

Node.js 24 or newer is required.

```sh
npm ci
npm run dev
```

Open `http://localhost:5173`. The initial console maps the included Orbit Shop sample using the actual indexing engine. Task resolution is real; sample publication is disabled. The dev server prints a development-only Caelogram access token; open `/?local=1` to use the legacy development session form. Public onboarding is the default UI; use the Cloudflare adapter and configure Clerk for real browser sign-in. Do not expose the dev server to the Internet.

```sh
npm run check
npm test
npm run build
npm start
```

The built API and console use port 4310. Production startup requires encryption and OIDC configuration; see [operations](docs/operations.md).

## Map an existing repository

No reorganization or modifications to tracked source files are required. Local mapping reads **committed Git objects**, not dirty working-tree files, and never executes repository code.

```sh
npm run cli -- map /path/to/existing/repository
npm run cli -- map /path/to/existing/repository --ref main --task "Change payment retry handling"
```

Mapping writes metadata (no source bodies) to `.caelogram/map.json` in that checkout. Add `.caelogram/` to its local exclude file if desired. The MVP accepts up to 5,000 eligible text files / 25 MB; unsupported files, credential files, symlinks, submodules, generated/vendor directories, and files larger than 256 KB are excluded.

## Install the CLI

Node 24 or newer and Git are required, on Windows, macOS, and Linux. The published package is the CLI alone: a single bundled executable with no runtime dependencies.

```sh
npx caelogram@latest map /path/to/existing/repository
npm install --global caelogram
```

The package is not published yet; until it is, build it from this checkout with `npm run build:cli` and run `npm link`, or run commands through `npm run cli -- …`.

## Connect GitHub and use the controlled workflow

For the Cloudflare application, follow [Clerk and self-service GitHub setup](docs/authentication.md). Anyone can sign up, authorize the public GitHub App, choose an existing repository and branch, and map it. Map through the browser first; the operator-only `connect --installation` command is for the legacy JWT adapter. The CLI only ever holds a **Caelogram** credential, never a GitHub token.

```sh
caelogram login --url https://your-caelogram-service.example
caelogram logout
caelogram begin REPOSITORY_ID "Add payment retry handling"
caelogram submit TASK_ID edits.json --title "Handle payment retries"
caelogram validate CHANGESET_ID
caelogram publish CHANGESET_ID --acknowledge-warnings
caelogram status
caelogram sync REPOSITORY_ID
caelogram doctor
```

### Signing in

`caelogram login` runs the OAuth 2.0 device authorization grant (RFC 8628). It discovers the authorization server from `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` at the service origin, prints a short user code and a verification URL, polls until you approve in the browser, and stores the access and refresh tokens in `~/.config/caelogram/config.json` with owner-only permissions. The access token is refreshed automatically before it expires; `caelogram logout` revokes the tokens and deletes the file.

**This flow needs an authorization server that Caelogram does not yet run.** The client is implemented and tested; the device authorization, token, and revocation endpoints are not. The exact contract the server must meet is [docs/cli-auth-contract.md](docs/cli-auth-contract.md). Until it exists, use the non-interactive fallback: set `CAELOGRAM_TOKEN` to an agent token created in Access & integrations. That variable overrides stored credentials, is never written to disk, and is the supported path for CI and containers.

`edits.json` is an array of `{ "path": "src/file.ts", "content": "full replacement source" }`; `null` deletes a file. Existing consumers and newly unresolved imports are checked. Syntax checks **do not mean tests or typechecks passed**. All PRs remain drafts.

## AI integrations

The service exposes authenticated Streamable HTTP MCP at `/mcp` using the official TypeScript SDK. Fourteen focused tools cover repository connection, context, fallback search, changesets, validation, and publication.

```sh
caelogram init --client claude
caelogram init --client codex
caelogram init --client cursor
```

These print configuration for review, without overwriting agent settings. Portable instructions are in `integrations/skills/caelogram`. The VS Code/Cursor-compatible extension source in `integrations/vscode` supplies a repository tree and secure, script-free inspector panel. See the integration guide for packaging and client limitations.

## What is proven today

- Deterministic file/declaration extraction and relative module imports for JavaScript/TypeScript.
- Commit-pinned source, tenant-scoped records, encrypted production payloads, scoped JWT access, source filtering, and append-only audit records.
- Task ranking and bounded two-hop context, explicit omissions, impact expansion, justified source reads/search.
- Changeset validation, unique service branches, exact-base checks, draft PR creation, and retry recovery.
- Signed, deduplicated GitHub push webhooks with a durable single-process retry queue and incremental blob/declaration reuse.
- A truthful galaxy with pan/zoom/rotation, semantic symbol detail, a component table, task illumination, provenance, and uncertainty.

See the verification report for actual test results and boundaries. Secret detection is heuristic, static relationships are incomplete, and production launch requires the documented security and operations gates.

## Cloudflare and orbital map

The console now offers **Orbit**, **Heatmap**, and **Components** views over the same real index. Orbit supports textured planets/stars, perspective rotation, pan, zoom, selection, optional spin, and a software-rendered fallback for devices without WebGL. Larger maps show counted regions that open into file bodies. No decorative repository entities are generated.

Workers, D1, and private encrypted R2 deployment is configured in `wrangler.jsonc`. Follow [Cloudflare deployment](docs/cloudflare.md) to provision account resources, apply migrations, and configure identity and GitHub App secrets. `npm run cloud:check` bundles without deploying.
