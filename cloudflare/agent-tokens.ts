import { z } from "zod";
import { assert, digest } from "../src/security.js";
import type { Principal } from "../src/types.js";
import type { Env } from "./worker.js";

const input = z
  .object({
    label: z.string().trim().min(1).max(80),
    repositories: z.array(z.string().min(3).max(250)).min(1).max(50),
    publish: z.boolean().default(false),
    hours: z.number().int().min(1).max(8).default(1),
  })
  .strict();
export async function issueAgentToken(env: Env, p: Principal, body: unknown) {
  assert(p.scopes.includes("admin"), "Account owner required", 403);
  const a = input.parse(body);
  assert(
    a.repositories.every((r) => p.repositories.includes(r)),
    "Repository access denied",
    403,
  );
  const token =
    "caeg_" +
    crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  const id = crypto.randomUUID(),
    created = Date.now(),
    expires = created + a.hours * 3600000;
  const scopes = ["read", "write", ...(a.publish ? ["publish"] : [])];
  await env.DB.prepare(
    "INSERT INTO agent_tokens(hash,id,tenant,subject,label,scopes,repositories,expires,created) VALUES(?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      digest(token),
      id,
      p.tenant,
      p.subject,
      a.label,
      JSON.stringify(scopes),
      JSON.stringify(a.repositories),
      expires,
      created,
    )
    .run();
  return { id, token, expires };
}
export async function agentIdentity(
  token: string,
  env: Env,
): Promise<Principal> {
  assert(/^caeg_[a-f0-9]{64}$/.test(token), "Invalid agent token", 401);
  const row = await env.DB.prepare(
    "SELECT * FROM agent_tokens WHERE hash=? AND expires>?",
  )
    .bind(digest(token), Date.now())
    .first<{
      id: string;
      tenant: string;
      subject: string;
      scopes: string;
      repositories: string;
    }>();
  assert(row, "Agent token expired or revoked", 401);
  return {
    tenant: row.tenant,
    subject: `agent:${row.id}`,
    scopes: JSON.parse(row.scopes),
    repositories: JSON.parse(row.repositories),
  };
}
export async function listAgentTokens(env: Env, p: Principal) {
  assert(p.scopes.includes("admin"), "Account owner required", 403);
  const rows = await env.DB.prepare(
    "SELECT id,label,scopes,repositories,expires,created FROM agent_tokens WHERE tenant=? AND expires>? ORDER BY created DESC",
  )
    .bind(p.tenant, Date.now())
    .all();
  return rows.results.map((row: any) => ({
    ...row,
    scopes: JSON.parse(row.scopes),
    repositories: JSON.parse(row.repositories),
  }));
}
