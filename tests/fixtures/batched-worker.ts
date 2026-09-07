// Test-only entry point: not referenced by the production Wrangler configuration.
import { BatchedService, advanceIndex } from "../../cloudflare/batched.js";
import { GitHub } from "../../src/github.js";
import type { Env } from "../../cloudflare/worker.js";
const p = {
  tenant: "memory-test",
  subject: "test",
  scopes: ["admin"],
  repositories: ["test/repo", "test/oversized"],
};
GitHub.prototype.api = async (_name, _installation, route) => {
  if (route.startsWith("/git/ref/")) return { object: { sha: "a".repeat(40) } };
  if (route.startsWith("/git/commits/")) return { tree: { sha: "tree" } };
  if (route.startsWith("/git/trees/"))
    return {
      tree: Array.from(
        { length: _name === "test/oversized" ? 9000 : 100 },
        (_, i) => ({
          path: `docs-${i}.md`,
          type: "blob",
          mode: "100644",
          sha: String(i),
          size: _name === "test/oversized" ? 250000 : 240000,
        }),
      ),
    };
  if (route.startsWith("/git/blobs/"))
    return {
      encoding: "base64",
      content: Buffer.from("x".repeat(240000)).toString("base64"),
    };
  throw new Error("Unexpected fixture route");
};
export default {
  async fetch(req: Request, env: Env) {
    const s = new BatchedService(env),
      url = new URL(req.url);
    if (url.pathname === "/start")
      return Response.json(await s.connect(p, "test/repo", "main", 1));
    if (url.pathname === "/oversized")
      return Response.json(await s.connect(p, "test/oversized", "main", 1));
    const id = url.searchParams.get("id")!;
    if (url.pathname === "/step") {
      try {
        await advanceIndex(env, p.tenant, (await s.record(p, id)).latest_job!);
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 413 });
      }
    }
    if (url.pathname === "/map") return Response.json(await s.mapPage(p, id));
    return Response.json(await s.status(p, id));
  },
};
