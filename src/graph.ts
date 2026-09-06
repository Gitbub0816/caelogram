import ts from "typescript";
import path from "node:path";
import { digest, redact, safePath, sensitivePath } from "./security.js";
import type {
  Component,
  Graph,
  Relation,
  SourceFile,
  Context,
} from "./types.js";
const code = /\.[cm]?[jt]sx?$/;
const supported = /\.(?:[cm]?[jt]sx?|json|sql|md|ya?ml|toml|css|html)$/;
export const eligible = (p: string) =>
  safePath(p) &&
  !sensitivePath(p) &&
  supported.test(p) &&
  !/(^|\/)(node_modules|vendor|dist|build|\.git)(\/|$)|(?:package-lock|pnpm-lock|yarn\.lock)/.test(
    p,
  );
export const tokens = (s: string) =>
  Math.ceil(Buffer.byteLength(s, "utf8") / 3); // Estimate, not model billing.
export function index(
  files: SourceFile[],
  revision: string,
  previous?: Graph,
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
      if (code.test(file.path)) {
        const source = ts.createSourceFile(
          file.path,
          file.content,
          ts.ScriptTarget.Latest,
          true,
        );
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
              source.getLineAndCharacterOfPosition(n.getStart()).line + 1;
            nodes.push({
              ...node,
              id: `${file.path}#${name.text}:${start}:${n.getStart()}`,
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
        };
        visit(source);
      }
    }
    for (const n of nodes.filter(
      (n) => n.path === file.path && n.kind !== "file",
    ))
      edge(file.path, n.id, "contains", `AST declaration at line ${n.start}`);
    if (!code.test(file.path)) continue;
    // Always resolve imports against the new file set: a newly added module can resolve an old import.
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
    );
    const resolve = (specifier: string) => {
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
export function context(graph: Graph, prompt: string, budget = 6000): Context {
  const requestedBudget = budget;
  budget = Math.floor(budget * 0.7);
  const words =
    prompt
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9_]{3,}/g)
      ?.filter(
        (w) =>
          ![
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
          ].includes(w),
      ) ?? [];
  const ranked = graph.files
    .map((f) => ({
      path: f.path,
      score: words.reduce(
        (s, w) =>
          s +
          (f.path.toLowerCase().includes(w) ? 8 : 0) +
          graph.nodes.filter(
            (n) => n.path === f.path && n.name.toLowerCase().includes(w),
          ).length *
            4 +
          (f.content.toLowerCase().includes(w) ? 1 : 0),
        0,
      ),
    }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const seeds = ranked.slice(0, 3).map((f) => f.path),
    reasons = impact(graph, seeds);
  const items: Context["items"] = [],
    omitted: Context["omitted"] = [];
  let used = 0;
  for (const [p, reason] of reasons) {
    const file = graph.files.find((f) => f.path === p);
    if (!file) continue;
    const cost = tokens(file.content) + tokens(reason + p) + 60;
    const perFile = Math.max(
      180,
      Math.floor(budget / Math.min(reasons.size, 8)),
    );
    if (cost > perFile) {
      const lines = file.content.split("\n");
      const candidates = graph.nodes
        .filter((n) => n.path === p && n.kind !== "file")
        .map((n) => ({
          node: n,
          score: words.reduce(
            (score, w) => score + (n.name.toLowerCase().includes(w) ? 5 : 0),
            0,
          ),
        }))
        .sort((a, b) => b.score - a.score);
      const anchor = candidates[0]?.score
        ? candidates[0].node.start - 1
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
        continue;
      }
    }
    if (used + cost > budget) {
      omitted.push({
        path: p,
        reason:
          "Related component exceeds context budget; request a bounded section before editing its contract",
      });
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
  // Budget the complete serialized package, including explanations and omission metadata.
  result.warnings = result.warnings.slice(0, 5);
  if (omitted.length > 8)
    result.warnings.push(
      `${omitted.length} related files omitted; first 8 listed. Use expand_impact to inspect the rest.`,
    );
  while (
    tokens(JSON.stringify(result)) + 8 > requestedBudget &&
    result.items.length
  ) {
    const removed = result.items.pop()!;
    result.omittedCount++;
    if (result.omitted.length < 8)
      result.omitted.push({
        path: removed.path,
        reason: "Serialized context budget exceeded; request a section",
      });
  }
  while (
    tokens(JSON.stringify(result)) + 8 > requestedBudget &&
    result.omitted.length > 1
  )
    result.omitted.pop();
  while (
    tokens(JSON.stringify(result)) + 8 > requestedBudget &&
    result.warnings.length > 1
  )
    result.warnings.pop();
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
