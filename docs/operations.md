# Operator guide

## GitHub App

Create a Caelogram-owned GitHub App in the customer's account or organization. Select only intended repositories. Configure:

- Repository Contents: read/write (read snapshots, create blobs/trees/commits/refs).
- Pull requests: read/write (find retry results, open drafts).
- Metadata: read (implicit).
- Push webhook subscription, using `/webhooks/github` and a high-entropy HMAC secret.
- Do **not** request Actions secrets, organization administration, or workflow write permissions. Changes to `.github/workflows` are rejected by the changeset API.

The app's private key belongs in a server-only secret mount. `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_FILE`, and `GITHUB_WEBHOOK_SECRET` configure it. Installation tokens are requested in the server adapter for the selected repository and never returned through API/MCP/CLI or logs.

Before allowing connection, set `CAELOGRAM_INSTALLATIONS` to a JSON object mapping trusted tenant IDs to allowed installation IDs. Example shape: `{"company-tenant":[12345]}`. The issuer determines tenant membership; the client cannot choose its own tenant. Installation binding is an operator step in this alpha, not self-service onboarding.

## Identity

Production access tokens must be signed RS256/ES256 JWTs from the configured issuer. Configure `CAELOGRAM_JWKS_URL`, `CAELOGRAM_ISSUER`, and `CAELOGRAM_AUDIENCE`, plus HTTPS `CAELOGRAM_ORIGIN`. Required claims:

```json
{
  "sub": "user-or-service-identity",
  "tenant": "trusted-tenant-id",
  "aud": "https://your-service.example",
  "iss": "https://your-issuer.example/",
  "iat": 0,
  "exp": 0,
  "scope": "read write",
  "repositories": ["owner/repository"]
}
```

The timestamps above are schema illustrations, not usable tokens. Tokens older than one hour are rejected. `publish` is a separate scope; `admin` grants all current capabilities and should not be the normal agent scope. Avoid wildcard repository grants outside administration. The server validates token signature, issuer, audience, tenant, subject, and expiry, and all resource lookups enforce repository grants.

The external authorization server must implement the actual OAuth/PKCE/registration/user-login flow compatible with target MCP clients. Caelogram serves protected-resource metadata; it does not mint production access tokens. Browser token entry and the CLI's `CAELOGRAM_TOKEN` environment fallback are functional alpha paths. Immediate revocation/introspection and organization roles remain launch gates.

### CLI device authorization

`caelogram login` implements the OAuth 2.0 device authorization grant (RFC 8628) and refreshes access tokens automatically; `caelogram logout` revokes and clears them. The client is complete and unit-tested, but **no Caelogram deployment answers those endpoints yet**. To turn it on, an authorization server must serve `/.well-known/oauth-authorization-server` with `device_authorization_endpoint`, `token_endpoint`, and preferably `revocation_endpoint`, register the public client `caelogram-cli`, and host the user-code verification page. The precise request/response and error contract is in [CLI authorization contract](cli-auth-contract.md); implement against that document rather than reading the client. Until it exists, operators issue scoped agent tokens in the console and supply them as `CAELOGRAM_TOKEN`.

## Data

Set `CAELOGRAM_DATA_KEY` to 32 cryptographically random bytes encoded as 64 hex characters. Do not reuse the GitHub key. Production source-bearing object payloads are AES-GCM encrypted; metadata IDs/audit actions are plaintext. Mount a writable `/data` volume for the Docker image, encrypted by the host/provider. Back up SQLite consistently using SQLite backup tools; copying an active DB without its WAL is not an acceptable backup procedure. Keep keys outside backups and practice restore/decryption before accepting private code.

Only one instance may own this SQLite deployment and worker. No multi-replica deployment is supported. Backups, retention of prior snapshots, and key rotation require an operator runbook until automated controls ship. Repository deletion removes live snapshots/tasks/changesets but keeps audit metadata and does not remove historical backups automatically. The feature does not delete the GitHub repository or PRs.

## Publish the CLI to npm

The npm package `caelogram` is the CLI only. `npm run build:cli` bundles `src/cli.ts` into one dependency-free executable and stages `dist/package/` with a generated manifest — the repository root is never published, because its `dependencies` are the server and console runtime (React, Express, the MCP SDK) that a CLI user must not download. `npm run pack:cli` produces the tarball for inspection; `npm run publish:cli` publishes it. A root `npm publish` is refused by a `prepublishOnly` guard.

Releases are automated: pushing a `v<version>` tag runs `.github/workflows/release.yml`, which requires `npm run check`, `npm run check:cloud`, `npm test`, and `npm run build` to pass, verifies the tag matches `package.json`, then publishes with `--provenance`. It needs one repository secret, `NPM_TOKEN` (an npm automation token with publish rights), and the workflow's `id-token: write` permission for the provenance attestation. Choose and record a license before the first publish; the manifest currently says `UNLICENSED`.

## Deploy the built service

```sh
npm ci
npm run check
npm test
npm run build
NODE_ENV=production npm start
```

Or build the supplied Dockerfile and provide the documented environment and secret mounts. Put it behind a TLS reverse proxy, deny direct public access to the internal port, and configure trusted forwarding/rate-limit behavior for that proxy. Defaults deliberately do not trust arbitrary forwarded client IP headers. Production starts only with encryption and issuer settings present.

Health endpoint: `/health`. API: `/api/tools/<tool-name>`. MCP: `/mcp` (POST). Webhook: `/webhooks/github`. CLI prints its complete command help with `caelogram --help`.

## Validation and publication

A successful static validation is not approval to merge. Configure repository rules to require CI and review. Use an isolated runner for actual tests before upgrading the draft-only policy. GitHub base refs are never updated by the service. A moved base causes conflict; begin a new task, obtain current context, and resubmit edits. Revision is never silently changed under an existing task.

Persisted webhook jobs retry at most five times. Inspect failed job rows for operational triage; a production queue UI, adaptive backoff and dead-letter replay command are not included yet. Manual `caelogram sync` is available after transient failures. Disabling an installation prevents later GitHub calls; remove its tenant binding and revoke Caelogram grants to deny local snapshot access as well. Automated uninstall revocation remains a launch gate.

## Source handling

Never put raw credentials into source, changesets, prompts, URLs, or validation logs. Environment files and key files are excluded; common hard-coded tokens/credential assignments are redacted before storage/context. This scanner is heuristic. An independent detector, tenant exclusions, quarantine, and adversarial review are required before production use with sensitive code.

Untrusted repository text does not become executable tool instructions. The control plane has no shell execution tool. The local mapper invokes Git with argument arrays, pins a resolved commit, reads tracked blobs, skips symlinks/submodules, and does not check out or run hooks/scripts. Agents with independent filesystem or GitHub access remain governed by their own client policies.
