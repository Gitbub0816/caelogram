import { useEffect, useState } from "react";
import type { Identity } from "./Auth";
type Repo = { name: string; branch: string; installationId: number };
export default function Connect({
  identity,
  onMapped,
}: {
  identity?: Identity;
  onMapped: (id: string) => Promise<void>;
}) {
  const [repos, setRepos] = useState<Repo[]>([]),
    [connected, setConnected] = useState<
      { id: string; name: string; branch: string }[]
    >([]),
    [installUrl, setInstallUrl] = useState(""),
    [choice, setChoice] = useState(""),
    [branch, setBranch] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [progress, setProgress] = useState<any>(null);
  const [tracking, setTracking] = useState("");
  async function api(path: string, body?: unknown) {
    const token = await identity?.getToken();
    const r = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const x = await r.json();
    if (!r.ok) throw new Error(x.error || "Request failed");
    return x;
  }
  async function act(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  const refresh = () =>
    act(async () => {
      const x = await api("/api/github/repositories");
      setRepos(x.repositories);
      setInstallUrl(x.installUrl);
      setConnected(await api("/api/tools/list_repositories", {}));
    });
  useEffect(() => {
    if (identity?.signedIn) void refresh();
  }, [identity?.signedIn]);
  useEffect(() => {
    if (!tracking) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api("/api/tools/index_status", { repoId: tracking });
        if (stopped) return;
        setProgress(next);
        if (next.status === "ready") {
          setTracking("");
          await onMapped(tracking);
          return;
        }
        if (next.status === "failed") {
          setTracking("");
          setError(next.error || "Indexing failed");
          return;
        }
      } catch (e) {
        if (!stopped)
          setError(
            e instanceof Error ? e.message : "Unable to refresh progress",
          );
      }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [tracking]);
  return (
    <section className="page narrow">
      <h1>Connect your GitHub</h1>
      <p className="lead small">
        Choose an existing repository. Caelogram maps its committed source
        without modifying your default branch.
      </p>
      {!identity?.signedIn ? (
        <div className="connect-step">
          <h2>Start with your account</h2>
          <p>
            Create an account or sign in, then choose the repositories you want
            to map.
          </p>
          <div className="button-row">
            <a className="primary" href="/sign-up">
              Create account
            </a>
            <a className="secondary" href="/sign-in">
              Sign in
            </a>
          </div>
        </div>
      ) : (
        <>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          <div className="connect-step">
            <h2>Authorize your GitHub account</h2>
            <p>
              This verifies which App installations and repositories you can
              access. Your coding agent never receives GitHub credentials.
            </p>
            <div className="button-row">
              <button
                disabled={busy}
                className="primary"
                onClick={() =>
                  void act(async () => {
                    const x = await api("/api/github/start", {});
                    location.assign(x.url);
                  })
                }
              >
                Connect or reauthorize GitHub
              </button>
              {installUrl && (
                <a
                  className="secondary"
                  href={installUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Choose repositories on GitHub
                </a>
              )}
            </div>
            <p className="muted">
              After installing or changing repository access on GitHub, return
              here and refresh.
            </p>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Refresh repositories
            </button>
          </div>
          <form
            className="connect-step"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const repo = repos.find(
                  (r) => `${r.installationId}:${r.name}` === choice,
                );
                if (!repo) throw new Error("Select a repository");
                const x = await api("/api/tools/connect_repository", {
                  name: repo.name,
                  branch,
                  installationId: repo.installationId,
                });
                if (x.status === "ready") await onMapped(x.id);
                else {
                  setProgress(x);
                  setTracking(x.id);
                }
              });
            }}
          >
            <h2>Map a repository</h2>
            <label>
              Repository
              <select
                required
                value={choice}
                onChange={(e) => {
                  setChoice(e.target.value);
                  setBranch(
                    repos.find(
                      (r) => `${r.installationId}:${r.name}` === e.target.value,
                    )?.branch || "",
                  );
                }}
              >
                <option value="">Select a repository</option>
                {repos.map((r) => (
                  <option
                    key={`${r.installationId}:${r.name}`}
                    value={`${r.installationId}:${r.name}`}
                  >
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Branch
              <input
                required
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="Default branch fills automatically"
                maxLength={200}
              />
            </label>
            <button
              className="primary"
              disabled={busy || !!tracking || !choice}
            >
              {busy ? "Working…" : "Map repository"}
            </button>
            {!repos.length && (
              <p>
                No writable repositories available yet. Authorize GitHub and
                install the App on repositories you can push to.
              </p>
            )}
          </form>
          {progress && (
            <section className="connect-step" aria-live="polite">
              <h2>
                {progress.status === "discovering"
                  ? "Discovering files"
                  : progress.status === "indexing"
                    ? "Indexing source"
                    : progress.status === "resolving"
                      ? "Resolving relationships"
                      : progress.status === "ready"
                        ? "Map ready"
                        : "Indexing stopped"}
              </h2>
              <p>
                {progress.name} · commit {progress.revision?.slice(0, 8)}
              </p>
              {progress.status === "discovering" ? (
                <progress aria-label="Discovering repository" />
              ) : (
                <progress
                  aria-label="Indexing progress"
                  max={Math.max(1, progress.files)}
                  value={
                    progress.status === "resolving"
                      ? progress.resolved
                      : progress.processed
                  }
                />
              )}
              <p>
                {progress.status === "resolving"
                  ? progress.resolved
                  : progress.processed}{" "}
                / {progress.files} files ·{" "}
                {(progress.sourceBytes / 1_000_000).toFixed(1)} MB discovered ·{" "}
                {progress.excluded} metadata-only entries
              </p>
              <p>
                Progress is saved in the cloud. You can close this page and
                return to the repository below.
              </p>
              {progress.error && <p role="status">{progress.error}</p>}
              {progress.previousMapAvailable && (
                <button
                  className="secondary"
                  onClick={() => void act(() => onMapped(progress.id))}
                >
                  Open previous complete map
                </button>
              )}
            </section>
          )}
          {!!connected.length && (
            <div className="repo-list">
              <h2>Your indexed repositories</h2>
              {connected.map((r) => (
                <button
                  key={r.id}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const next = await api("/api/tools/index_status", {
                        repoId: r.id,
                      });
                      if (next.status === "ready") await onMapped(r.id);
                      else {
                        setProgress(next);
                        setTracking(r.id);
                      }
                    })
                  }
                >
                  {r.name}
                  <span>{r.branch}</span>
                </button>
              ))}
            </div>
          )}
          <details className="connect-step">
            <summary>Disconnect GitHub</summary>
            <p>
              Stops source access and synchronization here. Existing encrypted
              indexes remain until deleted. To revoke the GitHub authorization
              itself, use GitHub’s Authorized GitHub Apps settings.
            </p>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (confirm("Disconnect GitHub from this Caelogram account?"))
                  void act(async () => {
                    await api("/api/github/disconnect", {});
                    setRepos([]);
                    setConnected([]);
                  });
              }}
            >
              Disconnect
            </button>
          </details>
        </>
      )}
    </section>
  );
}
