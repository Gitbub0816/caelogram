import { useEffect, useState } from "react";
import type { Identity } from "./Auth";
type Token = {
  id: string;
  label: string;
  repositories: string[];
  scopes: string[];
  expires: number;
};
export default function AgentAccess({ identity }: { identity: Identity }) {
  const [tokens, setTokens] = useState<Token[]>([]),
    [repos, setRepos] = useState<{ name: string }[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [label, setLabel] = useState("My coding agent"),
    [publish, setPublish] = useState(false),
    [hours, setHours] = useState(1),
    [issued, setIssued] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function api(path: string, method = "GET", body?: unknown) {
    const token = await identity.getToken();
    const response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
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
  useEffect(() => {
    void act(async () => {
      setTokens(await api("/api/agent-tokens"));
      setRepos((await api("/api/github/repositories")).repositories);
    });
  }, []);
  return (
    <article className="agent-access">
      <h2>Agent access</h2>
      <p>
        Create a short-lived Caelogram token for your CLI or MCP client. This is
        not a GitHub credential. Every request also checks your current GitHub
        access.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            setIssued("");
            const x = await api("/api/agent-tokens", "POST", {
              label,
              repositories: selected,
              publish,
              hours,
            });
            setIssued(x.token);
            setTokens(await api("/api/agent-tokens"));
          });
        }}
      >
        <label>
          Token name
          <input
            required
            maxLength={80}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <fieldset>
          <legend>Repository access</legend>
          {repos.map((r) => (
            <label className="check" key={r.name}>
              <input
                type="checkbox"
                checked={selected.includes(r.name)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, r.name]
                      : selected.filter((n) => n !== r.name),
                  )
                }
              />
              {r.name}
            </label>
          ))}
          {!repos.length && <p>Connect GitHub to select repositories.</p>}
        </fieldset>
        <label>
          Expires after
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            <option value={1}>1 hour</option>
            <option value={4}>4 hours</option>
            <option value={8}>8 hours</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={publish}
            onChange={(e) => setPublish(e.target.checked)}
          />
          Allow publishing validated draft pull requests
        </label>
        {publish && (
          <p className="muted">
            The agent may create GitHub branches and draft PRs after validation
            and warning acknowledgment. It cannot merge or change the default
            branch.
          </p>
        )}
        <button className="primary" disabled={busy || !selected.length}>
          Create agent token
        </button>
      </form>
      {issued && (
        <div className="token-issued">
          <p role="status">
            Copy this token now. It is only shown once. Do not paste it into an
            AI conversation or commit it.
          </p>
          <input
            aria-label="New agent token"
            readOnly
            value={issued}
            onFocus={(e) => e.target.select()}
          />
          <button
            className="secondary"
            onClick={() =>
              void act(() => navigator.clipboard.writeText(issued))
            }
          >
            Copy token
          </button>
          <button className="secondary" onClick={() => setIssued("")}>
            Hide token
          </button>
        </div>
      )}
      <p>
        In your terminal, set <code>CAELOGRAM_TOKEN</code> to the token, then:
      </p>
      <code>caelogram login --url {location.origin}</code>
      <p>
        MCP endpoint: <code>{location.origin}/mcp</code>. Use the same token as
        a Bearer authorization header. Keep it in the client’s credential or
        environment configuration.
      </p>
      {tokens.map((t) => (
        <div className="connect-step" key={t.id}>
          <strong>{t.label}</strong>
          <p>
            {t.repositories.join(", ")} ·{" "}
            {t.scopes.includes("publish")
              ? "Draft PR publication enabled"
              : "Context and changesets only"}
          </p>
          <p>Expires {new Date(t.expires).toLocaleString()}</p>
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api("/api/agent-tokens/" + t.id, "DELETE");
                setTokens(tokens.filter((x) => x.id !== t.id));
                setIssued("");
              })
            }
          >
            Revoke
          </button>
        </div>
      ))}
    </article>
  );
}
