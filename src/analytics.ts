/**
 * Analytics: durable capture of what every surface served, and honest
 * aggregation of it.
 *
 * Design rules this file is held to:
 *
 * 1. **Never on the critical path.** `record()` appends to an in-memory buffer
 *    and returns synchronously. `flush()` writes the buffer and can never
 *    throw: a failed analytics write increments `dropped` and the request
 *    proceeds. Nothing in a tool call ever awaits a successful analytics write.
 * 2. **Never source, never secrets.** Only repository-relative paths,
 *    identifiers, counts, durations and short refusal *classes* are stored.
 *    Task prompts, file content, diffs, snippets, tokens and headers are not.
 *    `safeReason()` truncates and strips anything that looks like a value.
 * 3. **Workspace scoped.** Every row carries the workspace tenant that owned
 *    the request, every read binds it, and a report is produced for exactly one
 *    tenant. Collaborators share a workspace's analytics because they already
 *    share its index; two workspaces never see each other's rows.
 * 4. **Estimates, not billing.** Every token number here comes from `tokens()`
 *    in graph.ts (UTF-8 bytes / 3). It is an ingestion-size estimate and is
 *    labelled as such wherever it is surfaced.
 *
 * ## Retention and aggregation policy
 *
 * - `analytics_events` and `analytics_paths` are retained for
 *   {@link RETENTION_DAYS} days (90). `prune()` deletes older rows in bounded
 *   batches; it is safe to call from any scheduled job.
 * - Path attribution (`analytics_paths`) is the highest-cardinality table and
 *   the most sensitive (it names files). It is retained for
 *   {@link PATH_RETENTION_DAYS} days (30) — long enough for "most requested
 *   files" and "delivered but never pulled", short enough that a workspace's
 *   file-access history is not kept indefinitely.
 * - Aggregation is computed at read time over a bounded window, never
 *   pre-aggregated into a second source of truth that could drift from the
 *   events. Latency percentiles use the most recent {@link SAMPLE} tool events
 *   in the window, and the report says so.
 * - Deleting a repository does not delete its analytics rows; call
 *   `forgetRepository()` for that. The audit table remains the append-only
 *   record and is deliberately untouched by any of this.
 */
import { impact, tokens } from "./graph.js";
import type { Graph } from "./types.js";

export const RETENTION_DAYS = 90;
export const PATH_RETENTION_DAYS = 30;
/** Most recent tool events sampled for latency percentiles. */
export const SAMPLE = 4000;
/** Path rows recorded for a single call. Enough for a whole context package. */
export const PATHS_PER_EVENT = 200;
/** Flush automatically once this many events are buffered. */
export const BUFFER_LIMIT = 50;
export const ESTIMATE_NOTE =
  "Token counts are Caelogram estimates (UTF-8 bytes ÷ 3), not model token billing.";
export const BASELINE_ASSUMPTION =
  "Baseline = the estimated tokens of the files the change actually touched plus their two-hop static dependency closure, read whole at the task's base commit. It is not the whole repository, and it assumes an agent with no Caelogram would have read those files in full.";

/** One captured event. Everything here is a count, an id, a path or a class. */
export interface AnalyticsEvent {
  tenant: string;
  /** Which surface produced it: tool | mcp | console | http | index | github. */
  surface: string;
  /** Tool name, route template, index phase, or "pull_request". */
  operation: string;
  repoId?: string | null;
  taskId?: string | null;
  actor?: string | null;
  /** Agent client identifier when the surface supplies one. */
  client?: string | null;
  outcome: "ok" | "refused" | "error";
  status?: number;
  /** Short refusal/error class. Never a source fragment. */
  reason?: string | null;
  estimatedTokens?: number;
  omittedCount?: number;
  /** The cap the surface applied, restated from `accounting.bound`. */
  bound?: string | null;
  latencyMs?: number;
  bytes?: number | null;
  /** Small JSON facts. Counts and identifiers only. */
  detail?: Record<string, unknown> | null;
  at?: number;
  paths?: { path: string; role: string; estimatedTokens?: number }[];
}

interface Statement {
  sql: string;
  params: unknown[];
}
/** The only database capability analytics needs. Both D1 and node:sqlite fit. */
export interface AnalyticsSql {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  write(statements: Statement[]): Promise<void>;
  /** True when a migration owns the schema (D1); false when we create it lazily. */
  managed: boolean;
}

/**
 * Schema. Mirrored verbatim by cloudflare/migrations/0008_analytics.sql — keep
 * the two in step. One statement per line: the migration runner splits on
 * newlines.
 */
export const ANALYTICS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS analytics_events(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, at INTEGER NOT NULL, surface TEXT NOT NULL, operation TEXT NOT NULL, repo_id TEXT, task_id TEXT, actor TEXT, client TEXT, outcome TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 200, reason TEXT, estimated_tokens INTEGER NOT NULL DEFAULT 0, omitted_count INTEGER NOT NULL DEFAULT 0, bound TEXT, latency_ms INTEGER NOT NULL DEFAULT 0, bytes INTEGER, detail TEXT)",
  "CREATE INDEX IF NOT EXISTS analytics_events_window ON analytics_events(tenant, at DESC)",
  "CREATE INDEX IF NOT EXISTS analytics_events_repo ON analytics_events(tenant, repo_id, at DESC)",
  "CREATE INDEX IF NOT EXISTS analytics_events_task ON analytics_events(tenant, task_id, at)",
  "CREATE TABLE IF NOT EXISTS analytics_paths(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, at INTEGER NOT NULL, repo_id TEXT, task_id TEXT, path TEXT NOT NULL, role TEXT NOT NULL, estimated_tokens INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS analytics_paths_window ON analytics_paths(tenant, at DESC)",
  "CREATE INDEX IF NOT EXISTS analytics_paths_task ON analytics_paths(tenant, task_id)",
];

const uid = () =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

/**
 * Reduce a thrown message to a short, storable class. Refusal messages are
 * written by us and safe, but an error from a dependency could carry a
 * fragment of anything, so it is truncated hard and quoted/bracketed spans are
 * dropped rather than stored.
 */
export function safeReason(input: unknown): string | null {
  if (input == null) return null;
  const raw = typeof input === "string" ? input : String(input);
  const stripped = raw
    .replace(/["'`][^"'`]{0,400}["'`]/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  return stripped ? stripped.slice(0, 160) : null;
}

/** Group rows into as few multi-row INSERTs as the parameter limit allows. */
function rowsToStatements(
  prefix: string,
  columns: number,
  rows: unknown[][],
  perStatement: number,
): Statement[] {
  const tuple = `(${Array.from({ length: columns }, () => "?").join(",")})`;
  const out: Statement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    out.push({
      sql: `${prefix}${chunk.map(() => tuple).join(",")}`,
      params: chunk.flat(),
    });
  }
  return out;
}

/** Bound a free-form path before it is stored. Paths are data, never content. */
const safePathValue = (p: unknown) => String(p ?? "").slice(0, 400);

/**
 * Buffered, failure-tolerant event capture plus the read side of the analytics
 * layer. One instance per service.
 */
export class Analytics {
  private events: AnalyticsEvent[] = [];
  private ready = false;
  private inflight: Promise<number> | null = null;
  /** Events lost to write failures since process start. Reported, never hidden. */
  dropped = 0;
  lastError: string | null = null;
  /**
   * Optional hook so a host with `ctx.waitUntil` can keep the isolate alive
   * until the buffered write lands. Unset, flushing is fire-and-forget.
   */
  defer?: (work: Promise<unknown>) => void;
  constructor(public sql: AnalyticsSql) {}

  /** Append one event. Synchronous, allocation only; never awaits, never throws. */
  record(event: AnalyticsEvent) {
    try {
      this.events.push({ at: Date.now(), ...event });
      if (this.events.length >= BUFFER_LIMIT) this.schedule();
    } catch {
      this.dropped++;
    }
  }

  /** Ask for a flush without waiting for it. Safe to call on every request. */
  schedule() {
    if (!this.events.length) return;
    if (this.inflight) return this.inflight;
    const work = Promise.resolve().then(() => this.drain());
    this.inflight = work;
    void work.then(() => {
      if (this.inflight === work) this.inflight = null;
    });
    this.defer?.(work);
    return work;
  }

  /**
   * Write everything buffered, including anything a scheduled flush is still
   * writing. Resolves with the number of rows this call wrote; never rejects.
   */
  async flush(): Promise<number> {
    const pending = this.inflight;
    if (pending) await pending;
    return this.drain();
  }

  private async drain(): Promise<number> {
    if (!this.events.length) return 0;
    const batch = this.events.splice(0, this.events.length);
    try {
      await this.ensure();
      const events: unknown[][] = [];
      const paths: unknown[][] = [];
      for (const e of batch) {
        const at = e.at ?? Date.now();
        events.push([
          uid(),
          e.tenant,
          at,
          e.surface,
          e.operation.slice(0, 120),
          e.repoId ?? null,
          e.taskId ?? null,
          e.actor ? String(e.actor).slice(0, 200) : null,
          e.client ? String(e.client).slice(0, 120) : null,
          e.outcome,
          e.status ?? (e.outcome === "ok" ? 200 : 500),
          safeReason(e.reason),
          Math.max(0, Math.round(e.estimatedTokens ?? 0)),
          Math.max(0, Math.round(e.omittedCount ?? 0)),
          e.bound ? e.bound.slice(0, 400) : null,
          Math.max(0, Math.round(e.latencyMs ?? 0)),
          e.bytes ?? null,
          e.detail ? JSON.stringify(e.detail).slice(0, 4000) : null,
        ]);
        for (const path of (e.paths ?? []).slice(0, PATHS_PER_EVENT))
          paths.push([
            uid(),
            e.tenant,
            at,
            e.repoId ?? null,
            e.taskId ?? null,
            safePathValue(path.path),
            String(path.role).slice(0, 32),
            Math.max(0, Math.round(path.estimatedTokens ?? 0)),
          ]);
      }
      // Multi-row inserts: a whole tool call is normally two prepared
      // statements, which is what keeps capture off the latency budget.
      await this.sql.write([
        ...rowsToStatements(
          "INSERT INTO analytics_events(id,tenant,at,surface,operation,repo_id,task_id,actor,client,outcome,status,reason,estimated_tokens,omitted_count,bound,latency_ms,bytes,detail) VALUES",
          18,
          events,
          50,
        ),
        ...rowsToStatements(
          "INSERT INTO analytics_paths(id,tenant,at,repo_id,task_id,path,role,estimated_tokens) VALUES",
          8,
          paths,
          100,
        ),
      ]);
      return batch.length;
    } catch (e) {
      // The request already succeeded. Losing analytics is the correct failure.
      this.dropped += batch.length;
      this.lastError = safeReason(e instanceof Error ? e.message : e);
      return 0;
    }
  }

  private async ensure() {
    if (this.ready || this.sql.managed) {
      this.ready = true;
      return;
    }
    await this.sql.write(ANALYTICS_SCHEMA.map((sql) => ({ sql, params: [] })));
    this.ready = true;
  }

  /** Delete rows past their retention window. Bounded; call repeatedly to drain. */
  async prune(now = Date.now(), limit = 5000) {
    try {
      await this.ensure();
      await this.sql.write([
        {
          sql: `DELETE FROM analytics_events WHERE id IN (SELECT id FROM analytics_events WHERE at < ? LIMIT ${limit})`,
          params: [now - RETENTION_DAYS * 86400000],
        },
        {
          sql: `DELETE FROM analytics_paths WHERE id IN (SELECT id FROM analytics_paths WHERE at < ? LIMIT ${limit})`,
          params: [now - PATH_RETENTION_DAYS * 86400000],
        },
      ]);
      return true;
    } catch (e) {
      this.lastError = safeReason(e instanceof Error ? e.message : e);
      return false;
    }
  }

  /** Erase one repository's analytics. Used when a workspace deletes an index. */
  async forgetRepository(tenant: string, repoId: string) {
    try {
      await this.ensure();
      await this.sql.write([
        {
          sql: "DELETE FROM analytics_events WHERE tenant=? AND repo_id=?",
          params: [tenant, repoId],
        },
        {
          sql: "DELETE FROM analytics_paths WHERE tenant=? AND repo_id=?",
          params: [tenant, repoId],
        },
      ]);
      return true;
    } catch (e) {
      this.lastError = safeReason(e instanceof Error ? e.message : e);
      return false;
    }
  }

  // ---------------------------------------------------------------- read side

  /**
   * Aggregate one workspace's activity. `repoId`, when given, restricts every
   * figure to that repository. Nothing here crosses a tenant boundary.
   */
  async aggregate(
    tenant: string,
    options: { repoId?: string; days?: number; now?: number } = {},
  ) {
    await this.ensure();
    const now = options.now ?? Date.now();
    const days = Math.min(365, Math.max(1, options.days ?? 30));
    const since = now - days * 86400000;
    const scope = options.repoId
      ? { clause: " AND repo_id=?", extra: [options.repoId] as unknown[] }
      : { clause: "", extra: [] as unknown[] };
    const bind = (...rest: unknown[]) => [
      tenant,
      since,
      ...scope.extra,
      ...rest,
    ];

    const totals = await this.sql.all<{
      surface: string;
      operation: string;
      outcome: string;
      calls: number;
      est: number;
      omitted: number;
      latency: number;
    }>(
      `SELECT surface, operation, outcome, COUNT(*) AS calls, SUM(estimated_tokens) AS est, SUM(omitted_count) AS omitted, SUM(latency_ms) AS latency
       FROM analytics_events WHERE tenant=? AND at>=?${scope.clause}
       GROUP BY surface, operation, outcome`,
      bind(),
    );
    const latencies = await this.sql.all<{
      operation: string;
      surface: string;
      latency_ms: number;
    }>(
      `SELECT operation, surface, latency_ms FROM analytics_events
       WHERE tenant=? AND at>=?${scope.clause} ORDER BY at DESC LIMIT ${SAMPLE}`,
      bind(),
    );
    const refusals = await this.sql.all<{
      operation: string;
      reason: string;
      status: number;
      count: number;
    }>(
      `SELECT operation, reason, status, COUNT(*) AS count FROM analytics_events
       WHERE tenant=? AND at>=?${scope.clause} AND outcome='refused'
       GROUP BY operation, reason, status ORDER BY count DESC LIMIT 25`,
      bind(),
    );
    const order = await this.sql.all<{
      task_id: string;
      operation: string;
      at: number;
    }>(
      `SELECT task_id, operation, at FROM analytics_events
       WHERE tenant=? AND at>=?${scope.clause} AND task_id IS NOT NULL AND surface IN ('tool','mcp','console')
       ORDER BY task_id, at LIMIT ${SAMPLE}`,
      bind(),
    );
    const paths = await this.sql.all<{
      path: string;
      role: string;
      count: number;
      est: number;
    }>(
      `SELECT path, role, COUNT(*) AS count, SUM(estimated_tokens) AS est FROM analytics_paths
       WHERE tenant=? AND at>=?${scope.clause}
       GROUP BY path, role ORDER BY count DESC LIMIT 600`,
      bind(),
    );
    const indexing = await this.sql.all<{
      repo_id: string;
      outcome: string;
      at: number;
      latency_ms: number;
      bytes: number | null;
      detail: string | null;
    }>(
      `SELECT repo_id, outcome, at, latency_ms, bytes, detail FROM analytics_events
       WHERE tenant=? AND at>=?${scope.clause} AND surface='index'
       ORDER BY at DESC LIMIT 200`,
      bind(),
    );
    const pulls = await this.sql.all<{
      at: number;
      operation: string;
      detail: string | null;
      task_id: string | null;
    }>(
      `SELECT at, operation, detail, task_id FROM analytics_events
       WHERE tenant=? AND at>=?${scope.clause} AND surface='github'
       ORDER BY at DESC LIMIT 500`,
      bind(),
    );

    return {
      window: { since, until: now, days },
      behaviour: behaviour(totals, latencies, refusals, order, paths),
      outcomes: outcomes(totals, pulls),
      surfaces: surfaces(totals, latencies),
      indexing: indexHealth(indexing),
      capture: {
        droppedSinceStart: this.dropped,
        lastWriteError: this.lastError,
        latencySample: Math.min(SAMPLE, latencies.length),
        note: "Latency percentiles are computed over the most recent sampled events in this window, not the whole window.",
      },
    };
  }

  /** Open pull requests worth re-checking against GitHub, newest first. */
  async openPullRequests(tenant: string, limit = 20) {
    await this.ensure();
    const rows = await this.sql.all<{
      detail: string | null;
      repo_id: string | null;
      task_id: string | null;
      at: number;
    }>(
      `SELECT detail, repo_id, task_id, at FROM analytics_events
       WHERE tenant=? AND surface='github' AND operation='pull_request_opened'
       ORDER BY at DESC LIMIT 200`,
      [tenant],
    );
    const settled = new Set(
      (
        await this.sql.all<{ detail: string | null }>(
          `SELECT detail FROM analytics_events WHERE tenant=? AND surface='github' AND operation='pull_request_state'`,
          [tenant],
        )
      )
        .map((r) => parse(r.detail))
        .filter((d) => d.state === "merged" || d.state === "closed")
        .map((d) => `${d.repository}#${d.number}`),
    );
    const seen = new Set<string>();
    const out: {
      repository: string;
      number: number;
      installationId: number;
      repoId: string | null;
      taskId: string | null;
      openedAt: number;
    }[] = [];
    for (const row of rows) {
      const d = parse(row.detail);
      const key = `${d.repository}#${d.number}`;
      if (!d.repository || !d.number || settled.has(key) || seen.has(key))
        continue;
      seen.add(key);
      out.push({
        repository: String(d.repository),
        number: Number(d.number),
        installationId: Number(d.installationId ?? 0),
        repoId: row.repo_id,
        taskId: row.task_id,
        openedAt: row.at,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Latest known state of every pull request this workspace published. */
  async pullRequestStates(tenant: string) {
    await this.ensure();
    const rows = await this.sql.all<{ detail: string | null; at: number }>(
      `SELECT detail, at FROM analytics_events WHERE tenant=? AND surface='github' AND operation='pull_request_state' ORDER BY at ASC LIMIT 1000`,
      [tenant],
    );
    const latest = new Map<
      string,
      { state: string; hoursToMerge: number | null; taskId?: string }
    >();
    for (const row of rows) {
      const d = parse(row.detail);
      if (!d.repository || !d.number) continue;
      latest.set(`${d.repository}#${d.number}`, {
        state: String(d.state ?? "open"),
        hoursToMerge:
          typeof d.hoursToMerge === "number" ? d.hoursToMerge : null,
        taskId: typeof d.taskId === "string" ? d.taskId : undefined,
      });
    }
    return latest;
  }
}

const parse = (raw: string | null): Record<string, any> => {
  if (!raw) return {};
  try {
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
};

const percentile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

type Totals = {
  surface: string;
  operation: string;
  outcome: string;
  calls: number;
  est: number;
  omitted: number;
  latency: number;
};

function behaviour(
  totals: Totals[],
  latencies: { operation: string; surface: string; latency_ms: number }[],
  refusals: {
    operation: string;
    reason: string;
    status: number;
    count: number;
  }[],
  order: { task_id: string; operation: string; at: number }[],
  paths: { path: string; role: string; count: number; est: number }[],
) {
  const byTool = new Map<
    string,
    {
      tool: string;
      calls: number;
      ok: number;
      refused: number;
      errors: number;
      estimatedTokens: number;
      omitted: number;
      p50: number;
      p95: number;
    }
  >();
  for (const t of totals) {
    if (!["tool", "mcp", "console"].includes(t.surface)) continue;
    const row = byTool.get(t.operation) ?? {
      tool: t.operation,
      calls: 0,
      ok: 0,
      refused: 0,
      errors: 0,
      estimatedTokens: 0,
      omitted: 0,
      p50: 0,
      p95: 0,
    };
    row.calls += t.calls;
    row.estimatedTokens += t.est ?? 0;
    row.omitted += t.omitted ?? 0;
    if (t.outcome === "ok") row.ok += t.calls;
    else if (t.outcome === "refused") row.refused += t.calls;
    else row.errors += t.calls;
    byTool.set(t.operation, row);
  }
  const perTool = new Map<string, number[]>();
  for (const l of latencies) {
    if (!["tool", "mcp", "console"].includes(l.surface)) continue;
    perTool.set(l.operation, [
      ...(perTool.get(l.operation) ?? []),
      l.latency_ms,
    ]);
  }
  for (const [tool, row] of byTool) {
    const xs = perTool.get(tool) ?? [];
    row.p50 = percentile(xs, 0.5);
    row.p95 = percentile(xs, 0.95);
  }

  // Call order within a task: the transition an agent actually made.
  const transitions = new Map<string, number>();
  const firstCall = new Map<string, number>();
  let previousTask = "",
    previousOp = "";
  for (const row of order) {
    if (row.task_id !== previousTask) {
      firstCall.set(row.operation, (firstCall.get(row.operation) ?? 0) + 1);
      previousTask = row.task_id;
      previousOp = row.operation;
      continue;
    }
    const key = `${previousOp} → ${row.operation}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
    previousOp = row.operation;
  }

  const byPath = new Map<
    string,
    {
      path: string;
      requested: number;
      delivered: number;
      pulled: number;
      deliveredTokens: number;
    }
  >();
  for (const p of paths) {
    const row = byPath.get(p.path) ?? {
      path: p.path,
      requested: 0,
      delivered: 0,
      pulled: 0,
      deliveredTokens: 0,
    };
    if (p.role === "delivered" || p.role === "excerpted") {
      row.delivered += p.count;
      row.deliveredTokens += p.est ?? 0;
    }
    if (p.role === "read" || p.role === "edited" || p.role === "expanded")
      row.pulled += p.count;
    row.requested += p.count;
    byPath.set(p.path, row);
  }
  const ceiling = refusals
    .filter((r) => r.status === 429)
    .reduce((n, r) => n + r.count, 0);

  return {
    tools: [...byTool.values()].sort((a, b) => b.calls - a.calls),
    firstCall: [...firstCall.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    transitions: [...transitions.entries()]
      .map(([step, count]) => ({ step, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    refusals: refusals.map((r) => ({
      tool: r.operation,
      status: r.status,
      reason: r.reason,
      count: r.count,
    })),
    ceilingRefusals: ceiling,
    mostRequested: [...byPath.values()]
      .sort((a, b) => b.requested - a.requested)
      .slice(0, 15),
    deliveredNeverPulled: [...byPath.values()]
      .filter((p) => p.delivered > 0 && p.pulled === 0)
      .sort((a, b) => b.deliveredTokens - a.deliveredTokens)
      .slice(0, 15),
  };
}

function outcomes(
  totals: Totals[],
  pulls: { at: number; operation: string; detail: string | null }[],
) {
  const count = (
    op: string,
    outcome?: string,
    surface?: (t: Totals) => boolean,
  ) =>
    totals
      .filter(
        (t) =>
          t.operation === op &&
          (!outcome || t.outcome === outcome) &&
          (!surface || surface(t)),
      )
      .reduce((n, t) => n + t.calls, 0);
  const states = new Map<string, { state: string; hours: number | null }>();
  let opened = 0;
  for (const row of [...pulls].sort((a, b) => a.at - b.at)) {
    const d = parse(row.detail);
    if (!d.repository || !d.number) continue;
    const key = `${d.repository}#${d.number}`;
    if (row.operation === "pull_request_opened") {
      opened++;
      if (!states.has(key)) states.set(key, { state: "open", hours: null });
    } else if (row.operation === "pull_request_state")
      states.set(key, {
        state: String(d.state ?? "open"),
        hours: typeof d.hoursToMerge === "number" ? d.hoursToMerge : null,
      });
  }
  const list = [...states.values()];
  const merged = list.filter((s) => s.state === "merged");
  const hours = merged
    .map((s) => s.hours)
    .filter((h): h is number => typeof h === "number");
  // Validation outcome is recorded as its own event because the tool itself
  // succeeds whether or not the validation passed.
  const isOutcome = (t: Totals) => t.surface === "outcome";
  const submitted = count("submit_changeset", "ok");
  const validated = count("validation", undefined, isOutcome);
  const validationPassed = count("validation", "ok", isOutcome);
  return {
    changesetsSubmitted: submitted,
    validationsRun: validated,
    validationsPassed: validationPassed,
    validationPassRate: validated ? validationPassed / validated : null,
    draftPullRequests: opened,
    merged: merged.length,
    closed: list.filter((s) => s.state === "closed").length,
    stillOpen: list.filter((s) => s.state === "open").length,
    medianHoursToMerge: hours.length ? percentile(hours, 0.5) : null,
    unknownMergeState: Math.max(
      0,
      opened - list.filter((s) => s.state !== "open").length,
    ),
    note: "Merge state comes from GitHub and is only as fresh as the last refresh. A draft pull request that no human has reviewed is not an accepted change.",
  };
}

function surfaces(
  totals: Totals[],
  latencies: { operation: string; surface: string; latency_ms: number }[],
) {
  const by = new Map<
    string,
    {
      surface: string;
      calls: number;
      errors: number;
      refused: number;
      p50: number;
      p95: number;
    }
  >();
  for (const t of totals) {
    const row = by.get(t.surface) ?? {
      surface: t.surface,
      calls: 0,
      errors: 0,
      refused: 0,
      p50: 0,
      p95: 0,
    };
    row.calls += t.calls;
    if (t.outcome === "error") row.errors += t.calls;
    if (t.outcome === "refused") row.refused += t.calls;
    by.set(t.surface, row);
  }
  for (const [surface, row] of by) {
    const xs = latencies
      .filter((l) => l.surface === surface)
      .map((l) => l.latency_ms);
    row.p50 = percentile(xs, 0.5);
    row.p95 = percentile(xs, 0.95);
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls);
}

function indexHealth(
  rows: {
    repo_id: string;
    outcome: string;
    at: number;
    latency_ms: number;
    bytes: number | null;
    detail: string | null;
  }[],
) {
  const by = new Map<string, any>();
  for (const row of rows) {
    const d = parse(row.detail);
    const key = row.repo_id ?? "unknown";
    const existing = by.get(key);
    if (!existing || row.at > existing.at)
      by.set(key, {
        repoId: key,
        name: d.name ?? null,
        at: row.at,
        indexedAt: new Date(row.at).toISOString(),
        outcome: row.outcome,
        durationMs: row.latency_ms,
        sourceBytes: row.bytes,
        files: numberOrNull(d.files),
        excluded: numberOrNull(d.excluded),
        unresolved: numberOrNull(d.unresolved),
        symbols: numberOrNull(d.symbols),
        relationships: numberOrNull(d.relationships),
        exclusionReasons: Array.isArray(d.exclusionReasons)
          ? d.exclusionReasons.slice(0, 10)
          : [],
        failures: 0,
        runs: 0,
      });
  }
  for (const row of rows) {
    const entry = by.get(row.repo_id ?? "unknown");
    if (!entry) continue;
    entry.runs++;
    if (row.outcome !== "ok") entry.failures++;
  }
  const now = Date.now();
  return [...by.values()]
    .map((r) => ({
      ...r,
      ageHours: Math.round((now - r.at) / 3600000),
      coverage:
        r.files && r.excluded !== null
          ? (r.files - r.excluded) / r.files
          : null,
    }))
    .sort((a, b) => b.at - a.at);
}

const numberOrNull = (v: unknown) => (typeof v === "number" ? v : null);

// ------------------------------------------------------------------ economics

export type BaselineStatus = "measured" | "provisional" | "unavailable";
export interface TaskEconomics {
  taskId: string;
  repoId: string;
  base: string;
  createdAt?: string;
  /** Estimated tokens Caelogram actually delivered for this task. */
  servedTokens: number;
  /** Estimated tokens of touched files + their dependency closure, read whole. */
  baselineTokens: number | null;
  savedTokens: number | null;
  /** served ÷ baseline. Below 1 means Caelogram served less than the naive read. */
  ratio: number | null;
  touched: string[];
  /** Files in the closure that are not themselves touched. */
  closure: number;
  status: BaselineStatus;
  basis: "merged" | "published" | "submitted" | "none";
  reason: string | null;
  assumption: string;
  estimate: string;
}

export interface BaselineInput {
  taskId: string;
  repoId: string;
  base: string;
  createdAt?: string;
  servedTokens: number;
  /** Paths the change actually touched, from the changeset. */
  touched: string[];
  /** Indexed path → bytes at the task's base commit. */
  indexed: Map<string, number>;
  /** Static relationships at that commit. Only `from`/`to`/`kind` are used. */
  edges: { from: string; to: string; kind: string }[];
  basis: "merged" | "published" | "submitted" | "none";
  depth?: number;
}

/**
 * The measured naive baseline.
 *
 * What an agent with no Caelogram would have had to read to make *this* change:
 * every file the change actually touched, plus everything within two static
 * dependency hops of those files, read whole at the exact base commit. Byte
 * counts come from the index, so the number is derived from real data.
 *
 * Deliberately NOT the whole repository — that produces a flattering ratio no
 * reviewer accepts. Deliberately not invented when the inputs are missing:
 * every unavailable case returns `status: "unavailable"` with the reason, and
 * the caller must show nothing rather than a number.
 */
export function measureBaseline(input: BaselineInput): TaskEconomics {
  const shell = {
    taskId: input.taskId,
    repoId: input.repoId,
    base: input.base,
    createdAt: input.createdAt,
    servedTokens: Math.max(0, Math.round(input.servedTokens)),
    baselineTokens: null,
    savedTokens: null,
    ratio: null,
    touched: [] as string[],
    closure: 0,
    basis: input.basis,
    assumption: BASELINE_ASSUMPTION,
    estimate: ESTIMATE_NOTE,
  };
  if (input.basis === "none" || !input.touched.length)
    return {
      ...shell,
      status: "unavailable",
      reason:
        "No changeset has been submitted for this task, so the files the work actually touched are unknown. A baseline would have to be invented.",
    };
  if (!input.indexed.size)
    return {
      ...shell,
      touched: input.touched,
      status: "unavailable",
      reason:
        "The index for this task's base commit is no longer available, so the touched files cannot be measured.",
    };
  // A file created by the change did not exist at the base commit; an agent
  // could not have read it, so it contributes nothing to the baseline.
  const existing = input.touched.filter((p) => input.indexed.has(p));
  if (!existing.length)
    return {
      ...shell,
      touched: input.touched,
      status: "unavailable",
      reason:
        "Every file this change touched is new at the base commit. There is nothing an agent would have read, so no baseline can be justified.",
    };
  const graph = { edges: input.edges } as unknown as Graph;
  const reached = [...impact(graph, existing, input.depth ?? 2).keys()].filter(
    (p) => input.indexed.has(p),
  );
  let baselineTokens = 0;
  for (const path of reached)
    baselineTokens += Math.ceil((input.indexed.get(path) ?? 0) / 3);
  if (baselineTokens <= 0)
    return {
      ...shell,
      touched: existing,
      status: "unavailable",
      reason:
        "The indexed byte counts for the touched files are zero or missing at this commit, so no honest baseline can be computed.",
    };
  return {
    ...shell,
    touched: existing,
    closure: Math.max(0, reached.length - existing.length),
    baselineTokens,
    savedTokens: baselineTokens - shell.servedTokens,
    ratio: shell.servedTokens / baselineTokens,
    status: input.basis === "merged" ? "measured" : "provisional",
    reason:
      input.basis === "merged"
        ? null
        : input.basis === "published"
          ? "A draft pull request exists but has not been merged. Until a human accepts the change, the set of files it needed is not settled, so this baseline is provisional."
          : "The changeset has been submitted but not published or accepted, so the set of files the work really needed is not settled. This baseline is provisional.",
  };
}

/** Roll up only what can be defended: measured tasks headline, the rest counted. */
export function rollUpEconomics(tasks: TaskEconomics[]) {
  const measured = tasks.filter((t) => t.status === "measured");
  const provisional = tasks.filter((t) => t.status === "provisional");
  const sum = (list: TaskEconomics[], key: "servedTokens" | "baselineTokens") =>
    list.reduce((n, t) => n + ((t[key] as number | null) ?? 0), 0);
  const servedTokens = sum(measured, "servedTokens");
  const baselineTokens = sum(measured, "baselineTokens");
  return {
    tasks: tasks.length,
    measuredTasks: measured.length,
    provisionalTasks: provisional.length,
    unavailableTasks: tasks.filter((t) => t.status === "unavailable").length,
    servedTokens,
    baselineTokens,
    savedTokens: measured.length ? baselineTokens - servedTokens : null,
    ratio: baselineTokens ? servedTokens / baselineTokens : null,
    provisionalServedTokens: sum(provisional, "servedTokens"),
    provisionalBaselineTokens: sum(provisional, "baselineTokens"),
    assumption: BASELINE_ASSUMPTION,
    estimate: ESTIMATE_NOTE,
    note:
      measured.length === 0
        ? "No task in this window has an accepted (merged) outcome yet, so there is no defensible saving to report. Provisional figures are shown separately and are not a claim."
        : "Headline figures cover only tasks whose change was merged. Provisional tasks are excluded from the total on purpose.",
  };
}

// ----------------------------------------------------------- path attribution

/**
 * Which files a tool call concerned. Paths only — this never reads content and
 * never stores a snippet.
 */
export function attributePaths(
  name: string,
  input: any,
  value: any,
): { path: string; role: string; estimatedTokens?: number }[] {
  const out: { path: string; role: string; estimatedTokens?: number }[] = [];
  const push = (path: unknown, role: string, estimatedTokens?: number) => {
    if (typeof path === "string" && path)
      out.push({ path, role, estimatedTokens });
  };
  try {
    if (name === "begin_change" || name === "get_context") {
      const context = name === "begin_change" ? value?.context : value;
      for (const item of context?.items ?? [])
        push(
          item.path,
          item.start > 1 || item.end ? "excerpted" : "delivered",
          item.estimatedTokens,
        );
      for (const entry of context?.plan ?? [])
        if (entry.status === "omitted")
          push(entry.path, "omitted", entry.estimatedTokens);
      for (const o of context?.omitted ?? []) push(o.path, "omitted");
    } else if (name === "read_section")
      push(input?.path, "read", value?.estimatedTokens);
    else if (name === "expand_impact")
      for (const p of input?.paths ?? []) push(p, "expanded");
    else if (name === "source_search")
      for (const m of (value?.matches ?? []).slice(0, 50))
        push(m.path, "searched");
    else if (name === "submit_changeset")
      for (const e of value?.edits ?? input?.edits ?? [])
        push(e.path, "edited");
    else if (name === "find_component")
      for (const c of (value?.components ?? []).slice(0, 50))
        push(c.path, "searched");
  } catch {
    return out;
  }
  // The delivered/excerpted distinction is what makes "delivered but never
  // pulled" meaningful, so it is worth the small duplication above.
  return out.slice(0, 200);
}

/** Token estimate of a stored file body, for callers that hold content. */
export const estimatedTokensOf = (content: string) => tokens(content);

// ----------------------------------------------------------------- SQL adapters
// Both adapters are structural: analytics never imports node:sqlite (which the
// Workers runtime does not have) nor the Workers D1 types (which the Node
// tsconfig does not load).

/** A synchronous prepared-statement database, i.e. node:sqlite's DatabaseSync. */
export interface SyncDatabase {
  prepare(sql: string): {
    run(...params: any[]): unknown;
    all(...params: any[]): any[];
  };
}
/** A batching async database, i.e. Cloudflare D1. */
export interface BatchDatabase {
  prepare(sql: string): {
    bind(...params: any[]): any;
    all(): Promise<{ results: any[] }>;
  };
  batch(statements: any[]): Promise<unknown>;
}

/** node:sqlite. The schema is created lazily because no migration owns it. */
export function syncRunner(db: SyncDatabase): AnalyticsSql {
  return {
    managed: false,
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as any[])) as T[];
    },
    async write(statements) {
      // `await` even though the driver is synchronous: if a mismatched handle
      // ever returns a promise, the rejection is caught by flush() instead of
      // escaping as an unhandled rejection.
      for (const s of statements)
        await db.prepare(s.sql).run(...(s.params as any[]));
    },
  };
}

/** Cloudflare D1. The schema is owned by migration 0008. */
export function batchRunner(db: BatchDatabase): AnalyticsSql {
  return {
    managed: true,
    async all<T>(sql: string, params: unknown[] = []) {
      return (
        await db
          .prepare(sql)
          .bind(...(params as any[]))
          .all()
      ).results as T[];
    },
    async write(statements) {
      // One D1 batch per 20 statements: a single tool call writes 1–20 rows,
      // so capture is normally one round trip.
      for (let i = 0; i < statements.length; i += 20)
        await db.batch(
          statements
            .slice(i, i + 20)
            .map((s) => db.prepare(s.sql).bind(...(s.params as any[]))),
        );
    },
  };
}
