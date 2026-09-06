# Cloudflare deployment

The same domain service runs locally on Node/SQLite and remotely on Workers/D1/R2. No Node server, filesystem database, or installation token is shipped to the browser. This is an alpha deployment target, not a completed managed SaaS launch.

## Provision and deploy

Use Node 24 and a Cloudflare account with Workers Paid for the configured 30-second CPU budget. Run in the repository root:

```sh
npm ci
npx wrangler login
npx wrangler d1 create caelogram --binding DB --update-config
npx wrangler r2 bucket create caelogram-private
npm run cloud:migrate
```

The D1 creation command writes the real database ID into `wrangler.jsonc`. For an existing database, put its ID in the existing DB binding instead of creating another one. The R2 bucket must remain private: do not enable an r2.dev URL or public custom domain.

Set `PUBLIC_ORIGIN` in `wrangler.jsonc` to the final HTTPS application origin, with no trailing slash. Follow [Clerk and self-service GitHub setup](authentication.md): this is the recommended public onboarding path. Every Clerk user receives an isolated personal workspace and chooses their own GitHub App repositories. Leave `INSTALLATIONS` as `{}` in Clerk mode; repository and installation grants are derived server-side from GitHub, not user-entered IDs.

```sh
npx wrangler secret put DATA_KEY
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_PRIVATE_KEY
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put CLERK_PUBLISHABLE_KEY
npx wrangler secret put CLERK_ISSUER
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_APP_SLUG
npm run cloud:deploy
```

`DATA_KEY` is 32 random bytes encoded as 64 hex characters. Supply the full PEM for `GITHUB_PRIVATE_KEY`; this target uses a secret binding, not the Node adapter's key-file path. Keep an encrypted recovery copy of the data key. Losing it makes source payloads unreadable. Never place real secrets in git, shell arguments, screenshots, MCP output, or browser storage.

Configure the GitHub App webhook to `https://YOUR_ORIGIN/webhooks/github`, subscribe to push events, and use the same webhook secret. Repository permissions: metadata read, contents read/write, pull requests read/write. Workflow writes are rejected. Set the OAuth callback to `https://YOUR_ORIGIN/auth/github/callback`, the post-install setup URL to `https://YOUR_ORIGIN/?connect=github`, and allow installation by any account. See [authentication](authentication.md) for the full checklist. The GitHub App OAuth client secret is different from the App private key; both stay exclusively in Worker secrets.

An operator-managed legacy JWT path is still available when `CLERK_ISSUER` is absent. It requires `JWKS_URL`, `ISSUER`, `AUDIENCE`, explicit tenant/repository/scope claims, and a server-owned `INSTALLATIONS` mapping. Do not combine that onboarding model with the Clerk user flow. The Node development adapter uses this legacy path; use Wrangler to test Clerk.

## Local runtime

```sh
npm run build
npx wrangler d1 migrations apply caelogram --local
npm run cloud:dev
```

The public example and task resolver work without credentials. Protected routes fail closed until identity and data-key bindings exist. Copy `.dev.vars.example` to `.dev.vars` only for local real-repository integration; it is ignored by git. `npm run cloud:check` validates types and bundles the Worker without deploying.

## Storage and concurrency

D1 holds tenant-keyed object references, append-only audit events, webhook jobs, and mutation locks. Source-bearing repository snapshots, task context, and changesets are AES-GCM encrypted in private R2. Associated authenticated data binds each payload to tenant, object kind, and ID; moving a pointer between tenants does not make it decryptable.

R2 writes use new immutable random keys, followed by transactional D1 pointer publication. Failed or superseded objects enter a garbage collection ledger. Repository deletion removes active pointers and tasks immediately, retaining audit history. Physical payload deletion currently requires the offline collector (`CloudStore.collectOffline`) with all mutations stopped. Automated retention and cryptographic key rotation remain launch gates; do not promise immediate physical deletion or a configured retention SLA.

Mutations serialize per tenant in D1, including MCP calls. Locks have no automatic expiry: after a Worker crash an operator must confirm the invocation has terminated before deleting its specific lock. This trades availability for avoiding stale writers. Inspect `locks` and failed `jobs` during operations. Do not blindly delete all locks while requests are running.

Cron processes deduplicated push jobs once per minute, up to three deliveries per run, with five attempts before a failed state. Overlapping schedulers are rejected by a durable lock. Reindexing reuses unchanged blobs and declarations. In Clerk mode, every protected source request and synchronization checks the intersection of the user's and App's current GitHub permissions. Expiring GitHub access and refresh tokens are encrypted in R2 and rotated server-side. Disconnecting removes active GitHub credentials and revokes all agent tokens for that workspace. Existing encrypted indexes remain until explicitly deleted.

## Boundaries and validation

- The existing ingestion limits remain 5,000 eligible files / 25 MB, but Workers CPU, memory, and subrequest limits can reject a repository earlier. The previous index remains intact when extraction fails. Larger initial ingestion needs a resumable job pipeline before a production SLA.
- D1/R2 list operations have an explicit 1,000-record alpha limit. Whole-graph R2 reads are intentionally simple; normalized graph tables and metadata summaries should precede high-volume deployments.
- Rate limiting is 120 requests/minute/IP at Cloudflare's rate-limit binding; it is a coarse abuse control, not tenant billing metering.
- Validation performs syntax, path, secret-pattern, and dependency checks. It never executes untrusted code in a Worker. Publication creates draft PRs; GitHub CI and human review must gate merge.
- Embedded Clerk signup/login/account management and GitHub OAuth onboarding are implemented. CLI/MCP use repository-scoped, hashed, revocable tokens expiring in 1–8 hours; automatic MCP OAuth registration and CLI device flow remain deferred. Clerk browser sessions are checked using short-lived signed JWTs, not a live session lookup on every request.
- Local tests use real Miniflare D1/R2 and a GitHub provider double for publication. A live GitHub App-to-Cloudflare acceptance run still requires account configuration.

## Primary references

[Workers configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [R2 bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/). Configuration and SDK capabilities were checked against current documentation and installed tool declarations on 2026-09-06.
