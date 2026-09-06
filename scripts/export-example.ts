import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { demoRepository } from "../src/demo.js";
for (const file of demoRepository().graph.files) {
  const target = resolve("examples/orbit-shop", file.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.content);
}
