# Verification report

Executed 2026-09-06 using Node 24.19.0. This distinguishes running code from unverified integration claims.

## Automated checks

`npm run check` passes strict TypeScript checks for server/CLI and browser code. `npm run build` produces the Node service/CLI and bundled React console. `npm test` passes 24 tests, including:

- Mapping a previously existing Git repository, reading its committed source rather than uncommitted changes or untracked credentials.
- AST declarations, `.js`-to-TypeScript relative import resolution, test-import edges, immutable revision provenance.
- Incremental reuse, removed nodes, task context pinned across branch synchronization.
- Context callers/consumers, excluded unrelated files, large-file excerpts, and estimated serialized budget including omission/explanation metadata.
- Tenant/repository authorization, read-only scopes, traversal/internal Git path rejection, sensitive-path filtering, common credential redaction.
- Encrypted payload round-trip and no plaintext source in stored ciphertext; append-only audit protection.
- Complete service lifecycle from repository connection through context, edits, validation, and publication **using a test provider**.
- Syntax/import errors, deleting a still-required module, duplicate paths, workflow edits, and missing warning acknowledgments.
- GitHub adapter request contract: exact parent commit, service branch, draft PR, repeated base checks, no default-ref mutation, stale-base rejection, and retry lookup. GitHub responses in these tests are simulated.
- Actual HTTP server authentication/origin rejection, public demo resolution, and an official MCP SDK client initializing, listing tools, and calling a tool.
- Signed webhook verification, delivery deduplication, durable queued synchronization.
- Repository-data deletion and retained audit metadata.

The VS Code extension passes Node syntax validation. The portable skill passes the skill format validator. These do not substitute for a real installed IDE/client compatibility test.

## Different repository sizes

Raw results and revisions are in [benchmark.json](benchmark.json). Existing Git repositories were cloned read-only; their code was never executed or modified. Every workload also exercised submission/validation/publication state through a clearly labeled test provider.

| Repository        | Indexed files | Symbols | Module links | Selected files/excerpts | Omitted related files | Package token estimate |
| ----------------- | ------------: | ------: | -----------: | ----------------------: | --------------------: | ---------------------: |
| Synthetic small   |             5 |       5 |            4 |                       5 |                     0 |                    562 |
| Synthetic medium  |           250 |     250 |          240 |                      11 |                     0 |                  1,168 |
| Synthetic large   |         2,500 |   2,500 |        2,400 |                      11 |                     0 |                  1,169 |
| `sindresorhus/is` |            12 |     579 |            6 |                       6 |                     0 |                  3,634 |
| `fastify/fastify` |           378 |   7,485 |          354 |                       8 |                   152 |                  4,581 |

The token estimate is UTF-8 bytes/3, including bounded serialized context metadata. It is not a tokenizer-specific bill or a measured reduction against an agent baseline. Small repositories can require more context tokens than their raw source because explanations have overhead. The Fastify result deliberately exposes many omissions; it is not claimed to be sufficient for a correct Fastify patch.

One-run mapping times were approximately 0.55 seconds for `is` and 4.04 seconds for Fastify in this environment. No stable latency SLA is inferred. Reindexing reused all eligible unchanged files; resolving all imports still has measurable CPU cost.

Reproduce:

```sh
npm run benchmark -- /path/to/is /path/to/fastify
```

Synthetic inputs are generated in the benchmark script and labeled. Real revisions are pinned in the report, so later default branches may give different results. Context precision/recall, true agent token usage, accepted patch quality, review corrections, and PR acceptance rate are **not measured yet**.

## Browser verification

The console was opened in the supported browser preview and inspected at desktop size. The loaded sample contains exactly 24 file bodies, 26 declarations, and 22 module relationships. The inspector displays real paths, incoming/dependency counts, test-import evidence, unknown coverage, and the indexed commit. The palette was revised to neutral dark slate, grays, warm white, and gold with no blue.

Browser interactions verified: navigation into Task context, resolving the payment/checkout task, visible per-file reasons and omitted dependency warning, resetting the map, switching to Components, and filtering the component table for gateway. The 3,000-token demo request returned 14 selected files at 1,892 estimated package tokens and explicitly omitted one related file. Browser authentication with a live issuer, an installed IDE webview, and physical touch-device behavior are not claimed as verified. CSS includes responsive and reduced-motion behavior; a complete assistive-technology audit is a release gate.

## External boundaries

- No Caelogram-owned GitHub App private key or installation was provisioned during this build. A real App-authenticated import → PR → webhook round trip remains required before production launch.
- Automatic approval review rejected initializing the empty target repository's default `main` branch. No workaround was used. Code is prepared as local commits for review; publishing requires explicit approval of that bootstrap step.
- No hosted production service was deployed, no default branch was overwritten, and no external repository was modified by the benchmark.
- Static validation deliberately does not execute third-party tests or install repository dependencies. Tests/typechecks on submitted customer code remain `not_run` until an isolated runner is integrated.

## Cloudflare and orbital extension — 2026-09-06

All 30 integration/unit tests pass after adding self-service authentication. Strict TypeScript checks pass for Node, browser, and Cloudflare sources. The production browser build and Wrangler dry-run bundle pass. The orbital JavaScript chunk is lazy loaded (~141 KB compressed); the Worker is ~1.9 MB compressed.

## Self-service account verification

New automated coverage verifies signed Clerk identity mapping, wrong authorized-party rejection, expiration, ignored caller-controlled tenant/grant claims, OAuth browser binding and single-use callback state, encrypted GitHub token rotation, suspended/read-only/archived repository filtering, agent scope restrictions, tenant isolation and expiration. GitHub responses and Clerk signing keys are test fixtures, not live account integration evidence. The actual bundled Worker also serves public configuration and a recoverable callback error page without exposing credentials.

The browser preview confirms the account-first connection entry and preserves the real sample's 24-file orbital and heatmap views. No Clerk application keys were provided, so provider sign-in, embedded Clerk form rendering with the configured providers, and live GitHub installation/PR acceptance remain unverified. Follow the live checklist in [authentication](authentication.md) before opening registration to customers.

The Cloudflare HTTP test executes the actual Wrangler-generated bundle in workerd/Miniflare. It verifies public mapping, task resolution, origin rejection, fail-closed auth, protected-resource discovery and no-store headers. This caught and fixed TypeScript's CommonJS filename assumptions at Worker startup. D1/R2 tests exercise encrypted real storage, tenant-bound AEAD, the complete changeset workflow with a GitHub provider double, duplicate publication, durable mutation locks, audit immutability and offline physical deletion.

Desktop browser checks covered Orbit/Heatmap switching, spin/pause and keyboard orbit/zoom. A real 390×844 iframe viewport supplied mobile CSS review because the browser cannot resize. The Impeccable reviewer requested a more compact mobile header; the recaptured view shows the full galaxy and controls and the reviewer scored that fix resolved. Hardware WebGL is disabled in this preview browser: the software perspective renderer was inspected; hardware shader output still needs testing on a GPU-enabled browser. These checks do not establish live Cloudflare deployment or GitHub App acceptance.
