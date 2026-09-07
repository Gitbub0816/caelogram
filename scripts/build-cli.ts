// Build the publishable CLI package into dist/package/.
//
// The CLI is bundled into one self-contained executable, and the package
// manifest is generated rather than reused: this repository's root package
// declares the server/console runtime dependencies (express, react, the MCP
// SDK) that a CLI user must never download. The published package therefore
// contains three files and has no dependencies at all — `npx caelogram`
// fetches a single script.
import { build } from "esbuild";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const stage = resolve(root, "dist/package");
const bundle = resolve(root, "dist/cli.js");

mkdirSync(stage, { recursive: true });

const result = await build({
  entryPoints: [resolve(root, "src/cli.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
  // `typescript` is bundled deliberately: the local mapper needs its parser,
  // and the minified subset we use is far smaller than the published package.
  banner: {
    js: [
      // esbuild keeps the `#!/usr/bin/env node` line from src/cli.ts above this.
      // Shims for CommonJS dependencies bundled into an ESM output.
      "import { createRequire as __caelogramRequire } from 'node:module';",
      "import { fileURLToPath as __caelogramUrl } from 'node:url';",
      "import { dirname as __caelogramDir } from 'node:path';",
      "const require = __caelogramRequire(import.meta.url);",
      "const __filename = __caelogramUrl(import.meta.url);",
      "const __dirname = __caelogramDir(__filename);",
    ].join("\n"),
  },
});

chmodSync(bundle, 0o755);
copyFileSync(bundle, resolve(stage, "cli.js"));
chmodSync(resolve(stage, "cli.js"), 0o755);
copyFileSync(resolve(root, "README.md"), resolve(stage, "README.md"));

const manifest = {
  name: pkg.name,
  version: pkg.version,
  type: "module",
  description: pkg.description,
  license: pkg.license,
  homepage: pkg.homepage,
  repository: pkg.repository,
  bugs: pkg.bugs,
  keywords: pkg.keywords,
  engines: pkg.engines,
  bin: { caelogram: "cli.js" },
  files: ["cli.js", "README.md"],
  publishConfig: { access: "public" },
};
writeFileSync(
  resolve(stage, "package.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { mode: 0o644 },
);

const bytes = statSync(bundle).size;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(
  `dist/package/cli.js  ${(bytes / 1024 / 1024).toFixed(2)} MB  from ${inputs} modules, 0 runtime dependencies`,
);
