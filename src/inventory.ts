import { posix } from "node:path";
import { safePath, sensitivePath, redact } from "./security.js";
import type { Component } from "./types.js";

export const ANALYZER_VERSION = 2;
export const FILE_LIMIT = 256_000;
export type Reference = {
  from?: string;
  value: string;
  evidence: string;
  confidence: number;
  kind: "imports" | "references";
};
export function exclusion(
  path: string,
  size: number,
  mode = "100644",
  type = "blob",
): string | null {
  if (!safePath(path)) return "Unsafe or unsupported repository path";
  if (sensitivePath(path)) return "Sensitive path: contents never downloaded";
  if (type === "commit") return "Submodule: external repository not traversed";
  if (!["100644", "100755"].includes(mode))
    return "Symlink or unsupported Git entry: contents not followed";
  if (
    /(^|\/)(node_modules|vendor|dist|build|bin|obj|\.git)(\/|$)|(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(
      path,
    )
  )
    return "Dependency, generated output, or lockfile";
  if (
    /\.(png|jpe?g|gif|webp|ico|avif|pdf|woff2?|ttf|eot|mp[34]|wav|zip|gz|7z|exe|dll|so|dylib|wasm|pdb|nupkg|sqlite|db)$/i.test(
      path,
    )
  )
    return "Binary or media asset: metadata and incoming references retained";
  if (!Number.isSafeInteger(size) || size < 0) return "Unknown file size";
  if (size > FILE_LIMIT)
    return `File exceeds ${FILE_LIMIT} byte source limit; metadata and incoming references retained`;
  return null;
}
export function fileNode(path: string, bytes = 0, reason?: string): Component {
  return {
    id: path,
    name: posix.basename(path),
    path,
    kind: "file",
    start: 1,
    end: 1,
    subsystem: posix.dirname(path),
    exported: false,
    bytes,
    analysis: reason ? "metadata-only" : "text",
    exclusionReason: reason,
  };
}
export type Extraction = {
  nodes: Component[];
  references: Reference[];
  warnings: string[];
  analyzer: string;
};
export interface Extractor {
  id: string;
  supports(path: string): boolean;
  extract(path: string, source: string): Extraction;
}
// Trusted, versioned adapters only. Repository contents never install or execute extractor code.
const dotnet: Extractor = {
  id: "dotnet-lexical-v1",
  supports: (p) =>
    /\.(cs|csproj|fsproj|vbproj|sln|slnx|props|targets|razor|cshtml|resx|xaml)$/i.test(
      p,
    ),
  extract(path, source) {
    const nodes: Component[] = [],
      references: Reference[] = [];
    if (/\.cs$/i.test(path)) {
      // Mask comments and literals before finding declarations. This is deliberately NOT a semantic compiler.
      const clean = source.replace(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*|@?"(?:""|\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
        (s) => s.replace(/[^\n]/g, " "),
      );
      for (const m of clean.matchAll(
        /\b(class|interface|struct|enum|record)(?:\s+(?:class|struct))?\s+(@?[A-Za-z_]\w*)/g,
      )) {
        const line = clean.slice(0, m.index).split("\n").length;
        nodes.push({
          ...fileNode(path),
          id: `${path}#${m[2]}:${m.index}`,
          name: m[2],
          kind:
            m[1] === "interface"
              ? "interface"
              : m[1] === "class"
                ? "class"
                : "type",
          start: line,
          end: line,
          analysis: "lexical",
          confidence: 0.8,
        });
      }
    }
    for (const m of source.matchAll(
      /<(ProjectReference|Compile|Content|None|EmbeddedResource)\b[^>]*\bInclude\s*=\s*["']([^"']+)["']/g,
    )) {
      if (!/[*$;]/.test(m[2]))
        references.push({
          value: m[2].replaceAll("\\", "/"),
          evidence: `.NET ${m[1]} Include literal`,
          confidence: 0.9,
          kind: m[1] === "ProjectReference" ? "imports" : "references",
        });
    }
    for (const m of source.matchAll(/"([^"\n]+\.(?:csproj|fsproj|vbproj))"/g))
      references.push({
        value: m[1].replaceAll("\\", "/"),
        evidence: ".NET solution project path",
        confidence: 0.9,
        kind: "imports",
      });
    return {
      nodes,
      references,
      analyzer: this.id,
      warnings: [
        ".NET lexical declarations and explicit project/resource paths only. Conditional MSBuild items, implicit Compile globs, overloads, DI, reflection and compiler-resolved references require Roslyn; no build was executed.",
      ],
    };
  },
};
export const extractors: readonly Extractor[] = [dotnet];
export function extractPortable(path: string, input: string): Extraction {
  const source = redact(input);
  const adapter = extractors.find((e) => e.supports(path));
  const result = adapter?.extract(path, source) ?? {
    nodes: [],
    references: [],
    warnings: [],
    analyzer: "literal-path-v1",
  };
  if (path === ".caelogram/relationships.json") {
    try {
      const manifest = JSON.parse(source);
      if (
        manifest.version !== 1 ||
        !Array.isArray(manifest.relationships) ||
        manifest.relationships.length > 1000
      )
        throw new Error();
      for (const r of manifest.relationships) {
        if (
          typeof r.from !== "string" ||
          typeof r.to !== "string" ||
          !safePath(r.from) ||
          !safePath(r.to)
        )
          throw new Error();
        result.references.push({
          from: r.from,
          value: "/" + r.to,
          kind: "references",
          confidence: 0.5,
          evidence:
            "Repository-declared relationship in .caelogram/relationships.json; not independently verified",
        });
      }
    } catch {
      result.warnings.push(
        "Invalid relationship manifest: expected version 1 and up to 1000 safe from/to paths",
      );
    }
  }
  for (const m of source.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    if (!/^(?:[a-z]+:|\/\/|#)/i.test(m[1]))
      result.references.push({
        value: m[1].split(/[?#]/)[0],
        kind: "references",
        confidence: 0.9,
        evidence: "Markdown literal link or image target",
      });
    if (result.references.length >= 1000) break;
  }
  // Match explicit path literals across HTML, CSS, JSON, arbitrary source and proprietary configuration.
  for (const m of source.matchAll(
    /["'`]([^"'`\r\n]{1,399})["'`]|url\(\s*([^\s)'"\r\n]{1,399})\s*\)/g,
  )) {
    const value = (m[1] || m[2]).split(/[?#]/)[0];
    if (
      /^(?:[a-z]+:|\/\/|#)/i.test(value) ||
      /[${}*]/.test(value) ||
      !/\.[A-Za-z0-9]{1,12}$/.test(value)
    )
      continue;
    result.references.push({
      value,
      kind: "references",
      confidence: 0.65,
      evidence:
        "Literal path in source; target existence checked, runtime usage not proven",
    });
    if (result.references.length >= 1000) {
      result.warnings.push(
        "Literal path extraction limited to 1000 candidates",
      );
      break;
    }
  }
  return result;
}
export function referencePaths(path: string, value: string): string[] {
  if (/^(?:[a-z]+:|\/\/)/i.test(value)) return [];
  const root = value.replace(/^~?\//, "");
  const options =
    value.startsWith("/") || value.startsWith("~/")
      ? [
          root,
          "public/" + root,
          "wwwroot/" + root,
          posix.join(posix.dirname(path), "wwwroot", root),
        ]
      : [posix.join(posix.dirname(path), value)];
  return [...new Set(options.map((p) => posix.normalize(p)).filter(safePath))];
}
