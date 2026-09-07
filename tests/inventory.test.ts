import test from "node:test";
import assert from "node:assert/strict";
import {
  exclusion,
  extractPortable,
  referencePaths,
} from "../src/inventory.js";
import { index, sourceFile } from "../src/graph.js";
test("unknown runtime text and .NET source are eligible; assets and secrets retain explicit metadata reasons", () => {
  for (const path of [
    "Engine.cs",
    "App.csproj",
    "App.sln",
    "Index.razor",
    "model.proprietary",
    "Dockerfile",
  ])
    assert.equal(exclusion(path, 100), null);
  assert.match(exclusion("logo.png", 100)!, /metadata/);
  assert.match(exclusion(".env", 100)!, /never downloaded/);
  assert.match(exclusion("obj/build.cs", 100)!, /generated/);
  assert.match(exclusion("large.cs", 999999)!, /limit/);
});
test(".NET declarations omit comment and string false positives; explicit project references preserve evidence", () => {
  const g = index(
    [
      sourceFile(
        "App.cs",
        '// class Fake {}\nnamespace App; public class Real { string x="class Nope {}"; }',
      ),
    ],
    "revision",
  );
  assert(g.nodes.some((n) => n.name === "Real"));
  assert(!g.nodes.some((n) => ["Fake", "Nope"].includes(n.name)));
  assert(g.warnings.some((w) => w.includes("Roslyn")));
  const e = extractPortable(
    "App/App.csproj",
    '<Project><ProjectReference Include="../Core/Core.csproj" /><Content Include="wwwroot/logo.png" /></Project>',
  );
  assert(
    e.references.some(
      (r) => r.kind === "imports" && r.value === "../Core/Core.csproj",
    ),
  );
  assert.deepEqual(referencePaths("App/App.csproj", "../Core/Core.csproj"), [
    "Core/Core.csproj",
  ]);
});
test("literal assets and proprietary references resolve only inside repository with qualified confidence", () => {
  const e = extractPortable(
    "app.custom",
    'texture="./logo.png"; url(./back.webp); remote="https://evil.test/a.png"',
  );
  assert(
    e.references.some((r) => r.value === "./logo.png" && r.confidence < 1),
  );
  assert(e.references.some((r) => r.value === "./back.webp"));
  assert(!e.references.some((r) => r.value.includes("evil.test")));
  assert.deepEqual(referencePaths("app.custom", "../../escape.png"), []);
});
test("proprietary frameworks can declare evidence without executing a plugin", () => {
  const e = extractPortable(
    ".caelogram/relationships.json",
    JSON.stringify({
      version: 1,
      relationships: [{ from: "app.custom", to: "logo.png" }],
    }),
  );
  assert(
    e.references.some(
      (r) =>
        r.from === "app.custom" &&
        r.value === "/logo.png" &&
        r.confidence === 0.5,
    ),
  );
});

test("Markdown images retain an explicit asset relationship", () => {
  const result = extractPortable("README.md", "![Logo](images/logo.png)");
  assert(result.references.some((r) => r.value === "images/logo.png"));
});
