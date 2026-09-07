/**
 * Caelogram's OAuth 2.1 authorization server.
 *
 * Caelogram is both the resource server (`/mcp`, `/api/tools/*`) and the
 * authorization server, so an MCP client can discover it, register itself, send
 * a person through a consent screen, and come back with a token — with nothing
 * pasted by hand.
 *
 * Endpoints, and the document each one implements:
 *
 * | Path                                        | Specification                     |
 * | ------------------------------------------- | --------------------------------- |
 * | `/.well-known/oauth-authorization-server`   | RFC 8414                          |
 * | `/.well-known/oauth-protected-resource`     | RFC 9728                          |
 * | `/register`                                 | RFC 7591                          |
 * | `/authorize` (GET consent, POST decision)   | RFC 6749 / OAuth 2.1, PKCE RFC 7636 |
 * | `/token`                                    | RFC 6749 §4.1.3, §6; RFC 8628 §3.4 |
 * | `/device_authorization`                     | RFC 8628 §3.1                     |
 * | `/device` (verification page)               | RFC 8628 §3.3                     |
 * | `/revoke`                                   | RFC 7009                          |
 *
 * Two invariants hold everywhere below.
 *
 * 1. A token is an identity plus a consented scope. It never carries a tenant,
 *    a repository list or a role. `resolveAccess()` in onboarding.ts asks GitHub
 *    what the person may see on every request, so a grant revoked on GitHub
 *    stops working here without anything being revoked in Caelogram.
 * 2. Nothing secret is stored in the clear. Authorization codes, device codes,
 *    access tokens, refresh tokens, client secrets and the consent CSRF value
 *    are kept as SHA-256 digests and compared in constant time.
 */
import { z } from "zod";
import { createHash, createHmac } from "node:crypto";
import { assert, digest, constantEqual } from "../src/security.js";
import { clerkCookieIdentity, identityTenant } from "./onboarding.js";
import type { Principal } from "../src/types.js";
import type { Env } from "./worker.js";

export const SCOPES = ["read", "write", "publish", "admin"] as const;
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Access tokens are deliberately short-lived; the refresh token is the durable credential. */
export const ACCESS_TTL_MS = 900_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
const CODE_TTL_MS = 120_000;
const PENDING_TTL_MS = 600_000;
const DEVICE_TTL_MS = 900_000;
const DEVICE_INTERVAL_S = 5;
const GRANT_TYPES = ["authorization_code", "refresh_token", DEVICE_GRANT];

const SCOPE_TEXT: Record<string, string> = {
  read: "Read repository maps, task context and file sections",
  write: "Create tasks and submit changesets",
  publish: "Open draft pull requests on GitHub",
  admin: "Connect and remove repositories, and read the audit trail",
};

/* ------------------------------------------------------------------ *
 * Credential minting
 * ------------------------------------------------------------------ */

type Prefix = "caot" | "cart" | "caac" | "cadc";
/** Every issued string looks like `<prefix>_<64 hex>.<32 hex HMAC tag>`. */
const SHAPE = /^(caot|cart|caac|cadc)_([a-f0-9]{64})\.([a-f0-9]{32})$/;

function signingKey(env: Env) {
  const key = env.OAUTH_SIGNING_KEY || env.DATA_KEY;
  assert(key, "OAuth signing key is not configured", 503);
  return key;
}
function tag(env: Env, prefix: Prefix, body: string) {
  return createHmac("sha256", signingKey(env))
    .update(`${prefix}.${body}`)
    .digest("hex")
    .slice(0, 32);
}
function mint(env: Env, prefix: Prefix) {
  const body =
    crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  return `${prefix}_${body}.${tag(env, prefix, body)}`;
}
/**
 * A token Caelogram did not sign never reaches the database. The HMAC makes the
 * issued string self-authenticating, which keeps forged or truncated bearers
 * from costing a D1 lookup; the digest in the table is still the authority.
 */
export function signed(env: Env, prefix: Prefix, token: string) {
  const m = SHAPE.exec(token);
  return !!m && m[1] === prefix && constantEqual(m[3], tag(env, prefix, m[2]));
}
export const looksLikeOAuthToken = (token: string) =>
  /^caot_[a-f0-9]{64}\.[a-f0-9]{32}$/.test(token);

/** Human-typed device code: two groups of four from an unambiguous alphabet. */
function userCode() {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789";
  const pick = () =>
    Array.from(
      crypto.getRandomValues(new Uint8Array(4)),
      (b) => alphabet[b % alphabet.length],
    ).join("");
  return `${pick()}-${pick()}`;
}
const normalizeUserCode = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, "");

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "600",
};
function jsonResponse(body: unknown, status = 200, cors = true) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...(cors ? CORS : {}) },
  });
}
/** RFC 6749 §5.2 error object. Errors are data here, not exceptions. */
function oauthError(
  error: string,
  description: string,
  status = 400,
  extra: Record<string, unknown> = {},
) {
  return jsonResponse(
    { error, error_description: description, ...extra },
    status,
  );
}
async function form(req: Request) {
  const body = await req.text();
  assert(body.length <= 100_000, "Request too large", 413);
  return new URLSearchParams(body);
}
function origin(env: Env, req: Request) {
  return env.PUBLIC_ORIGIN || new URL(req.url).origin;
}
function html(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Consent must never be clickjacked. The worker sets these globally too;
      // they are repeated here so this page is safe wherever it is served from.
      "X-Frame-Options": "DENY",
      ...headers,
    },
  });
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );

/**
 * Fixed-window counter in D1. Cheap, shared across isolates, and good enough to
 * keep a stolen device code or a registration script from being hammered.
 */
async function throttle(
  env: Env,
  name: string,
  key: string,
  limit: number,
  windowMs: number,
) {
  const window = Math.floor(Date.now() / windowMs);
  const row = await env.DB.prepare(
    "INSERT INTO oauth_rate(key,window,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=oauth_rate.count+1 RETURNING count",
  )
    .bind(`${name}:${key}:${window}`, window * windowMs)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}
const clientAddress = (req: Request) =>
  req.headers.get("CF-Connecting-IP") || "local";

/* ------------------------------------------------------------------ *
 * Clients
 * ------------------------------------------------------------------ */

export type Client = {
  client_id: string;
  name: string;
  secret_hash: string | null;
  redirect_uris: string;
  grant_types: string;
  scope: string;
  auth_method: string;
};
async function loadClient(env: Env, id: string) {
  if (!id || id.length > 200) return null;
  return await env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id=?")
    .bind(id)
    .first<Client>();
}
const redirectUris = (c: Client) => JSON.parse(c.redirect_uris) as string[];
const clientGrants = (c: Client) => JSON.parse(c.grant_types) as string[];

/**
 * Redirect URI policy, deliberately narrow:
 *
 * - absolute, no fragment, no wildcard, at most 400 characters;
 * - `https:` anywhere;
 * - `http:` only on a loopback host, for native clients that spawn a temporary
 *   local listener (RFC 8252 §7.3);
 * - a private-use scheme (`cursor:`, `vscode:`, …) for installed applications,
 *   which must contain a dot per RFC 8252 §7.1 and may not be `javascript:`,
 *   `data:`, `file:` or `vbscript:`.
 *
 * Matching at `/authorize` is a literal string comparison against a registered
 * value. Prefix or "starts-with" matching is what turns an open redirect in a
 * client's own site into a stolen authorization code, so it is not offered.
 */
export function validRedirectUri(value: string) {
  if (typeof value !== "string" || !value || value.length > 400) return false;
  if (value.includes("*") || value.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (["javascript:", "data:", "file:", "vbscript:"].includes(url.protocol))
    return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:")
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  // Private-use URI scheme, e.g. com.example.app:/callback
  return (
    /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && url.protocol.includes(".")
  );
}

const registration = z
  .object({
    redirect_uris: z.array(z.string()).max(10).optional(),
    client_name: z.string().trim().min(1).max(120).optional(),
    grant_types: z.array(z.string()).max(10).optional(),
    response_types: z.array(z.string()).max(10).optional(),
    token_endpoint_auth_method: z
      .enum(["none", "client_secret_basic", "client_secret_post"])
      .optional(),
    scope: z.string().max(200).optional(),
    software_id: z.string().max(120).optional(),
    client_uri: z.string().max(400).optional(),
  })
  .passthrough();

/**
 * RFC 7591 open registration. Anyone may register, because an MCP client must
 * be able to configure itself without a human provisioning anything; a
 * registration on its own grants nothing at all — every token still requires a
 * signed-in person to approve a consent screen, and the resulting access is
 * whatever GitHub grants that person.
 *
 * Public clients (`token_endpoint_auth_method: "none"`, the default and the
 * only sensible choice for a CLI, an editor or a desktop app) get no secret and
 * are held together by PKCE and exact redirect-URI matching. A client that asks
 * for `client_secret_basic` or `client_secret_post` gets one secret, returned
 * once and stored only as a digest.
 */
export async function register(req: Request, env: Env) {
  if (!(await throttle(env, "register", clientAddress(req), 10, 3_600_000)))
    return oauthError(
      "invalid_request",
      "Too many client registrations from this address; retry within the hour",
      429,
    );
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }
  const parsed = registration.safeParse(body);
  if (!parsed.success)
    return oauthError("invalid_client_metadata", "Unusable client metadata");
  const a = parsed.data;
  const method = a.token_endpoint_auth_method ?? "none";
  const grants = a.grant_types?.length
    ? a.grant_types
    : ["authorization_code", "refresh_token"];
  const unsupported = grants.filter((g) => !GRANT_TYPES.includes(g));
  if (unsupported.length)
    return oauthError(
      "invalid_client_metadata",
      `Unsupported grant types: ${unsupported.join(", ")}`,
    );
  if (a.response_types?.some((r) => r !== "code"))
    return oauthError(
      "invalid_client_metadata",
      "Only the authorization code response type is supported",
    );
  const uris = a.redirect_uris ?? [];
  if (grants.includes("authorization_code") && !uris.length)
    return oauthError(
      "invalid_redirect_uri",
      "The authorization code grant requires at least one redirect URI",
    );
  const bad = uris.filter((u) => !validRedirectUri(u));
  if (bad.length)
    return oauthError(
      "invalid_redirect_uri",
      `Unusable redirect URI: ${bad[0].slice(0, 120)}. Use https, http on loopback, or a private-use scheme; no wildcards or fragments.`,
    );
  const requested = (a.scope ?? "read write").split(/\s+/).filter(Boolean);
  const unknown = requested.filter(
    (s) => !SCOPES.includes(s as (typeof SCOPES)[number]),
  );
  if (unknown.length)
    return oauthError(
      "invalid_client_metadata",
      `Unknown scope: ${unknown.join(", ")}`,
    );
  const clientId = crypto.randomUUID();
  const secret =
    method === "none"
      ? null
      : crypto.randomUUID().replaceAll("-", "") +
        crypto.randomUUID().replaceAll("-", "");
  const created = Date.now();
  await env.DB.prepare(
    "INSERT INTO oauth_clients(client_id,name,secret_hash,redirect_uris,grant_types,scope,auth_method,software,uri,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      clientId,
      a.client_name ?? "Unnamed MCP client",
      secret ? digest(secret) : null,
      JSON.stringify(uris),
      JSON.stringify(grants),
      requested.join(" "),
      method,
      a.software_id ?? null,
      a.client_uri ?? null,
      created,
    )
    .run();
  return jsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(created / 1000),
      client_name: a.client_name ?? "Unnamed MCP client",
      redirect_uris: uris,
      grant_types: grants,
      response_types: ["code"],
      scope: requested.join(" "),
      token_endpoint_auth_method: method,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    },
    201,
  );
}

/* ------------------------------------------------------------------ *
 * Metadata documents
 * ------------------------------------------------------------------ */

export function authorizationServerMetadata(env: Env, req: Request) {
  const base = origin(env, req);
  return jsonResponse({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    device_authorization_endpoint: `${base}/device_authorization`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: GRANT_TYPES,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    revocation_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    service_documentation: `${base}/docs/authentication`,
  });
}
export function protectedResourceMetadata(env: Env, req: Request) {
  const base = origin(env, req);
  return jsonResponse({
    resource: base,
    // Caelogram issues its own tokens now. ISSUER stays honoured for a
    // deployment that fronts an external authorization server.
    authorization_servers: [env.ISSUER || base],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Caelogram",
    resource_documentation: `${base}/docs/authentication`,
  });
}

/* ------------------------------------------------------------------ *
 * Consent and page rendering
 * ------------------------------------------------------------------ */

function page(title: string, main: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Caelogram</title><style>
:root{color-scheme:dark}
body{margin:0;background:#191a1a;color:#ece9e2;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
main{width:100%;max-width:460px;background:#1f2020;border:1px solid #2e2f2e;border-radius:16px;padding:32px}
img.mark{height:28px;width:auto;margin-bottom:24px;opacity:.95}
h1{font-size:22px;line-height:1.25;margin:0 0 12px;font-weight:600;letter-spacing:-.01em}
p{margin:0 0 16px;color:#b9b4a9}
strong{color:#ece9e2;font-weight:600}
ul.scopes{list-style:none;margin:0 0 24px;padding:0;border-top:1px solid #2e2f2e}
ul.scopes li{padding:12px 0;border-bottom:1px solid #2e2f2e}
ul.scopes b{display:block;color:#d8bc86;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
ul.scopes span{color:#b9b4a9;font-size:14px}
.row{display:flex;gap:12px;margin-top:8px}
button,a.button{flex:1;display:block;text-align:center;text-decoration:none;font:inherit;font-weight:600;padding:12px 16px;border-radius:10px;border:1px solid #3a3b39;background:transparent;color:#ece9e2;cursor:pointer}
button.primary{background:#d8bc86;border-color:#d8bc86;color:#191a1a}
input[type=text]{width:100%;box-sizing:border-box;font:inherit;letter-spacing:.22em;text-transform:uppercase;padding:12px 14px;margin-bottom:16px;border-radius:10px;border:1px solid #3a3b39;background:#161717;color:#ece9e2}
code{background:#161717;border:1px solid #2e2f2e;border-radius:6px;padding:1px 6px;font-size:14px;color:#d8bc86}
.note{font-size:13px;color:#8d8880;margin:20px 0 0}
</style><main><img class="mark" src="/logo.png" alt="Caelogram">${main}</main></html>`;
}
function notice(title: string, message: string, status = 400) {
  return html(
    page(title, `<h1>${escape(title)}</h1><p>${message}</p>`),
    status,
  );
}
/**
 * These pages are ordinary navigations, so the person is identified by their
 * Clerk browser session cookie. The console is a separate SPA and cannot be
 * asked to render them; when no session is present the page says so and links
 * to sign-in rather than starting a second login system.
 */
function signInFirst(env: Env, req: Request, back: string) {
  return html(
    page(
      "Sign in to continue",
      `<h1>Sign in to approve this</h1><p>Caelogram needs to know who you are before it can grant access to your workspace. Sign in in this browser, then continue.</p>
<div class="row"><a class="button primary" href="${escape(`${origin(env, req)}/sign-in`)}">Sign in</a><a class="button" href="${escape(back)}">Continue</a></div>
<p class="note">Signing in happens in the Caelogram console. Return here afterwards with Continue.</p>`,
    ),
    200,
  );
}
function scopeList(scopes: string[]) {
  return `<ul class="scopes">${scopes
    .map(
      (s) =>
        `<li><b>${escape(s)}</b><span>${escape(SCOPE_TEXT[s] ?? "")}</span></li>`,
    )
    .join("")}</ul>`;
}
const csrfCookie = (value: string, path: string) =>
  `caelogram_consent=${value}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=600`;
const clearCsrfCookie = (path: string) =>
  `caelogram_consent=; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=0`;
function cookieValue(req: Request, name: string) {
  return req.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/* ------------------------------------------------------------------ *
 * Authorization endpoint
 * ------------------------------------------------------------------ */

function redirectWithError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Cache-Control": "no-store" },
  });
}

export async function authorize(req: Request, env: Env) {
  const url = new URL(req.url);
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const state = q.get("state");
  const client = await loadClient(env, clientId);
  // An unknown client or an unregistered redirect URI must never be redirected
  // to: that is how a code is delivered to an attacker's endpoint.
  if (!client)
    return notice(
      "Unknown application",
      "This application is not registered with Caelogram. Register it first, or check the client identifier it is sending.",
    );
  if (!redirectUri || !redirectUris(client).some((u) => u === redirectUri))
    return notice(
      "Redirect address rejected",
      "The redirect address this application sent is not one it registered. Caelogram matches redirect addresses exactly.",
    );
  if (!clientGrants(client).includes("authorization_code"))
    return redirectWithError(
      redirectUri,
      "unauthorized_client",
      "This client is not registered for the authorization code grant",
      state,
    );
  if (q.get("response_type") !== "code")
    return redirectWithError(
      redirectUri,
      "unsupported_response_type",
      "Only response_type=code is supported",
      state,
    );
  const challenge = q.get("code_challenge") ?? "";
  const method = q.get("code_challenge_method") ?? "";
  if (!challenge)
    return redirectWithError(
      redirectUri,
      "invalid_request",
      "PKCE is required: send code_challenge with code_challenge_method=S256",
      state,
    );
  if (method !== "S256")
    return redirectWithError(
      redirectUri,
      "invalid_request",
      "Only the S256 code challenge method is accepted",
      state,
    );
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(challenge))
    return redirectWithError(
      redirectUri,
      "invalid_request",
      "code_challenge must be a base64url SHA-256 digest",
      state,
    );
  const allowed = client.scope.split(" ").filter(Boolean);
  const requested = (q.get("scope") ?? allowed.join(" "))
    .split(/\s+/)
    .filter(Boolean);
  if (
    !requested.length ||
    requested.some(
      (s) =>
        !SCOPES.includes(s as (typeof SCOPES)[number]) || !allowed.includes(s),
    )
  )
    return redirectWithError(
      redirectUri,
      "invalid_scope",
      `Requested scope exceeds this client's registration (${client.scope})`,
      state,
    );
  const resource = q.get("resource");
  // RFC 8707: the only resource this server issues tokens for is itself.
  if (resource && new URL(resource).origin !== origin(env, req))
    return redirectWithError(
      redirectUri,
      "invalid_target",
      "Tokens are only issued for this Caelogram deployment",
      state,
    );
  const person = await clerkCookieIdentity(req, env);
  if (!person) return signInFirst(env, req, url.toString());

  const id = crypto.randomUUID();
  const csrf = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare(
    "INSERT INTO oauth_pending(id,client_id,subject,redirect_uri,scope,state,challenge,resource,csrf_hash,expires,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      client.client_id,
      person.subject,
      redirectUri,
      requested.join(" "),
      state,
      challenge,
      resource,
      digest(csrf),
      Date.now() + PENDING_TTL_MS,
      Date.now(),
    )
    .run();
  return html(
    page(
      "Authorize access",
      `<h1><strong>${escape(client.name)}</strong> wants access to your Caelogram workspace</h1>
<p>Signed in as <strong>${escape(person.subject)}</strong>. It is asking for:</p>
${scopeList(requested)}
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${escape(id)}">
<input type="hidden" name="csrf" value="${escape(csrf)}">
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="approve">Approve</button></div>
</form>
<p class="note">Approving does not widen what you can reach. Caelogram asks GitHub which repositories you may push to on every request, and this application never sees more than that.</p>`,
    ),
    200,
    { "Set-Cookie": csrfCookie(csrf, "/authorize") },
  );
}

export async function authorizeDecision(req: Request, env: Env) {
  const body = await form(req);
  const id = body.get("request") ?? "";
  const csrf = body.get("csrf") ?? "";
  const cookie = cookieValue(req, "caelogram_consent") ?? "";
  // Double submit plus a server-side digest: the form value must equal the
  // cookie set when the page was rendered, and both must match the stored row.
  if (!csrf || !constantEqual(csrf, cookie))
    return notice(
      "Consent could not be confirmed",
      "This approval did not come from the consent page in this browser. Start the connection again from the application.",
      403,
    );
  const row = await env.DB.prepare(
    "DELETE FROM oauth_pending WHERE id=? AND expires>? RETURNING *",
  )
    .bind(id, Date.now())
    .first<{
      client_id: string;
      subject: string;
      redirect_uri: string;
      scope: string;
      state: string | null;
      challenge: string;
      resource: string | null;
      csrf_hash: string;
    }>();
  if (!row || !constantEqual(row.csrf_hash, digest(csrf)))
    return notice(
      "This authorization request expired",
      "Ten minutes passed, or it was already answered. Start the connection again from the application.",
      400,
    );
  const person = await clerkCookieIdentity(req, env);
  if (!person || person.subject !== row.subject)
    return notice(
      "Sign-in changed",
      "The signed-in account is no longer the one that opened this request. Start the connection again.",
      403,
    );
  const headers = { "Set-Cookie": clearCsrfCookie("/authorize") };
  if (body.get("decision") !== "approve") {
    const denial = redirectWithError(
      row.redirect_uri,
      "access_denied",
      "The person declined",
      row.state,
    );
    const merged = new Headers(denial.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(null, { status: 302, headers: merged });
  }
  const grantId = await createGrant(
    env,
    row.client_id,
    person.subject,
    row.scope,
  );
  const code = mint(env, "caac");
  await env.DB.prepare(
    "INSERT INTO oauth_codes(hash,client_id,grant_id,subject,tenant,scope,redirect_uri,challenge,resource,expires,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      digest(code),
      row.client_id,
      grantId,
      person.subject,
      identityTenant(person.subject),
      row.scope,
      row.redirect_uri,
      row.challenge,
      row.resource,
      Date.now() + CODE_TTL_MS,
      Date.now(),
    )
    .run();
  const location = new URL(row.redirect_uri);
  location.searchParams.set("code", code);
  if (row.state) location.searchParams.set("state", row.state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: location.toString(),
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

async function createGrant(
  env: Env,
  clientId: string,
  subject: string,
  scope: string,
) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO oauth_grants(id,client_id,subject,tenant,scope,created) VALUES(?,?,?,?,?,?)",
  )
    .bind(id, clientId, subject, identityTenant(subject), scope, Date.now())
    .run();
  return id;
}

/* ------------------------------------------------------------------ *
 * Device authorization grant (RFC 8628)
 * ------------------------------------------------------------------ */

export async function deviceAuthorization(req: Request, env: Env) {
  if (!(await throttle(env, "device", clientAddress(req), 20, 600_000)))
    return oauthError(
      "slow_down",
      "Too many device authorization requests from this address",
      429,
    );
  const body = await form(req);
  const client = await loadClient(env, body.get("client_id") ?? "");
  if (!client) return oauthError("invalid_client", "Unknown client_id", 401);
  if (!clientGrants(client).includes(DEVICE_GRANT))
    return oauthError(
      "unauthorized_client",
      "This client is not registered for the device authorization grant",
    );
  const allowed = client.scope.split(" ").filter(Boolean);
  const requested = (body.get("scope") ?? "read write")
    .split(/\s+/)
    .filter(Boolean);
  if (
    !requested.length ||
    requested.some(
      (s) =>
        !SCOPES.includes(s as (typeof SCOPES)[number]) || !allowed.includes(s),
    )
  )
    return oauthError(
      "invalid_scope",
      `Requested scope exceeds this client's registration (${client.scope})`,
    );
  const deviceCode = mint(env, "cadc");
  const code = userCode();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO oauth_devices(hash,user_code,client_id,scope,status,interval,polled,expires,created) VALUES(?,?,?,?,'pending',?,?,?,?)",
  )
    .bind(
      digest(deviceCode),
      normalizeUserCode(code),
      client.client_id,
      requested.join(" "),
      DEVICE_INTERVAL_S,
      now,
      now + DEVICE_TTL_MS,
      now,
    )
    .run();
  const base = origin(env, req);
  return jsonResponse({
    device_code: deviceCode,
    user_code: code,
    verification_uri: `${base}/device`,
    verification_uri_complete: `${base}/device?user_code=${encodeURIComponent(code)}`,
    expires_in: Math.floor(DEVICE_TTL_MS / 1000),
    interval: DEVICE_INTERVAL_S,
  });
}

type DeviceRow = {
  hash: string;
  user_code: string;
  client_id: string;
  scope: string;
  status: string;
  subject: string | null;
  grant_id: string | null;
  interval: number;
  polled: number;
  expires: number;
};

/** The browser half of the device grant: enter the code, see the scopes, decide. */
export async function deviceVerification(req: Request, env: Env) {
  const url = new URL(req.url);
  const person = await clerkCookieIdentity(req, env);
  if (!person) return signInFirst(env, req, url.toString());
  const body = req.method === "POST" ? await form(req) : null;
  if (body) {
    const csrf = body.get("csrf") ?? "";
    if (
      !csrf ||
      !constantEqual(csrf, cookieValue(req, "caelogram_consent") ?? "")
    )
      return notice(
        "Consent could not be confirmed",
        "This form did not come from the device page in this browser. Open the verification page again.",
        403,
      );
  }
  const entered = normalizeUserCode(
    body?.get("user_code") ?? url.searchParams.get("user_code") ?? "",
  );
  const csrf = crypto.randomUUID().replaceAll("-", "");
  const setCookie = { "Set-Cookie": csrfCookie(csrf, "/device") };
  const prompt = (message: string, status = 200) =>
    html(
      page(
        "Connect a device",
        `<h1>Connect a device</h1><p>${message}</p>
<form method="post" action="/device">
<input type="hidden" name="csrf" value="${escape(csrf)}">
<input type="text" name="user_code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" value="">
<div class="row"><button class="primary" type="submit">Continue</button></div>
</form>`,
      ),
      status,
      setCookie,
    );
  if (!entered)
    return prompt(
      "Enter the code shown by the application you are signing in.",
    );
  const device = await env.DB.prepare(
    "SELECT * FROM oauth_devices WHERE user_code=?",
  )
    .bind(entered)
    .first<DeviceRow>();
  if (!device || device.expires < Date.now())
    return prompt(
      "That code is not recognised, or it expired. Start the sign-in again in the application and enter the new code.",
      400,
    );
  if (device.status !== "pending")
    return notice(
      "Already answered",
      "This code was already approved or denied. If the application is still waiting, start its sign-in again.",
      400,
    );
  const client = await loadClient(env, device.client_id);
  const decision = body?.get("decision");
  if (!decision) {
    const scopes = device.scope.split(" ").filter(Boolean);
    return html(
      page(
        "Authorize this device",
        `<h1><strong>${escape(client?.name ?? device.client_id)}</strong> is asking to sign in as you</h1>
<p>Signed in as <strong>${escape(person.subject)}</strong>. Confirm the code shown by the application is <code>${escape(entered.slice(0, 4))}-${escape(entered.slice(4))}</code>, and that it is asking for:</p>
${scopeList(scopes)}
<form method="post" action="/device">
<input type="hidden" name="csrf" value="${escape(csrf)}">
<input type="hidden" name="user_code" value="${escape(entered)}">
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="approve">Approve</button></div>
</form>
<p class="note">Approving does not widen what you can reach. Caelogram asks GitHub which repositories you may push to on every request.</p>`,
      ),
      200,
      setCookie,
    );
  }
  if (decision !== "approve") {
    await env.DB.prepare(
      "UPDATE oauth_devices SET status='denied' WHERE hash=? AND status='pending'",
    )
      .bind(device.hash)
      .run();
    return notice(
      "Denied",
      "The application was told it may not sign in as you. You can close this page.",
      200,
    );
  }
  const grantId = await createGrant(
    env,
    device.client_id,
    person.subject,
    device.scope,
  );
  const applied = await env.DB.prepare(
    "UPDATE oauth_devices SET status='approved',subject=?,tenant=?,grant_id=? WHERE hash=? AND status='pending'",
  )
    .bind(person.subject, identityTenant(person.subject), grantId, device.hash)
    .run();
  if (!applied.meta.changes)
    return notice(
      "Already answered",
      "This code was answered from another window.",
      400,
    );
  return html(
    page(
      "Device connected",
      `<h1>Device connected</h1><p><strong>${escape(client?.name ?? device.client_id)}</strong> may now act as you within the scope you approved. Return to the application; it will continue on its own.</p><p class="note">Revoke it at any time from Access &amp; integrations in the Caelogram console.</p>`,
    ),
    200,
    { "Set-Cookie": clearCsrfCookie("/device") },
  );
}

/* ------------------------------------------------------------------ *
 * Token endpoint
 * ------------------------------------------------------------------ */

/** RFC 6749 §2.3: Basic first, then a secret in the body. Public clients send neither. */
async function authenticateClient(
  req: Request,
  env: Env,
  body: URLSearchParams,
) {
  let id = body.get("client_id") ?? "";
  let secret = body.get("client_secret") ?? "";
  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const at = decoded.indexOf(":");
    if (at < 0) return { error: "invalid_client" as const };
    id = decodeURIComponent(decoded.slice(0, at));
    secret = decodeURIComponent(decoded.slice(at + 1));
  }
  const client = await loadClient(env, id);
  if (!client) return { error: "invalid_client" as const };
  if (client.secret_hash) {
    if (!secret || !constantEqual(client.secret_hash, digest(secret)))
      return { error: "invalid_client" as const };
  } else if (secret) {
    // A public client has no secret; presenting one means the caller is confused
    // about which client it is.
    return { error: "invalid_client" as const };
  }
  return { client };
}

export async function token(req: Request, env: Env) {
  const body = await form(req);
  if (!(await throttle(env, "token", clientAddress(req), 120, 60_000)))
    return oauthError("slow_down", "Too many token requests", 429);
  const authenticated = await authenticateClient(req, env, body);
  if ("error" in authenticated)
    return oauthError(
      "invalid_client",
      "Unknown client, or client authentication failed",
      401,
    );
  const client = authenticated.client;
  const grantType = body.get("grant_type") ?? "";
  if (!clientGrants(client).includes(grantType))
    return oauthError(
      "unauthorized_client",
      `This client is not registered for ${grantType || "that grant type"}`,
    );
  if (grantType === "authorization_code") return codeGrant(env, client, body);
  if (grantType === "refresh_token") return refreshGrant(env, client, body);
  if (grantType === DEVICE_GRANT) return deviceGrant(env, client, body);
  return oauthError(
    "unsupported_grant_type",
    `Supported grant types: ${GRANT_TYPES.join(", ")}`,
  );
}

async function codeGrant(env: Env, client: Client, body: URLSearchParams) {
  const code = body.get("code") ?? "";
  const verifier = body.get("code_verifier") ?? "";
  if (!signed(env, "caac", code))
    return oauthError("invalid_grant", "Unusable authorization code");
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier))
    return oauthError(
      "invalid_request",
      "code_verifier is required and must be 43 to 128 unreserved characters",
    );
  // Single use: the row is deleted as it is read, so a replay finds nothing even
  // if two requests race.
  const row = await env.DB.prepare(
    "DELETE FROM oauth_codes WHERE hash=? RETURNING *",
  )
    .bind(digest(code))
    .first<{
      client_id: string;
      grant_id: string;
      subject: string;
      scope: string;
      redirect_uri: string;
      challenge: string;
      expires: number;
    }>();
  if (!row)
    return oauthError("invalid_grant", "Authorization code is not valid");
  if (row.expires < Date.now())
    return oauthError("invalid_grant", "Authorization code expired");
  if (row.client_id !== client.client_id) {
    // Wrong client presenting someone else's code: burn the whole grant.
    await revokeGrant(env, row.grant_id);
    return oauthError(
      "invalid_grant",
      "Authorization code was issued to another client",
    );
  }
  const redirectUri = body.get("redirect_uri") ?? "";
  if (!constantEqual(redirectUri, row.redirect_uri))
    return oauthError(
      "invalid_grant",
      "redirect_uri does not match the one the code was issued for",
    );
  const computed = createHash("sha256").update(verifier).digest("base64url");
  if (!constantEqual(computed, row.challenge)) {
    await revokeGrant(env, row.grant_id);
    return oauthError("invalid_grant", "PKCE verification failed");
  }
  return issue(env, {
    grantId: row.grant_id,
    clientId: client.client_id,
    subject: row.subject,
    scope: row.scope,
  });
}

async function refreshGrant(env: Env, client: Client, body: URLSearchParams) {
  const presented = body.get("refresh_token") ?? "";
  if (!signed(env, "cart", presented))
    return oauthError("invalid_grant", "Unusable refresh token");
  const row = await env.DB.prepare(
    "SELECT * FROM oauth_tokens WHERE hash=? AND kind='refresh'",
  )
    .bind(digest(presented))
    .first<{
      grant_id: string;
      client_id: string;
      subject: string;
      scope: string;
      expires: number;
      used: number | null;
    }>();
  if (!row) return oauthError("invalid_grant", "Refresh token is not valid");
  if (row.client_id !== client.client_id)
    return oauthError(
      "invalid_grant",
      "Refresh token belongs to another client",
    );
  if (row.used) {
    // Reuse of a rotated token means a copy leaked. Kill the family.
    await revokeGrant(env, row.grant_id);
    return oauthError(
      "invalid_grant",
      "Refresh token was already used; the grant has been revoked",
    );
  }
  if (row.expires < Date.now())
    return oauthError("invalid_grant", "Refresh token expired");
  const grant = await env.DB.prepare(
    "SELECT revoked FROM oauth_grants WHERE id=?",
  )
    .bind(row.grant_id)
    .first<{ revoked: number | null }>();
  if (!grant || grant.revoked)
    return oauthError("invalid_grant", "This authorization was revoked");
  const requested = (body.get("scope") ?? row.scope)
    .split(/\s+/)
    .filter(Boolean);
  const held = row.scope.split(" ");
  if (requested.some((s) => !held.includes(s)))
    return oauthError("invalid_scope", "A refresh cannot widen scope");
  // Rotation: the presented token is retired now, and kept only so that a later
  // presentation is recognised as reuse.
  await env.DB.prepare(
    "UPDATE oauth_tokens SET used=? WHERE hash=? AND kind='refresh'",
  )
    .bind(Date.now(), digest(presented))
    .run();
  return issue(env, {
    grantId: row.grant_id,
    clientId: client.client_id,
    subject: row.subject,
    scope: requested.join(" "),
  });
}

async function deviceGrant(env: Env, client: Client, body: URLSearchParams) {
  const deviceCode = body.get("device_code") ?? "";
  if (!signed(env, "cadc", deviceCode))
    return oauthError("invalid_grant", "Unusable device code");
  const row = await env.DB.prepare("SELECT * FROM oauth_devices WHERE hash=?")
    .bind(digest(deviceCode))
    .first<DeviceRow & { tenant: string | null }>();
  if (!row) return oauthError("expired_token", "Device code is not valid");
  if (row.client_id !== client.client_id)
    return oauthError("invalid_grant", "Device code belongs to another client");
  if (row.expires < Date.now()) {
    await env.DB.prepare("DELETE FROM oauth_devices WHERE hash=?")
      .bind(row.hash)
      .run();
    return oauthError("expired_token", "Device code expired; sign in again");
  }
  const now = Date.now();
  const early = now - row.polled < row.interval * 1000;
  await env.DB.prepare("UPDATE oauth_devices SET polled=? WHERE hash=?")
    .bind(now, row.hash)
    .run();
  if (early)
    return oauthError(
      "slow_down",
      `Poll no more than once every ${row.interval} seconds`,
    );
  if (row.status === "denied") {
    await env.DB.prepare("DELETE FROM oauth_devices WHERE hash=?")
      .bind(row.hash)
      .run();
    return oauthError("access_denied", "Authorization was denied");
  }
  if (row.status !== "approved" || !row.subject || !row.grant_id)
    return oauthError(
      "authorization_pending",
      "Waiting for the code to be approved in a browser",
    );
  // Redeemable exactly once.
  const claimed = await env.DB.prepare(
    "DELETE FROM oauth_devices WHERE hash=? AND status='approved' RETURNING subject,grant_id,scope",
  )
    .bind(row.hash)
    .first<{ subject: string; grant_id: string; scope: string }>();
  if (!claimed)
    return oauthError("invalid_grant", "Device code was already redeemed");
  return issue(env, {
    grantId: claimed.grant_id,
    clientId: client.client_id,
    subject: claimed.subject,
    scope: claimed.scope,
  });
}

async function issue(
  env: Env,
  grant: { grantId: string; clientId: string; subject: string; scope: string },
) {
  const access = mint(env, "caot");
  const refresh = mint(env, "cart");
  const now = Date.now();
  const tenant = identityTenant(grant.subject);
  const record = (hash: string, kind: string, expires: number) =>
    env.DB.prepare(
      "INSERT INTO oauth_tokens(hash,id,kind,grant_id,client_id,subject,tenant,scope,expires,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      hash,
      crypto.randomUUID(),
      kind,
      grant.grantId,
      grant.clientId,
      grant.subject,
      tenant,
      grant.scope,
      expires,
      now,
    );
  await env.DB.batch([
    record(digest(access), "access", now + ACCESS_TTL_MS),
    record(digest(refresh), "refresh", now + REFRESH_TTL_MS),
  ]);
  return jsonResponse({
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope: grant.scope,
  });
}

async function revokeGrant(env: Env, grantId: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE oauth_grants SET revoked=? WHERE id=?").bind(
      Date.now(),
      grantId,
    ),
    env.DB.prepare("DELETE FROM oauth_tokens WHERE grant_id=?").bind(grantId),
    env.DB.prepare("DELETE FROM oauth_codes WHERE grant_id=?").bind(grantId),
  ]);
}

/* ------------------------------------------------------------------ *
 * Revocation (RFC 7009)
 * ------------------------------------------------------------------ */

export async function revoke(req: Request, env: Env) {
  const body = await form(req);
  const authenticated = await authenticateClient(req, env, body);
  if ("error" in authenticated)
    return oauthError("invalid_client", "Client authentication failed", 401);
  const presented = body.get("token") ?? "";
  // RFC 7009 §2.2: an unknown or already-revoked token is a successful
  // revocation. Only a broken request is an error.
  if (presented) {
    const row = await env.DB.prepare(
      "SELECT grant_id,client_id FROM oauth_tokens WHERE hash=?",
    )
      .bind(digest(presented))
      .first<{ grant_id: string; client_id: string }>();
    if (row && row.client_id === authenticated.client.client_id)
      // Revoking a refresh token takes every access token issued from the same
      // authorization with it, which is what the CLI's logout expects.
      await revokeGrant(env, row.grant_id);
  }
  return jsonResponse({}, 200);
}

/* ------------------------------------------------------------------ *
 * Resource-server side: turning a token into a Principal
 * ------------------------------------------------------------------ */

/**
 * A Caelogram access token identifies a person and the scope they consented to.
 * It carries `["*"]` for repositories, meaning "whatever GitHub grants this
 * person right now" — the worker replaces it with the resolved list before any
 * tool runs, so a token can never widen access beyond the live GitHub answer.
 */
export async function oauthIdentity(
  token: string,
  env: Env,
): Promise<Principal> {
  assert(signed(env, "caot", token), "Invalid or expired access token", 401);
  const row = await env.DB.prepare(
    "SELECT t.subject,t.tenant,t.scope,g.revoked FROM oauth_tokens t LEFT JOIN oauth_grants g ON g.id=t.grant_id WHERE t.hash=? AND t.kind='access' AND t.expires>?",
  )
    .bind(digest(token), Date.now())
    .first<{
      subject: string;
      tenant: string;
      scope: string;
      revoked: number | null;
    }>();
  assert(row && !row.revoked, "Invalid or expired access token", 401);
  return {
    subject: row.subject,
    tenant: row.tenant,
    tenants: [row.tenant],
    scopes: row.scope.split(" ").filter(Boolean),
    // Never a repository list from the token. See resolveAccess.
    repositories: ["*"],
  };
}

/** Expired authorization state is dead weight; the scheduled run clears it. */
export function oauthCleanupStatements(now = Date.now()) {
  return [
    ["DELETE FROM oauth_codes WHERE expires<?", now],
    ["DELETE FROM oauth_pending WHERE expires<?", now],
    ["DELETE FROM oauth_devices WHERE expires<?", now],
    ["DELETE FROM oauth_tokens WHERE expires<?", now],
    ["DELETE FROM oauth_rate WHERE window<?", now - 3_600_000],
    ["DELETE FROM oauth_grants WHERE revoked<?", now - 30 * 86_400_000],
  ] as const;
}

/** Routing table for the worker. Returns null when the path is not ours. */
export async function oauthRoute(
  req: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const method = req.method;
  const publicEndpoints = [
    "/register",
    "/token",
    "/revoke",
    "/device_authorization",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
  ];
  const isPublic = publicEndpoints.some(
    (p) => path === p || path.startsWith(p + "/"),
  );
  if (method === "OPTIONS" && isPublic)
    return new Response(null, { status: 204, headers: CORS });
  if (path.startsWith("/.well-known/oauth-authorization-server"))
    return authorizationServerMetadata(env, req);
  if (path.startsWith("/.well-known/oauth-protected-resource"))
    return protectedResourceMetadata(env, req);
  if (path === "/register")
    return method === "POST"
      ? register(req, env)
      : oauthError("invalid_request", "POST client metadata to register", 405);
  if (path === "/authorize") {
    if (method === "GET") return authorize(req, env);
    if (method === "POST") return authorizeDecision(req, env);
    return notice("Method not allowed", "Open this page in a browser.", 405);
  }
  if (path === "/device") {
    if (method === "GET" || method === "POST")
      return deviceVerification(req, env);
    return notice("Method not allowed", "Open this page in a browser.", 405);
  }
  if (path === "/device_authorization")
    return method === "POST"
      ? deviceAuthorization(req, env)
      : oauthError("invalid_request", "POST to this endpoint", 405);
  if (path === "/token")
    return method === "POST"
      ? token(req, env)
      : oauthError("invalid_request", "POST to this endpoint", 405);
  if (path === "/revoke")
    return method === "POST"
      ? revoke(req, env)
      : oauthError("invalid_request", "POST to this endpoint", 405);
  return null;
}
