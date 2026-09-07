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
export type RepoOwner = {
  login: string;
  id: number;
  type: "org" | "user";
};
export type AvailableRepo = {
  name: string;
  branch: string;
  installationId: number;
  owner: RepoOwner;
  /** Workspace this repository belongs to. See ownerTenant. */
  tenant: string;
};

/**
 * Workspace key: `gh:org:<account id>` or `gh:user:<account id>`.
 *
 * A repository belongs to the GitHub account that owns it, never to the person
 * who happened to index it first, so every collaborator GitHub grants access to
 * sees one shared index instead of a private copy per signed-in user.
 *
 * The key holds GitHub's immutable numeric account id rather than the login, so
 * renaming an organization does not split its workspace, and it keeps the
 * account type as a separate segment so an organization and a user account can
 * never resolve to the same key even if GitHub's login namespaces ever diverge.
 * Logins are display data only; they are never part of the key.
 */
export function ownerTenant(owner: RepoOwner) {
  return `gh:${owner.type}:${owner.id}`;
}

/**
 * Per-person key. Holds only individual credentials and grants — the GitHub
 * OAuth link, OAuth states, agent tokens, cached access — never repository
 * indexes, which live under the workspace their GitHub owner defines. Legacy
 * indexes created before workspaces exist under this key until adopted.
 */
export function identityTenant(subject: string) {
  return `user:${subject}`;
}

/** GitHub is asked again at most this often; a revoked grant dies within it. */
export const ACCESS_TTL_MS = 180_000;
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Clerk's Frontend API URL is also the JWT issuer. */
export function clerkIssuer(env: Env) {
  if (env.CLERK_ISSUER) return new URL(env.CLERK_ISSUER).origin;
  const encoded = env.CLERK_PUBLISHABLE_KEY?.split("_")[2];
  assert(encoded, "Clerk authentication is not configured", 503);
  try {
    const domain = atob(encoded.replace(/-/g, "+").replace(/_/g, "/")).replace(
      /\$$/,
      "",
    );
    const issuer = new URL(`https://${domain}`).origin;
    assert(issuer.startsWith("https://"), "HTTPS issuer required");
    return issuer;
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault(503, "Clerk authentication is not configured");
  }
}

export async function clerkIdentity(
  req: Request,
  env: Env,
): Promise<Principal> {
  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  assert(token, "Sign in to continue", 401);
  return verifyClerkSession(token, env, true);
}

/**
 * The signed-in browser behind a server-rendered page (the OAuth consent and
 * device verification screens), taken from Clerk's `__session` cookie rather
 * than an Authorization header, because those pages are plain navigations with
 * no application JavaScript of their own. Returns null when no valid session is
 * present so the caller can render a "sign in first" page instead of failing.
 *
 * Cookie session tokens do not always carry `azp`, so it is enforced only when
 * present. Issuer, signature, expiry and session id are checked exactly as for
 * header tokens, and the resulting principal is still nothing more than an
 * identity key: repositories come from GitHub, never from a token.
 */
export async function clerkCookieIdentity(
  req: Request,
  env: Env,
): Promise<Principal | null> {
  const raw = req.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("__session="))
    ?.slice("__session=".length);
  if (!raw) return null;
  try {
    return await verifyClerkSession(decodeURIComponent(raw), env, false);
  } catch {
    return null;
  }
}

async function verifyClerkSession(
  token: string,
  env: Env,
  requireAzp: boolean,
): Promise<Principal> {
  assert(env.PUBLIC_ORIGIN, "Clerk authentication is not configured", 503);
  try {
    const issuer = clerkIssuer(env);
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
        (requireAzp
          ? payload.azp === env.PUBLIC_ORIGIN
          : payload.azp === undefined || payload.azp === env.PUBLIC_ORIGIN),
      "Invalid identity",
      401,
    );
    // Never accept tenant IDs, wildcard grants or roles supplied by a browser.
    // The identity key is all a signed-in session proves; the workspaces it can
    // read come from GitHub through resolveAccess, never from this token.
    return {
      subject: payload.sub,
      tenant: identityTenant(payload.sub),
      tenants: [identityTenant(payload.sub)],
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
      for (const repo of data.repositories) {
        if (!repo.permissions?.push || repo.archived || repo.disabled) continue;
        const owner = repoOwner(repo);
        // Without an owner account id and type GitHub has not told us which
        // workspace the repository belongs to. Omit it rather than guess.
        if (!owner) continue;
        result.push({
          name: repo.full_name,
          branch: repo.default_branch,
          installationId: installation.id,
          owner,
          tenant: ownerTenant(owner),
        });
      }
      if (page * 100 >= data.total_count) break;
    }
  }
  return result;
}
function repoOwner(repo: any): RepoOwner | null {
  const type =
    repo?.owner?.type === "Organization"
      ? "org"
      : repo?.owner?.type === "User"
        ? "user"
        : null;
  if (!type) return null;
  const id = Number(repo.owner.id),
    login = repo.owner.login;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof login !== "string")
    return null;
  return { login, id, type };
}
export type LegacyIndex = { tenant: string; name: string };
export type Access = {
  /** Every workspace GitHub currently grants this principal, plus its own. */
  tenants: string[];
  repositories: AvailableRepo[];
  /** Pre-workspace per-user tenants still holding an index this principal may read. */
  legacy: LegacyIndex[];
  /** Workspace → installations that workspace may index through. */
  installations: Record<string, number[]>;
  /** Repository full name → workspace that owns it. */
  workspaces: Record<string, string>;
  cached: boolean;
};
/**
 * The only answer to "what may this person see", and it comes from GitHub.
 *
 * The resolved list is cached in D1 for ACCESS_TTL_MS keyed by the individual,
 * so a page of requests costs one GitHub round trip, and a grant revoked on
 * GitHub stops working once the entry expires — the cache is never extended
 * when GitHub is unreachable, so an outage fails closed rather than open.
 */
export async function resolveAccess(
  store: CloudStore,
  env: Env,
  p: Principal,
  options: { force?: boolean } = {},
): Promise<Access> {
  const key = identityTenant(p.subject);
  const row = options.force
    ? null
    : await env.DB.prepare(
        "SELECT repositories,legacy FROM access_cache WHERE principal=? AND expires>?",
      )
        .bind(key, Date.now())
        .first<{ repositories: string; legacy: string }>();
  let repositories: AvailableRepo[], legacy: LegacyIndex[];
  let cached = true;
  if (row) {
    repositories = JSON.parse(row.repositories);
    legacy = JSON.parse(row.legacy);
  } else {
    cached = false;
    repositories = await availableRepositories(store, key, env);
    // Completing the 0006 backfill needs the owner identity only GitHub knows.
    legacy = await linkLegacyIndexes(env, repositories);
    await env.DB.prepare(
      "INSERT INTO access_cache(principal,repositories,legacy,refreshed,expires) VALUES(?,?,?,?,?) ON CONFLICT(principal) DO UPDATE SET repositories=excluded.repositories,legacy=excluded.legacy,refreshed=excluded.refreshed,expires=excluded.expires",
    )
      .bind(
        key,
        JSON.stringify(repositories),
        JSON.stringify(legacy),
        Date.now(),
        Date.now() + ACCESS_TTL_MS,
      )
      .run();
  }
  const installations: Record<string, number[]> = {},
    workspaces: Record<string, string> = {};
  for (const r of repositories) {
    workspaces[r.name] = r.tenant;
    const ids = (installations[r.tenant] ??= []);
    if (!ids.includes(r.installationId)) ids.push(r.installationId);
  }
  // A legacy tenant is readable, and re-indexable only through the installation
  // that carries the repository it actually holds; every call is still gated per
  // repository name by Principal.repositories.
  for (const item of legacy) {
    const source = repositories.find((r) => r.name === item.name);
    if (!source) continue;
    const ids = (installations[item.tenant] ??= []);
    if (!ids.includes(source.installationId)) ids.push(source.installationId);
  }
  return {
    tenants: [
      ...new Set([
        key,
        ...repositories.map((r) => r.tenant),
        ...legacy.map((l) => l.tenant),
      ]),
    ],
    repositories,
    legacy,
    installations,
    workspaces,
    cached,
  };
}
/** Workspaces an agent token may reach, derived from its verified repositories. */
export async function agentWorkspaces(env: Env, p: Principal) {
  const names = p.repositories.filter((n) => n !== "*");
  if (!names.length) return [p.tenant];
  const rows = await env.DB.prepare(
    `SELECT DISTINCT tenant FROM index_repos WHERE name IN (${names.map(() => "?").join(",")})`,
  )
    .bind(...names)
    .all<{ tenant: string }>();
  return [...new Set([p.tenant, ...rows.results.map((r) => r.tenant)])];
}
/**
 * Second half of migration 0006, run the first time a person GitHub still
 * grants push access to a pre-workspace repository signs in.
 *
 * The migration parked every `user:<clerk sub>` index in `tenant_backfill`
 * because only GitHub can say which account owns a repository. Here that owner
 * is finally known, so the legacy tenant is recorded against its workspace and
 * admitted to the scope of everyone the workspace covers: the existing index
 * survives untouched and becomes shared, exactly as if it had been created
 * under the workspace key.
 *
 * Its rows are deliberately not rewritten to the workspace key. Every indexed
 * file's source is an R2 object whose AES-GCM additional data binds it to the
 * tenant it was written under, so a SQL tenant rewrite would leave the index
 * pointing at payloads that no longer decrypt. Re-encrypting a whole repository
 * inside a request is not something this path can honestly do, so the mapping
 * is recorded instead and the data is left where it is and reachable.
 *
 * Returns the legacy indexes this principal may read through its GitHub grants.
 */
export async function linkLegacyIndexes(
  env: Env,
  repositories: AvailableRepo[],
): Promise<LegacyIndex[]> {
  if (!repositories.length) return [];
  const names = [...new Set(repositories.map((r) => r.name))];
  const byName = new Map(repositories.map((r) => [r.name, r.tenant]));
  const rows = await env.DB.prepare(
    `SELECT old_tenant,repo_id,name FROM tenant_backfill WHERE name IN (${names.map(() => "?").join(",")})`,
  )
    .bind(...names)
    .all<{ old_tenant: string; repo_id: string; name: string }>();
  const writes = rows.results.map((r) =>
    env.DB.prepare(
      "UPDATE tenant_backfill SET new_tenant=?,linked=? WHERE old_tenant=? AND repo_id=? AND (new_tenant IS NULL OR new_tenant=?)",
    ).bind(
      byName.get(r.name)!,
      Date.now(),
      r.old_tenant,
      r.repo_id,
      byName.get(r.name)!,
    ),
  );
  if (writes.length) await env.DB.batch(writes);
  return rows.results.map((r) => ({ tenant: r.old_tenant, name: r.name }));
}
export async function startGitHub(p: Principal, env: Env) {
  const missing = [
    !env.GITHUB_CLIENT_ID && "GITHUB_CLIENT_ID",
    !env.GITHUB_CLIENT_SECRET && "GITHUB_CLIENT_SECRET",
    !env.GITHUB_APP_SLUG && "GITHUB_APP_SLUG",
    !env.PUBLIC_ORIGIN && "PUBLIC_ORIGIN",
  ].filter(Boolean);
  assert(
    !missing.length,
    `GitHub connection is incomplete: ${missing.join(", ")}`,
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
  // A fresh authorization must be visible immediately, not after the TTL.
  await env.DB.prepare("DELETE FROM access_cache WHERE principal=?")
    .bind(row.tenant)
    .run();
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
