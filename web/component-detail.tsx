import type { Body } from "./galaxy-model";
import type { MapData } from "./Galaxy";

export type Link = {
  path: string;
  kind: string;
  evidence: string;
  confidence: number;
};
export type ComponentDetail = {
  path: string;
  name: string;
  kind: string;
  subsystem: string;
  start: number;
  end: number;
  bytes: number;
  analysis?: string;
  exclusionReason?: string;
  symbols: {
    id: string;
    name: string;
    kind: string;
    start: number;
    end: number;
  }[];
  incoming: Link[];
  outgoing: Link[];
};

// Sample data and any already-loaded map page carry the whole graph, so the
// same shape can be assembled without a round trip.
export function detailFromMapData(
  data: MapData,
  path: string,
): ComponentDetail | null {
  const file = data.nodes.find((n) => n.kind === "file" && n.path === path);
  if (!file) return null;
  const link = (e: MapData["edges"][number], other: string): Link => ({
    path: other,
    kind: e.kind,
    evidence: e.evidence,
    confidence: e.confidence ?? 1,
  });
  return {
    path: file.path,
    name: file.name,
    kind: file.kind,
    subsystem: file.subsystem,
    start: file.start,
    end: file.end,
    bytes: file.bytes ?? 0,
    analysis: file.analysis,
    exclusionReason: file.exclusionReason,
    symbols: data.nodes
      .filter((n) => n.path === path && n.kind !== "file")
      .map(({ id, name, kind, start, end }) => ({
        id,
        name,
        kind,
        start,
        end,
      })),
    incoming: data.edges
      .filter((e) => e.to === path && e.kind !== "contains")
      .map((e) => link(e, e.from)),
    outgoing: data.edges
      .filter((e) => e.from === path && e.kind !== "contains")
      .map((e) => link(e, e.to)),
  };
}

export function ComponentInspector({
  detail,
  body,
  error,
  revision,
  relevance,
  onSelect,
  onFocus,
  children,
}: {
  detail: ComponentDetail | null;
  body?: Body;
  error?: string;
  revision: string;
  relevance?: { required: boolean; reason: string };
  onSelect: (path: string) => void;
  onFocus: (path: string) => void;
  children?: React.ReactNode;
}) {
  if (!detail && !body)
    return (
      <div className="empty">
        <p>Select a file to inspect its relationships.</p>
      </div>
    );
  const path = detail?.path ?? body!.path;
  const name = detail?.name ?? body!.name;
  const incoming = detail?.incoming ?? [];
  const outgoing = detail?.outgoing ?? [];
  // The galaxy already knows the degree even before the detail lands, so the
  // counts do not flicker while the request is in flight.
  const incomingCount = detail ? incoming.length : (body?.incoming ?? 0);
  const outgoingCount = detail ? outgoing.length : (body?.outgoing ?? 0);
  return (
    <>
      <div className="component-emblem">
        <img src="/mark.png" alt="" />
      </div>
      <h2>{name}</h2>
      <p className="path">{path}</p>
      <span className="pill">{body?.bodyClass ?? detail?.kind}</span>
      {relevance && (
        <span className="pill gold">
          {relevance.required ? "Starting component" : "Related context"}
        </span>
      )}
      {detail?.analysis && <p>Analysis: {detail.analysis}</p>}
      {detail?.exclusionReason && <p role="note">{detail.exclusionReason}</p>}
      <dl>
        <div>
          <dt>Subsystem</dt>
          <dd>{detail?.subsystem ?? body!.directory}</dd>
        </div>
        <div>
          <dt>Incoming links</dt>
          <dd>{incomingCount}</dd>
        </div>
        <div>
          <dt>Dependencies</dt>
          <dd>{outgoingCount}</dd>
        </div>
        <div>
          <dt>Declarations</dt>
          <dd>{detail ? detail.symbols.length : "…"}</dd>
        </div>
        {body && (
          <div>
            <dt>File type</dt>
            <dd>{body.category}</dd>
          </div>
        )}
        <div>
          <dt>Test coverage</dt>
          <dd>Unknown</dd>
        </div>
      </dl>
      {body && (
        <div className="inspector-section">
          <h3>Why it looks this way</h3>
          <p>
            {body.incoming} files import this one across the repository, so the
            galaxy renders it as a {body.bodyClass} and places it{" "}
            {body.depth < 0.34
              ? "near the core"
              : body.depth > 0.7
                ? "out toward the rim"
                : "mid-disk"}
            .
          </p>
          <button className="secondary full" onClick={() => onFocus(body.path)}>
            Focus on its neighbourhood
          </button>
        </div>
      )}
      {relevance && (
        <div className="inspector-section relevance">
          <h3>Included in your task</h3>
          <p>{relevance.reason}</p>
        </div>
      )}
      <div className="inspector-section">
        <h3>
          Connected components <span>{incomingCount + outgoingCount}</span>
        </h3>
        {!detail && !error && <p className="muted">Resolving relationships…</p>}
        {error && <p role="note">{error}</p>}
        {[...incoming, ...outgoing].slice(0, 12).map((e, i) => (
          <button className="relation" key={i} onClick={() => onSelect(e.path)}>
            <span>{e.kind === "tests" ? "┄" : "↗"}</span>
            <div>
              {e.path.split("/").pop()}
              <small>
                {e.kind} · {Math.round(e.confidence * 100)}% evidence confidence
              </small>
            </div>
          </button>
        ))}
        {detail && !incoming.length && !outgoing.length && (
          <p>
            No resolved static module links. This does not establish that the
            file is unused.
          </p>
        )}
      </div>
      {!!detail?.symbols.length && (
        <div className="inspector-section">
          <h3>
            Declarations <span>{detail.symbols.length}</span>
          </h3>
          {detail.symbols.slice(0, 14).map((s) => (
            <div className="symbol" key={s.id}>
              <span>{s.name}</span>
              <small>
                {s.kind} · L{s.start}–{s.end}
              </small>
            </div>
          ))}
        </div>
      )}
      {children}
      <div className="evidence-note">
        STATIC EVIDENCE
        <span>
          Valid at {revision.slice(0, 8)}. Import resolution does not establish
          runtime reachability.
        </span>
      </div>
    </>
  );
}
