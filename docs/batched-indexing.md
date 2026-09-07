# Background indexing

Inventory and throughput behavior is updated by migration 0005; see [Inventory and performance](inventory-and-performance.md) for current coverage and limits. The details below describe the original 0004 implementation.

Repository connection now creates a D1 job and returns progress immediately. The cloud path does not download or serialize a complete repository. Cloudflare Queues runs five bounded work items per invocation; the existing minute cron also acts as a durable outbox/recovery scanner. A failed queue notification cannot lose a D1 job.

## Deployment

Before deploying the new Worker, from the current repository checkout run:

```sh
npx wrangler queues create caelogram-index
npx wrangler d1 migrations apply caelogram --remote
```

Create the queue only once. Migration 0004 is additive and must be applied before the Worker code starts. The committed Wrangler configuration binds INDEX_QUEUE as producer and consumer, with one message per invocation and consumer concurrency one. Then use the existing Cloudflare Git deployment. No new secret values, Clerk application, GitHub App, Fly account, or R2 bucket are required.

Without a queue binding, the same processor works through the cron fallback, at a slower rate. The committed deployment uses the queue. Existing monolithic maps can still be read; reconnecting or synchronizing produces a new sharded map.

## Limits and scale

- At most 2,000,000,000 bytes (decimal 2 GB) of eligible source and 100,000 files per repository revision.
- Each file is at most 256,000 bytes. Dependencies, build directories, sensitive paths, unsupported formats, and larger files are excluded during discovery. The exclusion count is visible; excluded directory entries can represent entire excluded subtrees.
- A directory may contain up to 10,000 immediate entries. Truncated GitHub responses fail explicitly.
- At most 500 declarations per file and one million newly extracted symbols per revision; excessive parser output fails explicitly instead of publishing an incomplete graph.
- Source is individually encrypted in R2. D1 holds job checkpoints, paths, hashes, bounded declaration metadata and edges, never source bodies.
- Map pages contain up to 50 files. Total repository counts remain accurate; visible counts and omitted cross-page edges are disclosed. Search selects another page by path.
- Task/validation neighborhoods hold at most 24 files and 4 MB of source. Excessive dependency fanout rejects the task with an instruction to split it; it does not silently remove dependencies and claim validation succeeded.

This is a total source allowance, not a claim that an individual file or a 2 GB graph fits in memory. GitHub API quotas can pause large ingestions. Rate-limit resets are respected and the minute scanner resumes eligible jobs. Node CLI indexing retains its separate existing limits.

## Revision and recovery model

Discovery walks nonrecursive Git trees at one exact commit. Each directory has a persistent checkpoint. Files are fetched, parsed and encrypted separately. Unchanged files reuse prior encrypted content and declaration metadata. Relationship resolution runs only after discovery and parsing finish. A new revision becomes visible only after all three phases succeed; the previous complete map stays available until then. Task access resolves the exact completed revision pinned to the task.

Each slice claims a 120-second lease with a unique owner token. All progress and publication SQL statements check that token. A worker returning after another worker acquired its expired lease cannot checkpoint, publish, or release the new lease. Indexing no longer uses the legacy tenant mutation lock. Ordinary changeset/publication locks must not be stolen based solely on elapsed time; the previous ten-minute automatic deletion was removed.

Transient failures retry; a failed job at the same revision resumes its checkpoints when connected again. GitHub access is rechecked for each slice. Deletion cancels job ownership and removes current map access immediately, then processes file cleanup in background slices. Encrypted orphan objects from a process that lost its lease after an R2 write may require offline retention cleanup; they are never returned as indexed files. Audit records remain retained.

## Validation evidence

The integration fixture exercises more than 23.5 MB of source, per-file ciphertext, paging, bounded task retrieval, deletion-consumer rejection, incremental reuse, old task revisions and retry recovery. A second fixture bundles the implementation and completes a 24 MB map in the local workerd runtime across separate requests. These are synthetic local tests, not production benchmarks. Full 2 GB ingestion and a customer's private repository have not been exercised in this environment. A branch update received while its previous index is still running can require an explicit synchronization after completion; coalescing those updates into a guaranteed follow-up job remains outstanding.

## Fly.io decision

Keep the public app, authentication, policy, D1 and R2 on Cloudflare for this implementation. A Fly Machine is a suitable future compute worker for larger ASTs, additional languages, git history analysis or isolated validation. Its RAM can be sized independently from edge request handling. Batching, checkpoints, bounded context retrieval and fenced publication remain necessary on a VM.

A future Fly worker should claim scoped jobs through the control service and receive short-lived repository-specific credentials, with source and checkpoints persisted to R2/D1. Do not expose global GitHub installation credentials to agents or rely on a single Fly volume as the durable repository store. No Fly resources are provisioned by this change.

References: https://developers.cloudflare.com/queues/platform/limits/ ; https://developers.cloudflare.com/workers/platform/limits/ ; https://fly.io/docs/reference/configuration/ ; https://fly.io/docs/volumes/overview/
