# Inventory, framework coverage, and throughput

This revision fixes the dropped-file inventory and per-file symbol failure. It does not claim full semantic understanding of every language or proprietary framework.

## Coverage

Every non-directory Git entry is retained at its exact revision: path, SHA, size, file node and, when contents are excluded, a reason. Directory traversal no longer skips dependency subtrees: their files are listed but not downloaded. Images, binaries, submodules, symlinks, generated output, sensitive paths and large files remain selectable. Incoming literal references can point to metadata-only nodes. Sensitive file contents are never requested. Unknown UTF-8 source/configuration extensions are read under the same size/secret policies; binary detection falls back to metadata.

The page shows up to 50 files and includes per-node analysis/reason attributes. Reference confidence and evidence are preserved. Absolute web paths try repository root, public, and wwwroot candidates; this is a heuristic, not proof of routing. Computed asset names and dynamic discovery remain unknown.

C#/.NET: lexical class/interface/struct/enum/record declarations, explicit MSBuild ProjectReference and resource/include paths, and solution project paths. This is NOT Roslyn semantic binding, method/call resolution, implicit Compile globs, conditional MSBuild evaluation, Razor compilation, dependency injection, or proof of dead code. Validation reports language checks that were not run. A future isolated .NET worker should use Roslyn without executing arbitrary MSBuild targets in the control service.

Trusted extractors implement the Extractor interface in src/inventory.ts. For proprietary relationships, repositories can include this non-executable manifest:

```json
{"version":1,"relationships":[{"from":"app.custom","to":"images/logo.png"}]}
```

Path: `.caelogram/relationships.json`. Both paths must exist in the inventory, remain inside the repository, and there may be at most 1000 entries. These are repository-declared, unverified relationships (confidence 0.5), not instructions or trusted policy.

## Limits and graceful detail reduction

Total allowance remains 2 GB eligible source and 100,000 non-directory inventory entries. Source per file remains 256,000 bytes; larger files are inventoried with an explicit reason. TypeScript symbol detail allows 2000 nodes per file; excessive detail retains the redacted source and file node with an incomplete-analysis warning instead of stopping the entire map. Bounded context limits remain. Metadata-only replacements/deletions cannot pass the text changeset validator.

## Throughput and costs

Discovery first requests the recursive Git tree (metadata, not a repository source download). Above 10,000 returned entries or on truncation it falls back to persistent nonrecursive directory traversal. This bounds Worker memory even though GitHub allows a larger response. Up to eight source blobs are fetched concurrently; parsing and fenced checkpoints remain sequential. Slices now process up to 40 items or 45 seconds, whichever comes first, amortizing authorization and queue overhead. Credentials and leases are never given to agents. No additional paid service or model inference is introduced.

Two minutes is a performance target for a representative source repository, not a guarantee for every 2 GB repository. Remote GitHub/D1/R2 latency, rate limits, directory count, file count and syntax density all matter. Local mocked tests cannot establish production timing. Large-repository performance must be measured against the user's real repository after deployment. If the target remains unmet, the next step is one inexpensive ephemeral compute worker that downloads a Git snapshot once and parses on local disk; simply raising Cloudflare memory limits is not possible.

## Deployment

Apply migration `0005_inventory.sql` before deploying this revision. The queue and existing secrets stay the same. Reconnect a previously failed index: jobs created by the older extractor version start fresh discovery, so previously dropped files enter the new inventory. Reconnecting an active old-version job fences out its former owner and starts a replacement inventory. New successful revisions also invalidate old extraction caches by analyzer version.

References: https://docs.github.com/en/rest/git/trees#get-a-tree ; https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/compiler-api-model
