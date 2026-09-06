# Implementation status and launch gates

## Shipped executable alpha

- Existing local Git checkout mapping and existing GitHub repository/branch connection.
- JS/TS AST declarations, relative imports/re-exports, test-import edges, immutable revisions.
- Blob reuse, declaration reuse, deletion handling, signed push delivery deduplication and persisted retry jobs.
- Lexical task seeds, bidirectional structural expansion, bounded source excerpts, reasons, omitted context, justified reads and literal search.
- Tenant-scoped durable records, JWT scopes/repository claims, optional development token, production encryption requirement.
- Changeset submission, syntax/import validation, stale-base guards, idempotent draft PR adapter.
- Fourteen remote MCP tools, CLI, portable agent skill, IDE panel source.
- Marketing overview, sample demonstration, embedded Clerk account screens, self-service GitHub OAuth/installation selection, galaxy, table, context, validation, history, audit, and access/data controls.
- Personal workspace isolation, live user/App repository grant intersection, encrypted GitHub token rotation, and hashed/revocable 1–8 hour repository-scoped agent credentials.
- Automated security/workflow tests, real existing-repository mapping benchmarks, labeled synthetic scaling checks, and browser demo verification.

## Milestone 1: private deployment readiness

1. Register a Caelogram-owned GitHub App; connect a sandbox repository with installation credentials, verify real import → proposed edit → validation → draft PR → webhook reindex. Connector access used by the coding assistant is not equivalent to this product's App installation.
2. Configure Clerk and the public GitHub App using [authentication setup](authentication.md), verify live provider sign-in and two-account isolation. Embedded browser login is implemented; automatic MCP OAuth client registration and CLI device authorization remain deferred.
3. Move CPU indexing to a constrained worker process; queue initial imports with meaningful progress. Add rate-limit-aware backoff, job dead-letter visibility, cancellation, webhook uninstall/access revocation, and periodic reconciliation.
4. Add a trustworthy secret scanner and source quarantine, content-addressed extractor versioning, configurable exclusions, prompt-injection tests, and public security documentation. Do not market regex redaction as a guarantee.
5. Run independent tenant-isolation and authorization review. Add access-token revocation enforcement, per-tenant/request quotas, structured failure logging without source, dependency updates, backup and restore drills, and retention purge (including backups).
6. Pin hardened deployment images and CI actions; configure TLS, encrypted volumes, secret mounts, monitoring, and required GitHub branch checks.

## Milestone 2: prove better accepted changes

- TypeScript program/project resolution, path aliases, package exports, and exact symbol references/call targets where supported.
- Isolated typecheck/test recipes, signed validation records tied to base/edit digest, dependency proxy/cache with denied ambient credentials.
- Seeded benchmark tasks with human-labeled necessary files/symbols, baseline agent runs, actual model token usage, accepted-patch timing and outcomes.
- Measure exploration tokens, source exposure, tool calls, context precision/recall, omitted dependencies, test success, reviewer corrections, PR acceptance, index lag, and synchronization latency. Current counters/estimates cannot establish those product-wide outcomes.
- Add task-level policies for required consumers/contracts/tests; warning severity calibrated against false positives.

## Milestone 3: shared cloud and richer understanding

- PostgreSQL RLS and indexed adjacency; KMS object storage; durable queue with backoff and fair scheduling; horizontal API scaling.
- Organization/member lifecycle, retention UI, installation onboarding and permissions reconciliation.
- Test coverage ingestion with revision validation, Git history co-change edges, framework endpoints/events/env-name/schema extractors with explicit provenance.
- Dense-map aggregation/WebGL, spatial search, finer semantic zoom, non-color encodings, touch and assistive-technology testing, native MCP app panels where supported.
- Python and additional language adapters behind the graph contract.

## Deferred deliberately

Runtime tracing, general multi-repository dependency resolution, automatic dead-code deletion, claims of proven unreachable code, coding models, automatic merging, production deployment control, billing, autonomous updates, and unrestricted remote workspaces. GitHub remains canonical; credentials never belong in the agent-facing tool layer.

## Unresolved risk register

| Risk                                             | Current behavior                                     | Required decision/evidence                                 |
| ------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------- |
| Dynamic dependency omission                      | Explicit uncertainty and fallback                    | Framework-specific evaluation corpus                       |
| Large-file context omission                      | Bounded excerpts and explicit line ranges            | Task precision/recall plus contract-level slices           |
| Default-branch publication race                  | Exact-parent service branch; two head checks         | Accept stale-base draft semantics vs stronger merge policy |
| App credentials absent in this build environment | Adapter and test provider coverage                   | Live App integration acceptance test                       |
| SQLite application isolation                     | Tenant-scoped lookups, encrypted objects             | RLS migration and penetration test before shared hosting   |
| Regex secret filtering                           | Common-pattern redaction and blocked sensitive paths | Scanner/quarantine launch gate                             |
| Untrusted code execution                         | No execution, tests marked not_run                   | Sandboxed runner and adversarial tests                     |
| Full client panel parity                         | IDE panel source, external console elsewhere         | Real host packaging/compatibility tests                    |
| Production readiness                             | Alpha, fail-closed startup config                    | All milestone 1 gates; no claim of a finished hosted SaaS  |
