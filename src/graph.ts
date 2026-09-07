import ts from "typescript";
import { exclusion, extractPortable } from "./inventory.js";
import path from "node:path";
import { digest, redact, safePath, sensitivePath, Fault } from "./security.js";
import type {
  Component,
  Graph,
  Relation,
  SourceFile,
  Context,
  PlanEntry,
  RepositoryBrief,
} from "./types.js";
const code = /\.[cm]?[jt]sx?$/;
export const eligible = (p: string) => exclusion(p, 0) === null;
export const tokens = (s: string) =>
  Math.ceil(Buffer.byteLength(s, "utf8") / 3); // Estimate, not model billing.
export function index(
  files: SourceFile[],
  revision: string,
  previous?: Graph,
  limits?: { maxNodes: number; maxEdges: number },
  onImport?: (specifier: string) => void,
): Graph {
  const nodes: Component[] = [],
    edges: Relation[] = [],
    warnings: string[] = [];
  const selected = files
    .filter((f) => eligible(f.path) && Buffer.byteLength(f.content) <= 256_000)
    .map((f) => ({ ...f, content: redact(f.content) }));
  const paths = new Set(selected.map((f) => f.path));
  let parsed = 0,
    reused = 0;
  const edge = (
    from: string,
    to: string,
    kind: Relation["kind"],
    evidence: string,
    confidence = 1,
  ) => edges.push({ from, to, kind, evidence, confidence, revision });
  for (const file of selected) {
    const source = code.test(file.path)
      ? ts.createSourceFile(
          file.path,
          file.content,
          ts.ScriptTarget.Latest,
          false,
        )
      : undefined;
    const old = previous?.files.find(
      (f) => f.path === file.path && f.sha === file.sha,
    );
    if (old) {
      reused++;
      nodes.push(...previous!.nodes.filter((n) => n.path === file.path));
    } else {
      parsed++;
      const node: Component = {
        id: file.path,
        name: path.posix.basename(file.path),
        path: file.path,
        kind: "file",
        start: 1,
        end: file.content.split("\n").length,
        subsystem: path.posix.dirname(file.path),
        exported: false,
      };
      nodes.push(node);
      if (source) {
        const visit = (n: ts.Node) => {
          let kind: Component["kind"] | undefined;
          if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n))
            kind = "function";
          else if (ts.isClassDeclaration(n)) kind = "class";
          else if (ts.isInterfaceDeclaration(n)) kind = "interface";
          else if (ts.isTypeAliasDeclaration(n)) kind = "type";
          else if (ts.isVariableDeclaration(n)) kind = "variable";
          const name = (n as ts.NamedDeclaration).name;
          if (kind && name && ts.isIdentifier(name)) {
            const start =
              source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
            nodes.push({
              ...node,
              id: `${file.path}#${name.text}:${start}:${n.getStart(source)}`,
              name: name.text,
              kind,
              start,
              end: source.getLineAndCharacterOfPosition(n.end).line + 1,
              exported: false,
            });
            nodes[nodes.length - 1].exported =
              ts.canHaveModifiers(n) &&
              !!ts
                .getModifiers(n)
                ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          }
          ts.forEachChild(n, visit);
          if (limits && nodes.length > limits.maxNodes)
            throw new Fault(
              413,
              "Hosted symbol budget exceeded; no partial index was published. Use caelogram map locally.",
            );
        };
        visit(source);
      }
    }
    for (const n of nodes.filter(
      (n) => n.path === file.path && n.kind !== "file",
    ))
      edge(file.path, n.id, "contains", `AST declaration at line ${n.start}`);
    if (!source) {
      const extracted = extractPortable(file.path, file.content);
      nodes.push(...extracted.nodes);
      warnings.push(...extracted.warnings);
      for (const n of extracted.nodes)
        edge(
          file.path,
          n.id,
          "contains",
          `Lexical declaration at line ${n.start}`,
          n.confidence ?? 0.8,
        );
      continue;
    }
    // Always resolve imports against the new file set: a newly added module can resolve an old import.
    const resolve = (specifier: string) => {
      onImport?.(specifier);
      if (!specifier.startsWith(".")) {
        if (specifier.startsWith("@") || specifier.startsWith("~"))
          warnings.push(
            `${file.path}: package or alias ${specifier} is not resolved by the MVP`,
          );
        return;
      }
      const base = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.path), specifier),
      );
      const stem = base.replace(/\.[cm]?js$/, "");
      const target = [
        base,
        stem + ".ts",
        stem + ".tsx",
        stem + ".js",
        stem + ".jsx",
        base + "/index.ts",
        base + "/index.tsx",
        base + "/index.js",
        base + ".json",
      ].find((p) => paths.has(p));
      if (target)
        edge(
          file.path,
          target,
          /test|spec/.test(file.path) ? "tests" : "imports",
          `Static module specifier ${specifier}`,
        );
      else warnings.push(`${file.path}: unresolved import ${specifier}`);
    };
    const visit = (n: ts.Node) => {
      if (
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier &&
        ts.isStringLiteral(n.moduleSpecifier)
      )
        resolve(n.moduleSpecifier.text);
      if (
        ts.isCallExpression(n) &&
        (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
          n.expression.getText(source) === "require")
      ) {
        if (n.arguments[0] && ts.isStringLiteral(n.arguments[0]))
          resolve(n.arguments[0].text);
        else
          warnings.push(
            `${file.path}: runtime module discovery; incoming references are incomplete`,
          );
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
    if (limits && edges.length > limits.maxEdges)
      throw new Fault(
        413,
        "Hosted relationship budget exceeded; no partial index was published. Use caelogram map locally.",
      );
  }
  if (files.length !== selected.length)
    warnings.push(
      `${files.length - selected.length} files excluded by type, size, or sensitive-path policy`,
    );
  warnings.push(
    "Static imports and AST declarations only. Calls, framework routes, runtime discovery, aliases, and coverage are not proven.",
  );
  return {
    revision,
    nodes,
    edges,
    files: selected,
    warnings: [...new Set(warnings)],
    parsed,
    reused,
    indexedAt: new Date().toISOString(),
  };
}

/**
 * Compact orientation record: subsystems, hub files, entrypoints and shape.
 * Every number is counted from indexed nodes and edges; nothing is inferred.
 * The result is trimmed until it serializes within `budget` estimated tokens,
 * and whatever is dropped is listed in `truncated`.
 */
export const BRIEF_BUDGET = 700;
export function brief(
  graph: Graph,
  identity: { id: string; name: string; branch: string; status: string },
  budget = BRIEF_BUDGET,
): RepositoryBrief {
  const files = graph.nodes.filter((n) => n.kind === "file");
  const symbols = new Map<string, number>();
  for (const n of graph.nodes)
    if (n.kind !== "file") symbols.set(n.path, (symbols.get(n.path) ?? 0) + 1);
  const links = [
    ...new Map(
      graph.edges
        .filter((e) => e.kind !== "contains" && e.from !== e.to)
        .map((e) => [e.from + "\0" + e.to + "\0" + e.kind, e]),
    ).values(),
  ];
  const incoming = new Map<string, number>(),
    outgoing = new Map<string, number>();
  for (const e of links) {
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
    outgoing.set(e.from, (outgoing.get(e.from) ?? 0) + 1);
  }
  const groups = new Map<string, { files: number; symbols: number }>();
  const languages = new Map<string, number>();
  for (const f of files) {
    const g = groups.get(f.subsystem) ?? { files: 0, symbols: 0 };
    g.files++;
    g.symbols += symbols.get(f.path) ?? 0;
    groups.set(f.subsystem, g);
    const ext = f.path.includes(".")
      ? f.path.slice(f.path.lastIndexOf("."))
      : "(none)";
    languages.set(ext, (languages.get(ext) ?? 0) + 1);
  }
  const record: RepositoryBrief = {
    ...identity,
    revision: graph.revision,
    indexedAt: graph.indexedAt,
    files: files.length,
    symbols: graph.nodes.length - files.length,
    relationships: links.length,
    subsystems: [...groups]
      .map(([path, g]) => ({ path, ...g }))
      .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
      .slice(0, 10),
    hubs: files
      .map((f) => ({ path: f.path, dependents: incoming.get(f.path) ?? 0 }))
      .filter((h) => h.dependents > 0)
      .sort(
        (a, b) => b.dependents - a.dependents || a.path.localeCompare(b.path),
      )
      .slice(0, 8),
    entrypoints: files
      .filter((f) => !incoming.get(f.path) && (outgoing.get(f.path) ?? 0) > 0)
      .map((f) => ({
        path: f.path,
        evidence: `No incoming static import at this revision; ${outgoing.get(f.path)} outgoing`,
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 6),
    languages: [...languages]
      .map(([extension, count]) => ({ extension, files: count }))
      .sort(
        (a, b) => b.files - a.files || a.extension.localeCompare(b.extension),
      )
      .slice(0, 6),
    warnings: graph.warnings.slice(0, 3),
    truncated: [],
    next: "Structure is only available through map_page (50 files), find_component (30 matches) and begin_change. No tool returns the whole graph.",
  };
  const note = noteOmission(record);
  note(
    "subsystems",
    groups.size - record.subsystems.length,
    "Only the largest directories are listed; page the map for the rest",
  );
  note(
    "hub files",
    [...incoming.values()].length - record.hubs.length,
    "Only the most-depended-on files are listed",
  );
  note(
    "entrypoints",
    files.filter(
      (f) => !incoming.get(f.path) && (outgoing.get(f.path) ?? 0) > 0,
    ).length - record.entrypoints.length,
    "Only the first entrypoints by path are listed",
  );
  note(
    "index warnings",
    Math.max(0, graph.warnings.length - record.warnings.length),
    "Inspect map_page for the remaining index warnings",
  );
  return fitBrief(record, budget);
}
/** Append a truthful omission note, merging repeats of the same kind. */
export const noteOmission =
  (record: { truncated: { what: string; why: string; count?: number }[] }) =>
  (what: string, count: number, why: string) => {
    if (count <= 0) return;
    const existing = record.truncated.find((t) => t.what === what);
    if (existing) existing.count = (existing.count ?? 0) + count;
    else record.truncated.push({ what, why, count });
  };
/**
 * Shrink a brief until it serializes inside `budget`, always by dropping the
 * tail of the longest list and recording exactly what was dropped.
 */
export function fitBrief(
  record: RepositoryBrief,
  budget = BRIEF_BUDGET,
): RepositoryBrief {
  const note = noteOmission(record);
  const lists: [keyof RepositoryBrief, string][] = [
    ["languages", "file extensions"],
    ["entrypoints", "entrypoints"],
    ["hubs", "hub files"],
    ["subsystems", "subsystems"],
    ["warnings", "index warnings"],
  ];
  while (tokens(JSON.stringify(record)) > budget) {
    const target = lists
      .map(([key]) => key)
      .filter((key) => (record[key] as unknown[]).length > 1)
      .sort(
        (a, b) =>
          (record[b] as unknown[]).length - (record[a] as unknown[]).length,
      )[0];
    if (!target) break;
    (record[target] as unknown[]).pop();
    note(
      lists.find(([key]) => key === target)![1],
      1,
      "Trimmed to fit the brief token bound",
    );
  }
  return record;
}
export function impact(graph: Graph, paths: string[], depth = 2) {
  const reasons = new Map(paths.map((p) => [p, "Direct task match"]));
  let frontier = paths;
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const e of graph.edges) {
      if (e.kind === "contains") continue;
      const other = frontier.includes(e.from)
        ? e.to
        : frontier.includes(e.to)
          ? e.from
          : null;
      if (other && !reasons.has(other)) {
        reasons.set(
          other,
          `${e.kind}: ${e.from} → ${e.to} (distance ${d + 1})`,
        );
        next.push(other);
      }
    }
    frontier = next;
  }
  return reasons;
}
const STOP = new Set([
  "the",
  "and",
  "with",
  "for",
  "add",
  "change",
  "update",
  "please",
  "should",
  "that",
  "this",
  "from",
  "into",
  "make",
  "when",
  "where",
  "have",
  "need",
  "code",
  "file",
  "files",
]);
/** Task words, split on camelCase, deduplicated, stop words removed. */
export function terms(prompt: string) {
  return [
    ...new Set(
      prompt
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .match(/[a-z0-9_]{3,}/g)
        ?.filter((w) => !STOP.has(w)) ?? [],
    ),
  ].slice(0, 12);
}
const occurrences = (haystack: string, needle: string) => {
  let count = 0,
    at = haystack.indexOf(needle);
  while (at >= 0 && count < 20) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
};
/**
 * Rank indexed files against the task words. Every point of score comes from
 * an observed match in this snapshot: a path segment, a declared name, or a
 * literal source occurrence. Rare words weigh more than words that appear
 * everywhere, so a term like "checkout" outranks a term like "service".
 * No semantic similarity is claimed; unmatched files score zero.
 */
export function rank(graph: Graph, words: string[]) {
  const symbolsByFile = new Map<string, Component[]>();
  for (const n of graph.nodes)
    if (n.kind !== "file") {
      const list = symbolsByFile.get(n.path);
      if (list) list.push(n);
      else symbolsByFile.set(n.path, [n]);
    }
  const lowered = graph.files.map((f) => ({
    path: f.path,
    lowerPath: f.path.toLowerCase(),
    lowerContent: f.content.toLowerCase(),
    segments: new Set(
      f.path
        .toLowerCase()
        .split(/[/.\-_]+/)
        .filter(Boolean),
    ),
    symbols: symbolsByFile.get(f.path) ?? [],
  }));
  const total = lowered.length || 1;
  const weight = new Map(
    words.map((w) => {
      const df = lowered.filter(
        (f) => f.lowerPath.includes(w) || f.lowerContent.includes(w),
      ).length;
      return [w, Math.log(1 + total / (1 + df))];
    }),
  );
  return lowered
    .map((f) => {
      let score = 0;
      const evidence: string[] = [];
      for (const w of words) {
        const idf = weight.get(w) ?? 0;
        if (!idf) continue;
        if (f.segments.has(w)) {
          score += 10 * idf;
          evidence.push(`path segment "${w}"`);
        } else if (f.lowerPath.includes(w)) {
          score += 5 * idf;
          evidence.push(`path contains "${w}"`);
        }
        const named = f.symbols.filter((n) => n.name.toLowerCase() === w);
        const partial = f.symbols.filter(
          (n) => n.name.toLowerCase() !== w && n.name.toLowerCase().includes(w),
        );
        if (named.length) {
          score += 8 * idf * Math.min(named.length, 2);
          evidence.push(
            `declared ${named[0].kind}${named[0].exported ? " (exported)" : ""} "${named[0].name}"`,
          );
        } else if (partial.length) {
          score += 3 * idf * Math.min(partial.length, 2);
          evidence.push(
            `declaration name contains "${w}" (${partial[0].name})`,
          );
        }
        const hits = occurrences(f.lowerContent, w);
        if (hits) {
          score += 0.8 * idf * Math.min(hits, 5);
          evidence.push(`${hits} source occurrence(s) of "${w}"`);
        }
      }
      return { path: f.path, score, evidence: evidence.slice(0, 3).join("; ") };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}
export function context(graph: Graph, prompt: string, budget = 6000): Context {
  const requestedBudget = budget;
  budget = Math.floor(budget * 0.7);
  const words = terms(prompt);
  const ranked = rank(graph, words);
  const seeds = ranked
    .filter((f, i) => i < 3 && f.score >= ranked[0].score * 0.25)
    .map((f) => f.path);
  const reasons = impact(graph, seeds);
  const lexical = new Map(ranked.map((f) => [f.path, f]));
  // Seeds first, then neighbours ordered by their own evidenced lexical score,
  // so the budget is spent on the files the index can actually justify.
  const candidates = [...reasons]
    .filter(([p]) => graph.files.some((f) => f.path === p))
    .sort(
      (a, b) =>
        Number(seeds.includes(b[0])) - Number(seeds.includes(a[0])) ||
        (lexical.get(b[0])?.score ?? 0) - (lexical.get(a[0])?.score ?? 0) ||
        a[0].localeCompare(b[0]),
    );
  const items: Context["items"] = [],
    omitted: Context["omitted"] = [],
    plan: PlanEntry[] = [];
  let used = 0;
  const record = (
    path: string,
    reason: string,
    estimatedTokens: number,
    status: PlanEntry["status"],
  ) =>
    plan.push({
      path,
      rank: plan.length + 1,
      score: Math.round((lexical.get(path)?.score ?? 0) * 10) / 10,
      reason,
      evidence:
        lexical.get(path)?.evidence ||
        "Static module relationship only; no task word matched this file",
      estimatedTokens,
      status,
    });
  for (const [p, reason] of candidates) {
    const file = graph.files.find((f) => f.path === p)!;
    const cost = tokens(file.content) + tokens(reason + p) + 60;
    const perFile = Math.max(
      180,
      Math.floor(budget / Math.min(candidates.length, 8)),
    );
    if (cost > perFile) {
      const lines = file.content.split("\n");
      const candidateNodes = graph.nodes
        .filter((n) => n.path === p && n.kind !== "file")
        .map((n) => ({
          node: n,
          score: words.reduce(
            (score, w) => score + (n.name.toLowerCase().includes(w) ? 5 : 0),
            0,
          ),
        }))
        .sort((a, b) => b.score - a.score);
      const anchor = candidateNodes[0]?.score
        ? candidateNodes[0].node.start - 1
        : Math.max(
            0,
            lines.findIndex((line) =>
              words.some((w) => line.toLowerCase().includes(w)),
            ),
          );
      const start = Math.max(0, anchor - 3);
      let end = start,
        excerpt = "";
      const allowance =
        Math.min(perFile, budget - used) - tokens(reason + p) - 90;
      while (
        end < lines.length &&
        end - start < 100 &&
        tokens(excerpt + lines[end] + "\n") <= allowance
      ) {
        excerpt += lines[end] + "\n";
        end++;
      }
      if (excerpt) {
        const excerptReason =
          reason +
          "; bounded excerpt, request more lines before replacing this file";
        const amount = tokens(excerpt) + tokens(excerptReason + p) + 60;
        used += amount;
        items.push({
          path: p,
          reason: excerptReason,
          required: seeds.includes(p),
          content: excerpt,
          start: start + 1,
          end,
          estimatedTokens: amount,
        });
        record(p, excerptReason, amount, "excerpted");
        continue;
      }
    }
    if (used + cost > budget) {
      omitted.push({
        path: p,
        reason:
          "Related component exceeds context budget; request a bounded section before editing its contract",
      });
      record(
        p,
        reason + "; not delivered, read_section it if you can justify it",
        cost,
        "omitted",
      );
      continue;
    }
    used += cost;
    items.push({
      path: p,
      reason,
      required: seeds.includes(p),
      content: file.content,
      start: 1,
      end: file.content.split("\n").length,
      estimatedTokens: cost,
    });
    record(p, reason, cost, "included");
  }
  const result: Context = {
    revision: graph.revision,
    items,
    omitted: omitted.slice(0, 8),
    omittedCount: omitted.length,
    estimatedTokens: used,
    sourceTokens: graph.files.reduce((s, f) => s + tokens(f.content), 0),
    budget,
    seedIds: seeds,
    plan: plan.slice(0, 20),
    planCount: plan.length,
    warnings: [
      ...(!seeds.length
        ? [
            "No confident starting component found. Use find_component or bounded source_search.",
          ]
        : []),
      ...graph.warnings.slice(0, 20),
      ...(graph.warnings.length > 20
        ? [
            `${graph.warnings.length - 20} additional index warnings; inspect the repository map for details`,
          ]
        : []),
      ...(items.some((i) => i.reason.includes("bounded excerpt"))
        ? [
            "Context includes bounded excerpts; source outside these line ranges has not been supplied.",
          ]
        : []),
      ...(omitted.length
        ? ["Context is incomplete: budget omitted related components."]
        : []),
    ],
  };
  result.budget = requestedBudget;
  // Budget the complete serialized package, including explanations, the plan
  // and omission metadata.
  result.warnings = result.warnings.slice(0, 5);
  if (omitted.length > 8)
    result.warnings.push(
      `${omitted.length} related files omitted; first 8 listed. Use expand_impact to inspect the rest.`,
    );
  const over = () => tokens(JSON.stringify(result)) + 8 > requestedBudget;
  while (over() && result.items.length) {
    const removed = result.items.pop()!;
    result.omittedCount++;
    const entry = result.plan?.find((e) => e.path === removed.path);
    if (entry) {
      entry.status = "omitted";
      entry.reason =
        "Serialized context budget exceeded; read_section this file if you can justify it";
    }
    if (result.omitted.length < 8)
      result.omitted.push({
        path: removed.path,
        reason: "Serialized context budget exceeded; request a section",
      });
  }
  while (over() && (result.plan?.length ?? 0) > 1) result.plan!.pop();
  while (over() && result.omitted.length > 1) result.omitted.pop();
  while (over() && result.warnings.length > 1) result.warnings.pop();
  if (over() && result.plan?.length) result.plan = [];
  if (
    result.omittedCount &&
    !result.warnings.some((w) => w.includes("incomplete"))
  )
    result.warnings[0] =
      "Context is incomplete; related components were omitted by budget.";
  result.estimatedTokens = tokens(
    JSON.stringify({ ...result, estimatedTokens: requestedBudget }),
  );
  return result;
}
export const sourceFile = (path: string, content: string): SourceFile => ({
  path,
  content,
  sha: digest(content),
});
