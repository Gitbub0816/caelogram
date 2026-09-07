import React, { useEffect, useState, lazy, Suspense } from "react";
import { Icon } from "./Icon";
import type { Identity } from "./Auth";
import Connect from "./Connect";
import AgentAccess from "./AgentAccess";
import { Galaxy, colors, type MapData } from "./Galaxy";
const OrbitalGalaxy = lazy(() => import("./OrbitalGalaxy"));
type Item = {
  path: string;
  reason: string;
  content: string;
  required: boolean;
  estimatedTokens: number;
  start: number;
  end: number;
};
type Task = {
  id: string;
  repoId: string;
  base: string;
  prompt: string;
  context: {
    items: Item[];
    omitted: { path: string; reason: string }[];
    omittedCount: number;
    estimatedTokens: number;
    sourceTokens: number;
    warnings: string[];
    budget: number;
  };
};
type Change = {
  id: string;
  title: string;
  status: string;
  paths?: string[];
  validation?: {
    passed: boolean;
    errors: string[];
    warnings: string[];
    checks: { name: string; status: string; detail: string }[];
  };
  pr?: { url: string; number: number };
};
export default function App({
  identity,
  publicMode = false,
}: {
  identity?: Identity;
  publicMode?: boolean;
}) {
  const [data, setData] = useState<MapData | null>(null),
    [view, setView] = useState(
      new URLSearchParams(location.search).has("connect") || identity?.signedIn
        ? "connect"
        : "map",
    ),
    [selected, setSelected] = useState("src/payments/gateway.ts"),
    [search, setSearch] = useState(""),
    [task, setTask] = useState<Task | null>(null),
    [prompt, setPrompt] = useState("Add payment retry handling to checkout"),
    [budget, setBudget] = useState(3000),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [token, setToken] = useState(""),
    [localSession, setSession] = useState(""),
    [repositories, setRepositories] = useState<any[]>([]),
    [demo, setDemo] = useState(true),
    [mapMode, setMapMode] = useState<"orbit" | "heatmap" | "table">("orbit"),
    [history, setHistory] = useState<{ tasks: any[]; changes: Change[] }>({
      tasks: [],
      changes: [],
    }),
    [audit, setAudit] = useState<any[]>([]),
    [change, setChange] = useState<Change | null>(null),
    [title, setTitle] = useState(""),
    [edits, setEdits] = useState(
      '[\n  { "path": "src/example.ts", "content": "export const value = 1;\\n" }\n]',
    ),
    [ack, setAck] = useState(false),
    [repoName, setRepoName] = useState(""),
    [branch, setBranch] = useState("main"),
    [installation, setInstallation] = useState(""),
    [source, setSource] = useState("");
  const session = identity?.signedIn ? "clerk" : localSession;
  const request = async (path: string, body?: unknown, auth = localSession) => {
    if (identity?.signedIn) auth = (await identity.getToken()) ?? "";
    const r = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const x = await r.json();
    if (!r.ok) throw new Error(x.error ?? "Request failed");
    return x;
  };
  const tool = (name: string, body: unknown) =>
    request("/api/tools/" + name, body);
  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    void act("Loading repository", async () =>
      setData(await request("/api/demo")),
    );
  }, []);
  const loadRepo = async (id: string) => {
    const next = await tool("repository_map", { repoId: id });
    setData(next);
    setSelected(next.nodes.find((n: any) => n.kind === "file")?.id ?? "");
    setDemo(false);
    setTask(null);
    setChange(null);
    setView("map");
  };
  const showDemo = () =>
    act("Loading sample", async () => {
      setData(await request("/api/demo"));
      setDemo(true);
      setTask(null);
      setChange(null);
      setView("map");
    });
  const navigate = (next: string) => {
    setView(next);
    if (next === "history" && !demo && data)
      void act("Loading history", async () =>
        setHistory(await request("/api/history/" + data.id)),
      );
    if (next === "audit" && session)
      void act("Loading audit", async () =>
        setAudit(await request("/api/audit")),
      );
  };
  const resolveTask = () =>
    act("Resolving context", async () => {
      if (!data) return;
      const t = demo
        ? await request("/api/demo/task", { prompt, budget })
        : await tool("begin_change", { repoId: data.id, prompt, budget });
      setTask(t);
      setView("context");
    });
  const node = data?.nodes.find((n) => n.id === selected);
  const incoming =
    data?.edges.filter((e) => e.to === selected && e.kind !== "contains") ?? [];
  const outgoing =
    data?.edges.filter((e) => e.from === selected && e.kind !== "contains") ??
    [];
  const symbols =
    data?.nodes.filter((n) => n.path === node?.path && n.kind !== "file") ?? [];
  const selectedItem = task?.context.items.find((i) => i.path === node?.path);
  const nav = [
    ["map", "◉", "Repository map"],
    ["context", "⌘", "Task context"],
    ["history", "⎇", "Changesets"],
    ["audit", "≡", "Audit trail"],
  ];
  return (
    <div className="app">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => setView("home")}
          aria-label="Caelogram home"
        >
          <span className="brand-mark">
            <Icon />
          </span>
          caelogram
          <span className="beta">α</span>
        </button>
        <div className="workspace">
          <span className="workspace-icon">C</span>
          <div>
            Personal workspace
            <small>
              {session ? "Connected session" : "Interactive preview"}
            </small>
          </div>
        </div>

        <nav>
          {nav.map(([id, icon, label]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => navigate(id)}
            >
              <span>
                <Icon name={id} />
              </span>
              {label}
              {id === "context" && task && <i>1</i>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="index-status">
            <span className="small-orbit">
              <Icon />
            </span>
            <div>
              {demo ? "Sample repository" : "Commit indexed"}
              <small>
                {data?.revision.slice(0, 8) ?? "Loading"} ·{" "}
                {data?.branch ?? "main"}
              </small>
            </div>
          </div>
          <button className="secondary full" onClick={() => setView("connect")}>
            <Icon name="plus" /> Connect repository
          </button>
          <button className="settings-link" onClick={() => setView("settings")}>
            <Icon name="settings" /> Access & integrations
          </button>
          <a
            href="https://github.com/Gitbub0816/caelogram"
            target="_blank"
            rel="noreferrer"
          >
            Documentation ↗
          </a>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span>
            <button onClick={() => setView("map")}>
              {data?.name.split("/").pop() ?? "Repository"}
            </button>
            <span>/</span>
            <strong>
              {
                (
                  {
                    map: "Galaxy",
                    context: "Task context",
                    history: "Changesets",
                    audit: "Audit trail",
                    connect: "Connect repository",
                    settings: "Settings",
                    home: "Overview",
                  } as any
                )[view]
              }
            </strong>
          </div>
          <div className="top-actions">
            {demo && <span className="sample-tag">SAMPLE DATA</span>}
            <button
              className="avatar"
              onClick={() =>
                identity
                  ? location.assign(identity.signedIn ? "/account" : "/sign-in")
                  : setView("settings")
              }
              aria-label="Account"
            >
              C
            </button>
          </div>
        </header>
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {busy && (
          <div className="loading" role="status">
            {busy}…
          </div>
        )}
        {view === "home" ? (
          <section className="marketing">
            <h1>
              Your code has
              <br />a universe within.
            </h1>
            <p className="lead">
              Give your AI the context that matters.
              <br />
              See the impact. Review every change.
            </p>
            <div className="button-row">
              <button className="primary" onClick={() => setView("connect")}>
                Map your repository ↗
              </button>
              <button className="secondary" onClick={() => void showDemo()}>
                Explore the live demo
              </button>
            </div>
            {data && (
              <Galaxy
                data={data}
                selected=""
                onSelect={(id) => {
                  setSelected(id);
                  setView("map");
                }}
                relevant={[]}
                compact
              />
            )}
            <div className="manifesto">
              <h2>
                The living map between
                <br />
                your AI and your code.
              </h2>
              <div>
                <p>
                  GitHub stays the source of truth. Caelogram follows your
                  repository’s structure to supply focused context, reveal
                  connected components, and turn proposed edits into reviewable
                  pull requests.
                </p>
                <div className="steps">
                  <span>01 &nbsp; Map the existing code</span>
                  <span>02 &nbsp; Focus the task context</span>
                  <span>03 &nbsp; Validate the impact</span>
                  <span>04 &nbsp; Open a draft pull request</span>
                </div>
              </div>
            </div>
          </section>
        ) : view === "connect" && (identity || publicMode) ? (
          <Connect identity={identity} onMapped={loadRepo} />
        ) : view === "connect" ? (
          <section className="page narrow">
            <h1>
              Your existing repository.
              <br />A new perspective.
            </h1>
            <p className="lead small">
              Map any supported GitHub repository at its current commit. No
              restructuring, generated code, or changes to your default branch.
            </p>
            <ol className="onboarding">
              <li>
                <b>Authorize the Caelogram GitHub App</b>
                <p>
                  The operator binds your installation to your organization. The
                  App needs Contents and Pull requests write access; agents
                  never receive its credentials.
                </p>
              </li>
              <li>
                <b>Authenticate your Caelogram session</b>
                <p>
                  Use an issued access token below. Browser OAuth onboarding is
                  not enabled in this alpha.
                </p>
              </li>
              <li>
                <b>Select a repository and branch</b>
                <p>
                  Index declarations and imports. Unsupported or dynamic
                  relationships remain explicitly unknown.
                </p>
              </li>
            </ol>
            {!session ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act("Authenticating", async () => {
                    const repos = await request(
                      "/api/tools/list_repositories",
                      {},
                      token,
                    );
                    setRepositories(repos);
                    setSession(token);
                    setToken("");
                    const target = new URLSearchParams(
                      window.location.search,
                    ).get("repo");
                    if (target && repos.some((r: any) => r.id === target)) {
                      const next = await request(
                        "/api/tools/repository_map",
                        { repoId: target },
                        token,
                      );
                      setData(next);
                      setSelected(
                        next.nodes.find((n: any) => n.kind === "file")?.id ??
                          "",
                      );
                      setDemo(false);
                      setView("map");
                    }
                  });
                }}
              >
                <label>
                  Caelogram access token
                  <input
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    required
                    placeholder="Token from your Caelogram operator"
                  />
                </label>
                <button className="primary" disabled={!!busy}>
                  Connect session
                </button>
              </form>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act("Indexing existing repository", async () => {
                    const repo = await tool("connect_repository", {
                      name: repoName,
                      branch,
                      installationId: Number(installation),
                    });
                    setRepositories(await tool("list_repositories", {}));
                    await loadRepo(repo.id);
                  });
                }}
              >
                <label>
                  GitHub repository
                  <input
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    placeholder="owner/existing-repository"
                    required
                    pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
                  />
                </label>
                <div className="form-row">
                  <label>
                    Branch
                    <input
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    App installation ID
                    <input
                      value={installation}
                      onChange={(e) => setInstallation(e.target.value)}
                      type="number"
                      min="1"
                      required
                    />
                  </label>
                </div>
                <button className="primary" disabled={!!busy}>
                  Connect & map repository ↗
                </button>
              </form>
            )}
            {repositories.length > 0 && (
              <div className="repo-list">
                <h2>Connected repositories</h2>
                {repositories.map((r) => (
                  <button
                    key={r.id}
                    onClick={() =>
                      void act("Opening map", () => loadRepo(r.id))
                    }
                  >
                    {r.name}
                    <span>
                      {r.files} files · {r.branch} →
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="terminal">
              <span>Or inspect an existing local checkout</span>
              <code>caelogram map /path/to/your/repository</code>
            </div>
          </section>
        ) : view === "settings" ? (
          <section className="page">
            <h1>Access & integrations</h1>
            <div className="settings-grid">
              {identity?.signedIn && <AgentAccess identity={identity} />}
              <article>
                <h2>Session</h2>
                {identity && (
                  <p>
                    <a href={identity.signedIn ? "/account" : "/sign-in"}>
                      {identity.signedIn ? "Manage your account" : "Sign in"}
                    </a>
                  </p>
                )}
                <p>
                  {identity?.signedIn
                    ? "Signed in securely with Clerk. GitHub repository access is checked separately."
                    : session
                      ? "Authenticated. Your token is held only in this page’s memory."
                      : "Explore the sample or connect an issued Caelogram identity."}
                </p>
                <button
                  className="secondary"
                  onClick={() => {
                    if (identity?.signedIn) {
                      void identity.signOut();
                      return;
                    }
                    setSession("");
                    setRepositories([]);
                    void showDemo();
                  }}
                  disabled={!session}
                >
                  Sign out
                </button>
                <button className="primary" onClick={() => setView("connect")}>
                  Connect a repository
                </button>
              </article>
              <article>
                <h2>Agent integrations</h2>
                <p>
                  Remote MCP for Claude Code, Codex, Cursor, and compatible
                  clients.
                </p>
                <code>caelogram init --client claude</code>
                <code>caelogram init --client codex</code>
                <code>caelogram init --client cursor</code>
                <p className="muted">
                  CLI prints configuration for review. Access tokens are never
                  GitHub installation credentials.
                </p>
              </article>
              <article>
                <h2>Data & retention</h2>
                <p>
                  Encrypted object storage requires a data key in production.
                  Repository deletion removes stored snapshots, tasks, and
                  changesets; audit metadata remains.
                </p>
                <p className="muted">
                  Automatic retention schedules and organization management are
                  not enabled in this alpha.
                </p>
                {!demo && data && (
                  <button
                    className="danger"
                    onClick={() => {
                      if (
                        window.confirm(
                          "Permanently delete stored repository data, tasks and changesets? GitHub will not be modified.",
                        )
                      )
                        void act("Deleting repository data", async () => {
                          const r = await fetch(
                            "/api/repositories/" + data.id,
                            {
                              method: "DELETE",
                              headers: {
                                Authorization: `Bearer ${identity ? await identity.getToken() : localSession}`,
                              },
                            },
                          );
                          if (!r.ok) throw new Error("Deletion failed");
                          await showDemo();
                        });
                    }}
                  >
                    Delete repository data
                  </button>
                )}
              </article>
              <article>
                <h2>Publication policy</h2>
                <p>
                  Unique service branch. Exact base commit. Static validation.
                  Draft pull request.
                </p>
                <p>
                  Publishing requires its own scope and explicit acknowledgment
                  of validation warnings. Merging is left to GitHub’s review and
                  required CI.
                </p>
              </article>
            </div>
          </section>
        ) : view === "audit" ? (
          <section className="page">
            <h1>Audit trail</h1>
            <p className="lead small">
              Repository access, context reads, validations, and publication
              records.
            </p>
            {!session ? (
              <div className="empty">
                <h2>No authenticated audit history</h2>
                <p>Connect your session to view real workspace activity.</p>
                <button className="primary" onClick={() => setView("connect")}>
                  Connect session
                </button>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((e, i) => (
                      <tr key={i}>
                        <td>{new Date(e.at).toLocaleString()}</td>
                        <td>{e.actor}</td>
                        <td>{e.action}</td>
                        <td className="mono">{e.target}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!audit.length && <p>No recorded activity yet.</p>}
              </div>
            )}
          </section>
        ) : view === "history" ? (
          <section className="page">
            <h1>From context to commit.</h1>
            <p className="lead small">
              Submit a changeset, inspect validation, then publish a draft pull
              request.
            </p>
            {demo ? (
              <div className="empty">
                <h2>Publication belongs to your repository.</h2>
                <p>
                  The sample demonstrates mapping and task resolution. Connect a
                  GitHub repository to submit real edits and create draft pull
                  requests.
                </p>
                <button className="primary" onClick={() => setView("connect")}>
                  Connect repository ↗
                </button>
              </div>
            ) : (
              <>
                <div className="changes-layout">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act("Submitting changeset", async () => {
                        if (!task)
                          throw new Error("Begin a task in Task context first");
                        setChange(
                          await tool("submit_changeset", {
                            taskId: task.id,
                            title,
                            edits: JSON.parse(edits),
                          }),
                        );
                        setAck(false);
                      });
                    }}
                  >
                    <h2>New changeset</h2>
                    <p className="muted">
                      {task
                        ? `Task ${task.id.slice(0, 8)} · base ${task.base.slice(0, 8)}`
                        : "Begin a task before submitting edits."}
                    </p>
                    <label>
                      Title
                      <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        required
                        minLength={3}
                      />
                    </label>
                    <label>
                      File edits · JSON
                      <textarea
                        className="code-input"
                        rows={12}
                        value={edits}
                        onChange={(e) => setEdits(e.target.value)}
                        spellCheck={false}
                      />
                    </label>
                    <small>
                      Explicit file replacements. Set content to null to delete
                      a file.
                    </small>
                    <button className="primary" disabled={!!busy || !task}>
                      Submit changeset
                    </button>
                  </form>
                  <article className="validation">
                    <h2>Validation record</h2>
                    {change ? (
                      <>
                        <div className="status-label">{change.status}</div>
                        <h3>{change.title}</h3>
                        {!change.pr && (
                          <button
                            className="secondary"
                            disabled={!!busy}
                            onClick={() =>
                              void act("Validating changeset", async () =>
                                setChange(
                                  await tool("validate_changeset", {
                                    changesetId: change.id,
                                  }),
                                ),
                              )
                            }
                          >
                            Run static validation
                          </button>
                        )}
                        {change.validation?.checks.map((c) => (
                          <div className="check" key={c.name}>
                            <span
                              className={
                                c.status === "passed" ? "pass" : "warn"
                              }
                            >
                              {c.status === "passed" ? "✓" : "○"}
                            </span>
                            <div>
                              <b>{c.name}</b>
                              <small>{c.detail}</small>
                            </div>
                          </div>
                        ))}
                        {change.validation?.errors.map((e) => (
                          <p className="error-text" key={e}>
                            {e}
                          </p>
                        ))}
                        {change.validation?.warnings.map((w) => (
                          <p className="warning-text" key={w}>
                            {w}
                          </p>
                        ))}
                        {change.validation?.passed && !change.pr && (
                          <>
                            <label className="checkbox">
                              <input
                                type="checkbox"
                                checked={ack}
                                onChange={(e) => setAck(e.target.checked)}
                              />
                              I reviewed impact warnings and understand tests
                              have not run.
                            </label>
                            <button
                              className="primary"
                              disabled={!ack || !!busy}
                              onClick={() =>
                                void act(
                                  "Publishing draft pull request",
                                  async () =>
                                    setChange(
                                      await tool("publish_pull_request", {
                                        changesetId: change.id,
                                        acknowledgeWarnings: ack,
                                      }),
                                    ),
                                )
                              }
                            >
                              Publish draft pull request ↗
                            </button>
                          </>
                        )}
                        {change.pr && (
                          <a
                            className="primary link-button"
                            href={change.pr.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open pull request #{change.pr.number} ↗
                          </a>
                        )}
                      </>
                    ) : (
                      <p className="muted">
                        Validation evidence appears after a changeset is
                        submitted.
                      </p>
                    )}
                  </article>
                </div>
                <h2>History</h2>
                {history.changes.map((c) => (
                  <button
                    className="history-row"
                    key={c.id}
                    onClick={() => setChange(c)}
                  >
                    <span>{c.title}</span>
                    <span>{c.status} →</span>
                  </button>
                ))}
                {!history.changes.length && (
                  <p className="muted">No previously stored changesets.</p>
                )}
              </>
            )}
          </section>
        ) : (
          data && (
            <>
              <div className="page-heading">
                <div>
                  <h1>
                    {view === "context"
                      ? "Change context"
                      : data.name.split("/").pop()}{" "}
                    {view === "map" && (
                      <span className="branch">⎇ {data.branch}</span>
                    )}
                  </h1>
                  <p>
                    {view === "context"
                      ? "Trace the components your task touches, and why they belong."
                      : "Navigate the architecture. Understand what a change will touch."}
                  </p>
                </div>
                <div className="heading-actions">
                  {!demo && (
                    <button
                      className="secondary"
                      disabled={!!busy}
                      onClick={() =>
                        void act("Synchronizing index", async () => {
                          await tool("sync_repository", { repoId: data.id });
                          await loadRepo(data.id);
                        })
                      }
                    >
                      ↻ Sync
                    </button>
                  )}
                  <button
                    className="primary"
                    onClick={() =>
                      view === "context"
                        ? navigate("history")
                        : setView("context")
                    }
                  >
                    {view === "context"
                      ? "Prepare changeset ↗"
                      : "Begin a change ↗"}
                  </button>
                </div>
              </div>
              {view === "context" && (
                <form
                  className="task-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void resolveTask();
                  }}
                >
                  <label className="task-prompt">
                    What are you changing?
                    <input
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      minLength={3}
                      maxLength={4000}
                      required
                      placeholder="Describe the change you want to make"
                    />
                  </label>
                  <label>
                    Context budget
                    <select
                      value={budget}
                      onChange={(e) => setBudget(Number(e.target.value))}
                    >
                      <option value={1500}>1,500 est. tokens</option>
                      <option value={3000}>3,000 est. tokens</option>
                      <option value={6000}>6,000 est. tokens</option>
                      <option value={12000}>12,000 est. tokens</option>
                    </select>
                  </label>
                  <button className="primary" disabled={!!busy}>
                    Resolve task →
                  </button>
                </form>
              )}
              <div className="metrics">
                <div>
                  <span>INDEXED FILES</span>
                  <strong>
                    {data.files}
                    <small>files at this commit</small>
                  </strong>
                </div>
                <div>
                  <span>SYMBOLS</span>
                  <strong>
                    {data.symbols}
                    <small>indexed declarations</small>
                  </strong>
                </div>
                <div>
                  <span>RELATIONSHIPS</span>
                  <strong>
                    {data.relationships}
                    <small>static module links</small>
                  </strong>
                </div>
                <div>
                  <span>{task ? "CONTEXT ESTIMATE" : "INDEXED COMMIT"}</span>
                  <strong className={task ? "" : "commit"}>
                    {task
                      ? task.context.estimatedTokens.toLocaleString()
                      : data.revision.slice(0, 8)}
                    <small>
                      {task
                        ? `${task.context.items.length} files selected`
                        : "immutable snapshot"}
                    </small>
                  </strong>
                </div>
              </div>
              <div className="map-workspace">
                {!demo && data.visibleFiles !== undefined && (
                  <div className="notice">
                    <p>
                      Showing {data.visibleFiles} of {data.files} indexed files.
                      Connections to other pages are outside this view.
                    </p>
                    <button
                      onClick={() =>
                        void act("Searching map", async () =>
                          setData(
                            await tool("map_page", {
                              repoId: data.id,
                              query: search,
                            }),
                          ),
                        )
                      }
                    >
                      Search all indexed paths
                    </button>
                    {data.nextCursor && (
                      <button
                        onClick={() =>
                          void act("Loading map page", async () => {
                            setData(
                              await tool("map_page", {
                                repoId: data.id,
                                after: data.nextCursor,
                                query: search,
                              }),
                            );
                            setSelected("");
                          })
                        }
                      >
                        Next files
                      </button>
                    )}
                    <button
                      onClick={() =>
                        void act("Loading map", async () => {
                          setData(await tool("map_page", { repoId: data.id }));
                          setSearch("");
                          setSelected("");
                        })
                      }
                    >
                      First files
                    </button>
                  </div>
                )}
                <section className="map-panel">
                  <div className="map-toolbar">
                    <div className="segmented" aria-label="Map view">
                      <button
                        className={mapMode === "orbit" ? "selected" : ""}
                        onClick={() => setMapMode("orbit")}
                      >
                        Orbit
                      </button>
                      <button
                        className={mapMode === "heatmap" ? "selected" : ""}
                        onClick={() => setMapMode("heatmap")}
                      >
                        Heatmap
                      </button>
                      <button
                        className={mapMode === "table" ? "selected" : ""}
                        onClick={() => setMapMode("table")}
                      >
                        Components
                      </button>
                    </div>
                    <label className="search">
                      <span>
                        <Icon name="search" />
                      </span>
                      <input
                        aria-label="Find a component"
                        placeholder="Find a component…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      <kbd>/</kbd>
                    </label>
                  </div>
                  {mapMode === "table" ? (
                    <div className="component-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Component</th>
                            <th>Region</th>
                            <th>Incoming</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.nodes
                            .filter(
                              (n) =>
                                n.kind === "file" &&
                                n.path
                                  .toLowerCase()
                                  .includes(search.toLowerCase()),
                            )
                            .map((n) => (
                              <tr key={n.id}>
                                <td>
                                  <button onClick={() => setSelected(n.id)}>
                                    {n.name}
                                  </button>
                                </td>
                                <td>{n.subsystem}</td>
                                <td>
                                  {
                                    data.edges.filter(
                                      (e) =>
                                        e.to === n.id && e.kind !== "contains",
                                    ).length
                                  }
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  ) : mapMode === "orbit" ? (
                    <Suspense
                      fallback={
                        <div className="orbital-loading" role="status">
                          Preparing orbital map…
                        </div>
                      }
                    >
                      <OrbitalGalaxy
                        data={data}
                        selected={selected}
                        onSelect={(id) => {
                          setSelected(id);
                          setSource("");
                        }}
                        relevant={task?.context.items.map((i) => i.path) ?? []}
                        search={search}
                      />
                    </Suspense>
                  ) : (
                    <Galaxy
                      data={data}
                      selected={selected}
                      onSelect={(id) => {
                        setSelected(id);
                        setSource("");
                      }}
                      relevant={task?.context.items.map((i) => i.path) ?? []}
                      search={search}
                    />
                  )}
                  <div className="map-legend">
                    <span>
                      <i style={{ background: colors[0] }} />
                      Color = subsystem
                    </span>
                    <span>Size = incoming links</span>
                    <span>Rings = multiple consumers</span>
                    <span>Dashed links = test imports</span>
                  </div>
                </section>
                <aside className="detail-panel">
                  <div className="detail-top">
                    <span>Component</span>
                    <span>↗</span>
                  </div>
                  {node ? (
                    <>
                      <div className="component-emblem">
                        <Icon />
                      </div>
                      <h2>{node.name}</h2>
                      <p className="path">{node.path}</p>
                      <span className="pill">{node.kind}</span>
                      {selectedItem && (
                        <span className="pill gold">
                          {selectedItem.required
                            ? "Starting component"
                            : "Related context"}
                        </span>
                      )}
                      <dl>
                        <div>
                          <dt>Subsystem</dt>
                          <dd>{node.subsystem}</dd>
                        </div>
                        <div>
                          <dt>Incoming links</dt>
                          <dd>{incoming.length}</dd>
                        </div>
                        <div>
                          <dt>Dependencies</dt>
                          <dd>{outgoing.length}</dd>
                        </div>
                        <div>
                          <dt>Declarations</dt>
                          <dd>{symbols.length}</dd>
                        </div>
                        <div>
                          <dt>Test coverage</dt>
                          <dd>Unknown</dd>
                        </div>
                        <div>
                          <dt>Classification</dt>
                          <dd>
                            {incoming.length
                              ? "Connected"
                              : "Unable to determine"}
                          </dd>
                        </div>
                      </dl>
                      <div className="inspector-section">
                        <h3>Why it looks this way</h3>
                        <p>
                          Radius reflects {incoming.length} incoming module
                          links. Color identifies its subsystem. Orbits appear
                          when a file has multiple consumers.
                        </p>
                      </div>
                      {selectedItem && (
                        <div className="inspector-section relevance">
                          <h3>Included in your task</h3>
                          <p>{selectedItem.reason}</p>
                        </div>
                      )}
                      <div className="inspector-section">
                        <h3>
                          Connected components{" "}
                          <span>{incoming.length + outgoing.length}</span>
                        </h3>
                        {[...incoming, ...outgoing].slice(0, 8).map((e, i) => (
                          <button
                            className="relation"
                            key={i}
                            onClick={() => {
                              setSelected(e.from === node.id ? e.to : e.from);
                              setSource("");
                            }}
                          >
                            <span>{e.kind === "tests" ? "┄" : "↗"}</span>
                            <div>
                              {(e.from === node.id ? e.to : e.from)
                                .split("/")
                                .pop()}
                              <small>
                                {e.kind} · {Math.round(e.confidence * 100)}%
                                evidence confidence
                              </small>
                            </div>
                          </button>
                        ))}
                        {!incoming.length && !outgoing.length && (
                          <p>
                            No resolved static module links. This does not
                            establish that the file is unused.
                          </p>
                        )}
                      </div>
                      {symbols.length > 0 && (
                        <div className="inspector-section">
                          <h3>Declarations</h3>
                          {symbols.slice(0, 12).map((s) => (
                            <div className="symbol" key={s.id}>
                              <span>{s.name}</span>
                              <small>
                                {s.kind} · L{s.start}–{s.end}
                              </small>
                            </div>
                          ))}
                        </div>
                      )}
                      {selectedItem ? (
                        <details>
                          <summary>Inspect selected source</summary>
                          <pre>{selectedItem.content}</pre>
                        </details>
                      ) : (
                        !demo &&
                        task && (
                          <button
                            className="secondary"
                            onClick={() =>
                              void act("Reading bounded section", async () => {
                                const r = await tool("read_section", {
                                  taskId: task.id,
                                  path: node.path,
                                  start: 1,
                                  end: Math.min(node.end, 100),
                                  reason:
                                    "Inspect selected component to assess task impact",
                                });
                                setSource(r.content);
                              })
                            }
                          >
                            Read first 100 lines
                          </button>
                        )
                      )}
                      {source && <pre>{source}</pre>}
                      <div className="evidence-note">
                        STATIC EVIDENCE
                        <span>
                          Valid at {data.revision.slice(0, 8)}. Import
                          resolution does not establish runtime reachability.
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="empty">
                      <p>Select a file to inspect its relationships.</p>
                    </div>
                  )}
                </aside>
              </div>
              {view === "context" && task && (
                <section className="context-results">
                  <div className="section-title">
                    <div>
                      <h2>
                        {task.context.items.length} files. Each with a reason.
                      </h2>
                    </div>
                    <span className="pill">
                      {task.context.estimatedTokens.toLocaleString()} /{" "}
                      {task.context.budget.toLocaleString()} estimated tokens
                    </span>
                  </div>
                  <p className="muted">
                    Indexed source estimate:{" "}
                    {task.context.sourceTokens.toLocaleString()} tokens. This is
                    not a measured agent token saving.
                  </p>
                  {task.context.items.map((i) => (
                    <details key={i.path}>
                      <summary>
                        <span
                          className={
                            i.required
                              ? "context-dot primary-dot"
                              : "context-dot"
                          }
                        />
                        <b>{i.path}</b>
                        <span>
                          {i.required ? "Starting component" : "Related"}
                        </span>
                        <small>{i.estimatedTokens} est. tokens</small>
                      </summary>
                      <p>
                        {i.reason} · Lines {i.start}–{i.end}
                      </p>
                      <pre>{i.content}</pre>
                    </details>
                  ))}
                  {task.context.omitted.length > 0 && (
                    <div className="notice">
                      <b>
                        {task.context.omittedCount} related files exceed this
                        budget.
                      </b>
                      {task.context.omitted.map((o) => (
                        <p key={o.path}>
                          {o.path} — {o.reason}
                        </p>
                      ))}
                    </div>
                  )}
                  <details className="uncertainty">
                    <summary>Index limitations & uncertainty</summary>
                    {task.context.warnings.map((w, i) => (
                      <p key={i}>{w}</p>
                    ))}
                  </details>
                </section>
              )}
              <footer className="console-footer">
                <span>
                  ◎{" "}
                  {demo
                    ? "Real analysis of an included sample"
                    : "Revision-bound structural evidence"}
                </span>
                <span>
                  Coverage unknown · Runtime relationships not inferred
                </span>
              </footer>
            </>
          )
        )}
      </main>
    </div>
  );
}
