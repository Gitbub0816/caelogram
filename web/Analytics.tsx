import { useEffect, useState } from "react";

// Everything shown here is derived from captured events and indexed byte
// counts. Nothing on this page is modelled, extrapolated or estimated beyond
// the token estimate the whole product already declares.

type Status = "measured" | "provisional" | "unavailable";
type TaskEconomics = {
  taskId: string;
  repoId: string;
  base: string;
  createdAt?: string;
  servedTokens: number;
  baselineTokens: number | null;
  savedTokens: number | null;
  ratio: number | null;
  touched: string[];
  closure: number;
  status: Status;
  basis: "merged" | "published" | "submitted" | "none";
  reason: string | null;
};
type Report = {
  available: boolean;
  reason?: string;
  workspace: string;
  repoId: string | null;
  repository: string | null;
  estimate: string;
  assumption: string;
  window?: { since: number; until: number; days: number };
  economics?: {
    tasks: TaskEconomics[];
    totals: {
      tasks: number;
      measuredTasks: number;
      provisionalTasks: number;
      unavailableTasks: number;
      servedTokens: number;
      baselineTokens: number;
      savedTokens: number | null;
      ratio: number | null;
      provisionalServedTokens: number;
      provisionalBaselineTokens: number;
      note: string;
    };
  };
  behaviour?: {
    tools: {
      tool: string;
      calls: number;
      ok: number;
      refused: number;
      errors: number;
      estimatedTokens: number;
      omitted: number;
      p50: number;
      p95: number;
    }[];
    firstCall: { tool: string; count: number }[];
    transitions: { step: string; count: number }[];
    refusals: {
      tool: string;
      status: number;
      reason: string;
      count: number;
    }[];
    ceilingRefusals: number;
    mostRequested: {
      path: string;
      requested: number;
      delivered: number;
      pulled: number;
      deliveredTokens: number;
    }[];
    deliveredNeverPulled: {
      path: string;
      delivered: number;
      deliveredTokens: number;
    }[];
  };
  outcomes?: {
    changesetsSubmitted: number;
    validationsRun: number;
    validationsPassed: number;
    validationPassRate: number | null;
    draftPullRequests: number;
    merged: number;
    closed: number;
    stillOpen: number;
    medianHoursToMerge: number | null;
    unknownMergeState: number;
    note: string;
  };
  surfaces?: {
    surface: string;
    calls: number;
    errors: number;
    refused: number;
    p50: number;
    p95: number;
  }[];
  indexing?: {
    repoId: string;
    name: string | null;
    indexedAt: string;
    outcome: string;
    durationMs: number;
    sourceBytes: number | null;
    files: number | null;
    excluded: number | null;
    unresolved: number | null;
    symbols: number | null;
    relationships: number | null;
    exclusionReasons: string[];
    failures: number;
    runs: number;
    ageHours: number;
    coverage: number | null;
  }[];
  capture?: {
    droppedSinceStart: number;
    lastWriteError: string | null;
    latencySample: number;
    note: string;
  };
};

const n = (v: number | null | undefined) =>
  typeof v === "number" ? Math.round(v).toLocaleString() : "—";
const pct = (v: number | null | undefined) =>
  typeof v === "number" ? `${Math.round(v * 100)}%` : "—";
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);

/** A labelled horizontal bar. Width is the only encoding; no axis is implied. */
function Bar({
  value,
  max,
  tone = "gold",
  height = 10,
}: {
  value: number;
  max: number;
  tone?: "gold" | "quiet" | "warn";
  height?: number;
}) {
  const width = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  return (
    <svg
      className="an-bar"
      height={height}
      width="100%"
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect x="0" y="0" width="100" height={height} className="an-bar-track" />
      <rect
        x="0"
        y="0"
        width={width}
        height={height}
        className={"an-bar-fill " + tone}
      />
    </svg>
  );
}

export default function Analytics({
  tool,
  repoId,
  repository,
  session,
  onConnect,
}: {
  tool: (name: string, body: unknown) => Promise<any>;
  repoId?: string;
  repository?: string;
  session: string;
  onConnect: () => void;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = async (refresh = false) => {
    setBusy(refresh ? "Asking GitHub for merge state" : "Loading analytics");
    setError("");
    try {
      setReport(
        await tool("analytics_report", { repoId: repoId ?? "", days, refresh }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analytics unavailable");
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    if (session) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, repoId, days]);

  if (!session)
    return (
      <section className="page">
        <h1>Analytics</h1>
        <div className="empty">
          <h2>No authenticated workspace</h2>
          <p>
            Analytics is recorded per workspace. Connect your session to see
            what your agents actually cost and whether their changes landed.
          </p>
          <button className="primary" onClick={onConnect}>
            Connect session
          </button>
        </div>
      </section>
    );

  const e = report?.economics;
  const totals = e?.totals;
  const behaviour = report?.behaviour;
  const outcomes = report?.outcomes;
  const scale = Math.max(
    totals?.baselineTokens ?? 0,
    totals?.servedTokens ?? 0,
  );

  return (
    <section className="page analytics">
      <div className="an-head">
        <div>
          <h1>Is this saving anything, and is it working?</h1>
          <p className="lead small">
            {repository
              ? `${repository} · workspace ${report?.workspace ?? ""}`
              : "All activity recorded under this identity. Open a repository to scope every figure to it."}
          </p>
        </div>
        <div className="an-controls">
          <div className="segmented" role="group" aria-label="Window">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                className={days === d ? "selected" : ""}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            className="secondary"
            disabled={!!busy}
            onClick={() => void load(true)}
          >
            Refresh merge state
          </button>
        </div>
      </div>
      {busy && <p className="muted an-note">{busy}…</p>}
      {error && <p className="an-alert">{error}</p>}

      {report && !report.available && (
        <div className="empty">
          <h2>Nothing has been captured</h2>
          <p>{report.reason}</p>
        </div>
      )}

      {report?.available && (
        <>
          {/* ------------------------------------------------ token economics */}
          <h2 className="an-section">Token economics</h2>
          <p className="an-assumption">{report.assumption}</p>
          <p className="an-assumption quiet">{report.estimate}</p>

          {totals && totals.measuredTasks === 0 ? (
            <div className="an-panel an-nothing">
              <strong>No defensible saving to report yet.</strong>
              <p>{totals.note}</p>
              {totals.provisionalTasks > 0 && (
                <p className="muted">
                  {totals.provisionalTasks} task
                  {totals.provisionalTasks === 1 ? "" : "s"} have a provisional
                  baseline: {n(totals.provisionalServedTokens)} estimated tokens
                  served against a provisional{" "}
                  {n(totals.provisionalBaselineTokens)}. These are not a claim
                  and are excluded from every total until a change is merged.
                </p>
              )}
            </div>
          ) : (
            totals && (
              <div className="an-panel an-compare">
                <div className="an-compare-row">
                  <span>Naive baseline</span>
                  <Bar
                    value={totals.baselineTokens}
                    max={scale}
                    tone="quiet"
                    height={14}
                  />
                  <strong>{n(totals.baselineTokens)}</strong>
                </div>
                <div className="an-compare-row">
                  <span>Caelogram served</span>
                  <Bar
                    value={totals.servedTokens}
                    max={scale}
                    tone="gold"
                    height={14}
                  />
                  <strong>{n(totals.servedTokens)}</strong>
                </div>
                <div className="an-compare-foot">
                  <div>
                    <span className="eyebrow">DIFFERENCE</span>
                    <strong
                      className={
                        (totals.savedTokens ?? 0) < 0 ? "an-negative" : ""
                      }
                    >
                      {(totals.savedTokens ?? 0) < 0 ? "+" : "−"}
                      {n(Math.abs(totals.savedTokens ?? 0))}
                    </strong>
                    <small>
                      {(totals.savedTokens ?? 0) < 0
                        ? "Caelogram served more than the naive read would have"
                        : "estimated tokens not served"}
                    </small>
                  </div>
                  <div>
                    <span className="eyebrow">SERVED ÷ BASELINE</span>
                    <strong>{pct(totals.ratio)}</strong>
                    <small>over {totals.measuredTasks} merged task(s)</small>
                  </div>
                  <div>
                    <span className="eyebrow">EXCLUDED</span>
                    <strong>
                      {totals.provisionalTasks + totals.unavailableTasks}
                    </strong>
                    <small>
                      {totals.provisionalTasks} provisional,{" "}
                      {totals.unavailableTasks} not computable
                    </small>
                  </div>
                </div>
                <p className="an-assumption quiet">{totals.note}</p>
              </div>
            )
          )}

          <div className="table-wrap">
            <table className="an-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Basis</th>
                  <th>Touched + closure</th>
                  <th>Served</th>
                  <th>Baseline</th>
                  <th>Difference</th>
                </tr>
              </thead>
              <tbody>
                {(e?.tasks ?? []).map((t) => (
                  <tr key={t.taskId}>
                    <td className="mono">{t.taskId.slice(0, 8)}</td>
                    <td>
                      <i className={"an-pill " + t.status}>{t.status}</i>
                      <small className="an-basis">{t.basis}</small>
                    </td>
                    <td>
                      {t.status === "unavailable"
                        ? "—"
                        : `${t.touched.length} + ${t.closure}`}
                    </td>
                    <td>{n(t.servedTokens)}</td>
                    <td>
                      {t.baselineTokens === null ? (
                        <span className="muted">not computed</span>
                      ) : (
                        n(t.baselineTokens)
                      )}
                    </td>
                    <td>
                      {t.savedTokens === null ? (
                        <span className="an-why">{t.reason}</span>
                      ) : (
                        <>
                          <span
                            className={t.savedTokens < 0 ? "an-negative" : ""}
                          >
                            {t.savedTokens < 0 ? "+" : "−"}
                            {n(Math.abs(t.savedTokens))}
                          </span>
                          {t.status === "provisional" && (
                            <span className="an-why">{t.reason}</span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!e?.tasks.length && (
              <p className="muted an-note">
                No tasks in this window. Nothing is inferred from an empty
                window.
              </p>
            )}
          </div>

          {/* --------------------------------------------------- outcomes */}
          <h2 className="an-section">Outcomes</h2>
          <p className="an-assumption">
            Context quality is judged by whether the change was accepted, not by
            how few tokens it took. {outcomes?.note}
          </p>
          {outcomes && (
            <div className="an-panel">
              <div className="an-funnel">
                {[
                  ["Changesets submitted", outcomes.changesetsSubmitted],
                  ["Validations passed", outcomes.validationsPassed],
                  ["Draft pull requests", outcomes.draftPullRequests],
                  ["Merged", outcomes.merged],
                ].map(([label, value]) => (
                  <div className="an-funnel-step" key={String(label)}>
                    <span>{label}</span>
                    <Bar
                      value={Number(value)}
                      max={Math.max(1, outcomes.changesetsSubmitted)}
                      tone={label === "Merged" ? "gold" : "quiet"}
                      height={12}
                    />
                    <strong>{n(Number(value))}</strong>
                  </div>
                ))}
              </div>
              <div className="metrics an-metrics">
                <div>
                  <span>VALIDATION PASS RATE</span>
                  <strong>{pct(outcomes.validationPassRate)}</strong>
                  <small>{outcomes.validationsRun} run</small>
                </div>
                <div>
                  <span>MEDIAN TIME TO MERGE</span>
                  <strong>
                    {outcomes.medianHoursToMerge === null
                      ? "—"
                      : `${outcomes.medianHoursToMerge.toFixed(1)}h`}
                  </strong>
                  <small>from GitHub, at last refresh</small>
                </div>
                <div>
                  <span>CLOSED WITHOUT MERGE</span>
                  <strong>{n(outcomes.closed)}</strong>
                  <small>rejected proposals</small>
                </div>
                <div>
                  <span>MERGE STATE UNKNOWN</span>
                  <strong>{n(outcomes.unknownMergeState)}</strong>
                  <small>never refreshed against GitHub</small>
                </div>
              </div>
            </div>
          )}

          {/* -------------------------------------------------- behaviour */}
          <h2 className="an-section">Agent behaviour</h2>
          {behaviour && (
            <>
              <div className="table-wrap">
                <table className="an-table">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>Calls</th>
                      <th>Refused</th>
                      <th>Errors</th>
                      <th>Est. tokens</th>
                      <th>Latency p50 / p95</th>
                      <th aria-label="Share of calls"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {behaviour.tools.map((t) => (
                      <tr key={t.tool}>
                        <td className="mono">{t.tool}</td>
                        <td>{n(t.calls)}</td>
                        <td className={t.refused ? "an-warn" : ""}>
                          {n(t.refused)}
                        </td>
                        <td className={t.errors ? "an-warn" : ""}>
                          {n(t.errors)}
                        </td>
                        <td>{n(t.estimatedTokens)}</td>
                        <td>
                          {ms(t.p50)} / {ms(t.p95)}
                        </td>
                        <td className="an-barcell">
                          <Bar
                            value={t.calls}
                            max={Math.max(
                              ...behaviour.tools.map((x) => x.calls),
                              1,
                            )}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!behaviour.tools.length && (
                  <p className="muted an-note">No tool calls in this window.</p>
                )}
              </div>
              <div className="an-grid">
                <div className="an-panel">
                  <span className="eyebrow">BUDGET ADHERENCE</span>
                  <strong className="an-big">
                    {n(behaviour.ceilingRefusals)}
                  </strong>
                  <p className="muted">
                    refusals at the task ingestion ceiling (HTTP 429). Each one
                    is an agent that tried to read past its budget and was
                    stopped, which is the ceiling working rather than failing.
                  </p>
                  <ul className="an-list">
                    {behaviour.refusals.slice(0, 6).map((r, i) => (
                      <li key={i}>
                        <span className="mono">{r.tool}</span>
                        <i>{r.status}</i>
                        <small>{r.reason}</small>
                        <b>{r.count}</b>
                      </li>
                    ))}
                    {!behaviour.refusals.length && (
                      <li className="muted">Nothing was refused.</li>
                    )}
                  </ul>
                </div>
                <div className="an-panel">
                  <span className="eyebrow">CALL ORDER WITHIN A TASK</span>
                  <ul className="an-list">
                    {behaviour.transitions.map((t, i) => (
                      <li key={i}>
                        <span className="mono grow">{t.step}</span>
                        <b>{t.count}</b>
                      </li>
                    ))}
                    {!behaviour.transitions.length && (
                      <li className="muted">
                        No task had more than one call in this window.
                      </li>
                    )}
                  </ul>
                </div>
                <div className="an-panel">
                  <span className="eyebrow">MOST REQUESTED FILES</span>
                  <ul className="an-list">
                    {behaviour.mostRequested.slice(0, 10).map((f) => (
                      <li key={f.path}>
                        <span className="mono grow">{f.path}</span>
                        <b>{f.requested}</b>
                      </li>
                    ))}
                    {!behaviour.mostRequested.length && (
                      <li className="muted">No file attribution recorded.</li>
                    )}
                  </ul>
                </div>
                <div className="an-panel">
                  <span className="eyebrow">DELIVERED BUT NEVER PULLED</span>
                  <p className="muted">
                    Files the context package carried that no later call read,
                    expanded or edited. Wasted budget, ranked by estimated
                    tokens.
                  </p>
                  <ul className="an-list">
                    {behaviour.deliveredNeverPulled.slice(0, 10).map((f) => (
                      <li key={f.path}>
                        <span className="mono grow">{f.path}</span>
                        <b>{n(f.deliveredTokens)}</b>
                      </li>
                    ))}
                    {!behaviour.deliveredNeverPulled.length && (
                      <li className="muted">
                        Everything delivered was used, or nothing was delivered.
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            </>
          )}

          {/* ------------------------------------------------ index health */}
          <h2 className="an-section">Index health</h2>
          <div className="table-wrap">
            <table className="an-table">
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Coverage</th>
                  <th>Excluded</th>
                  <th>Without outgoing links</th>
                  <th>Duration</th>
                  <th>Age</th>
                  <th>Failures</th>
                </tr>
              </thead>
              <tbody>
                {(report.indexing ?? []).map((r) => (
                  <tr key={r.repoId}>
                    <td className="mono">{r.name ?? r.repoId.slice(0, 8)}</td>
                    <td className="an-barcell">
                      {r.coverage === null ? (
                        <span className="muted">unknown</span>
                      ) : (
                        <>
                          <Bar value={r.coverage} max={1} />
                          <small>{pct(r.coverage)}</small>
                        </>
                      )}
                    </td>
                    <td>{n(r.excluded)}</td>
                    <td>{n(r.unresolved)}</td>
                    <td>{ms(r.durationMs)}</td>
                    <td className={r.ageHours > 168 ? "an-warn" : ""}>
                      {r.ageHours}h
                    </td>
                    <td className={r.failures ? "an-warn" : ""}>
                      {r.failures}/{r.runs}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!report.indexing?.length && (
              <p className="muted an-note">
                No indexing run has been recorded in this window.
              </p>
            )}
            {(report.indexing ?? []).some((r) => r.exclusionReasons.length) && (
              <p className="muted an-note">
                Exclusion reasons seen:{" "}
                {[
                  ...new Set(
                    (report.indexing ?? []).flatMap((r) => r.exclusionReasons),
                  ),
                ].join(" · ")}
              </p>
            )}
          </div>

          {/* ---------------------------------------------------- surfaces */}
          <h2 className="an-section">Surface health</h2>
          <div className="table-wrap">
            <table className="an-table">
              <thead>
                <tr>
                  <th>Surface</th>
                  <th>Requests</th>
                  <th>Refused</th>
                  <th>Errors</th>
                  <th>p50</th>
                  <th>p95</th>
                </tr>
              </thead>
              <tbody>
                {(report.surfaces ?? []).map((s) => (
                  <tr key={s.surface}>
                    <td className="mono">{s.surface}</td>
                    <td>{n(s.calls)}</td>
                    <td className={s.refused ? "an-warn" : ""}>
                      {n(s.refused)}
                    </td>
                    <td className={s.errors ? "an-warn" : ""}>{n(s.errors)}</td>
                    <td>{ms(s.p50)}</td>
                    <td>{ms(s.p95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.capture && (
            <p className="muted an-note">
              {report.capture.note} Capture is best effort and never blocks a
              request: {n(report.capture.droppedSinceStart)} event(s) have been
              dropped by this process.
              {report.capture.lastWriteError
                ? ` Last write error: ${report.capture.lastWriteError}.`
                : ""}
            </p>
          )}
        </>
      )}
    </section>
  );
}
