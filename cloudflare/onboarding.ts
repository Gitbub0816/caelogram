import { createRemoteJWKSet, jwtVerify } from "jose";
import { assert, Fault, digest } from "../src/security.js";
import { CloudStore } from "./store.js";
import type { Env } from "./worker.js";
import type { Principal } from "../src/types.js";

export type GitHubLink = {
  id: string;
  token: string;
  expiresAt: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
};
function tokenRecord(token: any): GitHubLink {
  assert(
    typeof token.access_token === "string",
    "GitHub authorization failed. Connect GitHub again.",
    401,
  );
  return {
    id: "current",
    token: token.access_token,
    expiresAt:
      Date.now() + Math.min(Number(token.expires_in) || 28800, 28800) * 1000,
    ...(typeof token.refresh_token === "string"
      ? {
          refreshToken: token.refresh_token,
          refreshExpiresAt:
            Date.now() +
            Math.min(Number(token.refresh_token_expires_in) || 0, 15897600) *
              1000,
        }
      : {}),
  };
}
export type AvailableRepo = {
  name: string;
  branch: string;
  installationId: number;
};
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function clerkIdentity(
  req: Request,
  env: Env,
): Promise<Principal> {
  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  assert(token, "Sign in to continue", 401);
  assert(
    env.CLERK_ISSUER && env.PUBLIC_ORIGIN,
    "Clerk authentication is not configured",
    503,
  );
  try {
    const issuer = new URL(env.CLERK_ISSUER).origin;
    assert(issuer.startsWith("https://"), "HTTPS issuer required");
    let jwks = keys.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL("/.well-known/jwks.json", issuer));
      keys.set(issuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      algorithms: ["RS256"],
      maxTokenAge: "5m",
    });
    assert(
      typeof payload.sub === "string" &&
        payload.sub.startsWith("user_") &&
        typeof payload.exp === "number" &&
        typeof payload.sid === "string" &&
        payload.azp === env.PUBLIC_ORIGIN,
      "Invalid identity",
      401,
    );
    // Never accept tenant IDs, wildcard grants or roles supplied by a browser.
    return {
      subject: payload.sub,
      tenant: `user:${payload.sub}`,
      scopes: ["admin"],
      repositories: [],
    };
  } catch {
    throw new Fault(401, "Invalid or expired session. Sign in again.");
  }
}
export async function githubJson(token: string, route: string) {
  const r = await fetch(`https://api.github.com${route}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Caelogram",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15000),
  });
  assert(
    r.ok,
    r.status === 401
      ? "GitHub authorization expired. Connect GitHub again."
      : "GitHub could not verify repository access. Retry or review App permissions.",
    r.status === 401 ? 401 : 502,
  );
  return r.json() as Promise<any>;
}
export async function availableRepositories(
  store: CloudStore,
  tenant: string,
  env?: Env,
): Promise<AvailableRepo[]> {
  let link: GitHubLink;
  try {
    link = await store.get<GitHubLink>(tenant, "github-link", "current");
  } catch (e) {
    if (e instanceof Fault && e.status === 404) return [];
    throw e;
  }
  if (link.expiresAt < Date.now() + 60000 && env && link.refreshToken) {
    link = await store.exclusive(tenant, async () => {
      const current = await store.get<GitHubLink>(
        tenant,
        "github-link",
        "current",
      );
      if (current.expiresAt >= Date.now() + 60000) return current;
      assert(
        current.refreshToken && (current.refreshExpiresAt || 0) > Date.now(),
        "GitHub authorization expired. Connect GitHub again.",
        401,
      );
      const r = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
        }),
        signal: AbortSignal.timeout(15000),
      });
      assert(r.ok, "GitHub token refresh failed. Connect GitHub again.", 401);
      const next = tokenRecord(await r.json());
      await store.put(tenant, "github-link", next);
      await store.audit(
        tenant,
        "token-rotation",
        "github.refreshed",
        "current",
      );
      return next;
    });
  }
  assert(
    link.expiresAt > Date.now(),
    "GitHub authorization expired. Connect GitHub again.",
    401,
  );
  const installations = await githubJson(
    link.token,
    "/user/installations?per_page=100",
  );
  assert(
    installations.total_count <= 100,
    "Too many installations for this release",
    413,
  );
  const result: AvailableRepo[] = [];
  for (const installation of installations.installations) {
    if (installation.suspended_at) continue;
    for (let page = 1; page <= 10; page++) {
      const data = await githubJson(
        link.token,
        `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`,
      );
      assert(
        data.total_count <= 1000,
        "Installation exceeds the 1,000 repository listing limit",
        413,
      );
      for (const repo of data.repositories)
        if (repo.permissions?.push && !repo.archived && !repo.disabled)
          result.push({
            name: repo.full_name,
            branch: repo.default_branch,
            installationId: installation.id,
          });
      if (page * 100 >= data.total_count) break;
    }
  }
  return result;
}
export async function startGitHub(p: Principal, env: Env) {
  assert(
    env.GITHUB_CLIENT_ID &&
      env.GITHUB_CLIENT_SECRET &&
      env.GITHUB_APP_SLUG &&
      env.PUBLIC_ORIGIN,
    "GitHub App OAuth is not configured",
    503,
  );
  const state = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO oauth_states(state,tenant,expires) VALUES(?,?,?)",
  )
    .bind(digest(state), p.tenant, Date.now() + 600000)
    .run();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("state", state);
  url.searchParams.set(
    "redirect_uri",
    `${env.PUBLIC_ORIGIN}/auth/github/callback`,
  );
  return {
    url: url.href,
    cookie: `caelogram_oauth=${state}; HttpOnly; Secure; SameSite=Lax; Path=/auth/github; Max-Age=600`,
  };
}
export async function finishGitHub(req: Request, env: Env, store: CloudStore) {
  const url = new URL(req.url),
    state = url.searchParams.get("state"),
    code = url.searchParams.get("code");
  const cookie = req.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("caelogram_oauth="))
    ?.slice(16);
  assert(
    state && code && cookie === state,
    "GitHub sign-in state expired or invalid. Start again.",
    400,
  );
  // Atomic consumption rejects callback replay and races across Workers.
  const row = await env.DB.prepare(
    "DELETE FROM oauth_states WHERE state=? AND expires>? RETURNING tenant",
  )
    .bind(digest(state), Date.now())
    .first<{ tenant: string }>();
  assert(
    row,
    "GitHub authorization already used or expired. Start again.",
    400,
  );
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.PUBLIC_ORIGIN}/auth/github/callback`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const token = (await r.json()) as any;
  assert(
    r.ok && typeof token.access_token === "string",
    "GitHub authorization failed. Start again.",
    400,
  );
  await githubJson(token.access_token, "/user");
  await store.exclusive(row.tenant, async () => {
    await store.put(row.tenant, "github-link", tokenRecord(token));
    await store.audit(
      row.tenant,
      row.tenant.slice(5),
      "github.authorized",
      "current",
    );
  });
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${env.PUBLIC_ORIGIN}/?connect=github`,
      "Set-Cookie":
        "caelogram_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/auth/github; Max-Age=0",
      "Cache-Control": "no-store",
    },
  });
}
