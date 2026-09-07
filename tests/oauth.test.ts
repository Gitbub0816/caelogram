/**
 * The Caelogram authorization server, exercised through the real worker fetch
 * handler against miniflare's D1 and R2. Clerk is the only thing stubbed: a
 * local RSA key stands in for the instance's JWKS, so a "signed-in browser" is
 * a cookie this file signs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { SignJWT, exportJWK, generateKeyPair, type KeyObject } from "jose";
import worker from "../cloudflare/worker.js";
import type { Env } from "../cloudflare/worker.js";
import { createHash } from "node:crypto";
import {
  discover,
  requestDeviceCode,
  pollForToken,
  refreshCredentials,
  revokeToken,
  DEFAULT_CLIENT_ID,
  DEFAULT_SCOPE,
} from "../src/auth.js";

const migrations = readdirSync("cloudflare/migrations").sort();
const ISSUER = "https://clerk.test";
const ORIGIN = "https://caelogram.test";

// One key pair for the file: the worker caches Clerk's key set per issuer, so a
// second pair would be checked against the first one's published key.
const { privateKey, publicKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const jwk = { ...(await exportJWK(publicKey as KeyObject)), kid: "test" };

type Harness = {
  env: Env;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  cookie: (subject?: string) => Promise<string>;
  dispose: () => Promise<void>;
};

async function harness(t: any): Promise<Harness> {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      compatibilityDate: "2026-09-01",
      d1Databases: ["DB"],
      r2Buckets: ["SOURCE"],
    }),
  );
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("SOURCE");
  for (const file of migrations)
    for (const sql of readFileSync("cloudflare/migrations/" + file, "utf8")
      .trim()
      .split("\n"))
      await db.prepare(sql).run();
  const upstream = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith(`${ISSUER}/.well-known/jwks.json`))
      return Response.json({ keys: [jwk] });
    if (url.startsWith("https://api.github.com"))
      // No GitHub App installation in these tests: the person may push nowhere.
      return Response.json({ total_count: 0, installations: [] });
    return upstream(input, init);
  });
  const env = {
    DB: db,
    SOURCE: bucket,
    DATA_KEY: "a".repeat(64),
    PUBLIC_ORIGIN: ORIGIN,
    CLERK_ISSUER: ISSUER,
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_APP_SLUG: "caelogram-test",
    INSTALLATIONS: "{}",
    REQUEST_LIMIT: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response("asset") },
  } as unknown as Env;
  return {
    env,
    fetch: (path, init) =>
      worker.fetch(new Request(ORIGIN + path, init), env) as Promise<Response>,
    cookie: async (subject = "user_alice") =>
      "__session=" +
      (await new SignJWT({ sid: "sess_1", azp: ORIGIN })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(ISSUER)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey)),
    dispose: () => mf.dispose(),
  };
}

const formInit = (fields: Record<string, string>, cookie?: string) => ({
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    ...(cookie ? { Cookie: cookie } : {}),
  },
  body: new URLSearchParams(fields).toString(),
});
const field = (html: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] ?? "";
const verifier = "z".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");

async function registerClient(h: Harness, extra: Record<string, unknown> = {}) {
  const response = await h.fetch("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test MCP Client",
      redirect_uris: ["https://client.test/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      scope: "read write",
      ...extra,
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as any;
}

/** Walk the consent screen and come back with the authorization code. */
async function approve(h: Harness, url: string, cookie: string) {
  const consent = await h.fetch(url, { headers: { Cookie: cookie } });
  assert.equal(consent.status, 200);
  const body = await consent.text();
  const csrf = field(body, "csrf");
  const decision = await h.fetch(
    "/authorize",
    formInit(
      { request: field(body, "request"), csrf, decision: "approve" },
      `${cookie}; caelogram_consent=${csrf}`,
    ),
  );
  assert.equal(decision.status, 302);
  return new URL(decision.headers.get("Location")!);
}

test("metadata documents advertise this deployment as its own authorization server", async (t) => {
  const h = await harness(t);
  try {
    const as = await h.fetch("/.well-known/oauth-authorization-server");
    assert.equal(as.status, 200);
    const meta = (await as.json()) as any;
    assert.equal(meta.issuer, ORIGIN);
    assert.equal(meta.authorization_endpoint, `${ORIGIN}/authorize`);
    assert.equal(meta.token_endpoint, `${ORIGIN}/token`);
    assert.equal(meta.registration_endpoint, `${ORIGIN}/register`);
    assert.equal(meta.revocation_endpoint, `${ORIGIN}/revoke`);
    assert.equal(
      meta.device_authorization_endpoint,
      `${ORIGIN}/device_authorization`,
    );
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
    assert(
      meta.grant_types_supported.includes(
        "urn:ietf:params:oauth:grant-type:device_code",
      ),
    );
    const resource = await h.fetch("/.well-known/oauth-protected-resource");
    assert.deepEqual(((await resource.json()) as any).authorization_servers, [
      ORIGIN,
    ]);
    // The MCP spec allows the path-suffixed form of both documents.
    assert.equal(
      (await h.fetch("/.well-known/oauth-protected-resource/mcp")).status,
      200,
    );
    // Preflight, for browser-hosted MCP clients.
    const preflight = await h.fetch("/token", { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    await h.dispose();
  }
});

test("dynamic client registration accepts usable redirect URIs and refuses the rest", async (t) => {
  const h = await harness(t);
  try {
    const client = await registerClient(h);
    assert.equal(client.token_endpoint_auth_method, "none");
    assert.equal(client.client_secret, undefined);
    assert.deepEqual(client.grant_types, [
      "authorization_code",
      "refresh_token",
    ]);
    for (const uri of [
      "http://evil.test/callback",
      "https://client.test/*",
      "https://client.test/cb#fragment",
      "javascript:alert(1)",
      "not a url",
    ]) {
      const response = await h.fetch("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [uri] }),
      });
      assert.equal(response.status, 400, uri);
      assert.equal(
        ((await response.json()) as any).error,
        "invalid_redirect_uri",
      );
    }
    // Loopback for native clients, and a confidential client gets one secret.
    const native = await registerClient(h, {
      redirect_uris: ["http://127.0.0.1:7777/callback"],
    });
    assert(native.client_id);
    const confidential = await registerClient(h, {
      token_endpoint_auth_method: "client_secret_post",
    });
    assert.equal(typeof confidential.client_secret, "string");
    // A scope outside the product's four is refused outright.
    const bad = await h.fetch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.test/cb"],
        scope: "read superuser",
      }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await h.dispose();
  }
});

test("authorization code with PKCE: consent, single use, and exact redirect matching", async (t) => {
  const h = await harness(t);
  try {
    const client = await registerClient(h);
    const authorizeUrl =
      `/authorize?response_type=code&client_id=${client.client_id}` +
      `&redirect_uri=${encodeURIComponent("https://client.test/callback")}` +
      `&scope=read+write&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`;

    // Nobody signed in: the page asks for sign-in, and issues nothing.
    const anonymous = await h.fetch(authorizeUrl);
    assert.equal(anonymous.status, 200);
    assert.match(await anonymous.text(), /Sign in to approve/);

    const cookie = await h.cookie();
    const consent = await h.fetch(authorizeUrl, {
      headers: { Cookie: cookie },
    });
    const consentBody = await consent.text();
    assert.match(consentBody, /Test MCP Client/);
    assert.match(consentBody, /Create tasks and submit changesets/);
    assert.equal(consent.headers.get("X-Frame-Options"), "DENY");

    // A decision without the consent cookie is not a decision.
    const forged = await h.fetch(
      "/authorize",
      formInit(
        {
          request: field(consentBody, "request"),
          csrf: field(consentBody, "csrf"),
          decision: "approve",
        },
        cookie,
      ),
    );
    assert.equal(forged.status, 403);

    const redirect = await approve(h, authorizeUrl, cookie);
    assert.equal(
      redirect.origin + redirect.pathname,
      "https://client.test/callback",
    );
    assert.equal(redirect.searchParams.get("state"), "xyz");
    const code = redirect.searchParams.get("code")!;
    assert.match(code, /^caac_[a-f0-9]{64}\.[a-f0-9]{32}$/);

    // Redirect URI must match the one the code was issued for. A failed
    // exchange also spends the code, so this uses an authorization of its own.
    const other = await approve(h, authorizeUrl, cookie);
    const mismatched = await h.fetch(
      "/token",
      formInit({
        grant_type: "authorization_code",
        code: other.searchParams.get("code")!,
        client_id: client.client_id,
        redirect_uri: "https://client.test/callback2",
        code_verifier: verifier,
      }),
    );
    assert.equal(mismatched.status, 400);
    assert.equal(((await mismatched.json()) as any).error, "invalid_grant");

    const exchange = await h.fetch(
      "/token",
      formInit({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://client.test/callback",
        code_verifier: verifier,
      }),
    );
    assert.equal(exchange.status, 200);
    const tokens = (await exchange.json()) as any;
    assert.match(tokens.access_token, /^caot_[a-f0-9]{64}\.[a-f0-9]{32}$/);
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.expires_in, 900);
    assert.equal(tokens.scope, "read write");
    assert(tokens.refresh_token);

    // Replay of a spent code.
    const replay = await h.fetch(
      "/token",
      formInit({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://client.test/callback",
        code_verifier: verifier,
      }),
    );
    assert.equal(((await replay.json()) as any).error, "invalid_grant");
  } finally {
    await h.dispose();
  }
});

test("PKCE is mandatory, S256 only, and a wrong verifier burns the grant", async (t) => {
  const h = await harness(t);
  try {
    const client = await registerClient(h);
    const cookie = await h.cookie();
    const base =
      `/authorize?response_type=code&client_id=${client.client_id}` +
      `&redirect_uri=${encodeURIComponent("https://client.test/callback")}`;
    const errorOf = async (query: string) => {
      const r = await h.fetch(base + query, { headers: { Cookie: cookie } });
      assert.equal(r.status, 302);
      return new URL(r.headers.get("Location")!).searchParams.get("error");
    };
    assert.equal(await errorOf(""), "invalid_request");
    assert.equal(
      await errorOf(`&code_challenge=${challenge}&code_challenge_method=plain`),
      "invalid_request",
    );
    assert.equal(
      await errorOf(`&code_challenge=short&code_challenge_method=S256`),
      "invalid_request",
    );
    assert.equal(
      await errorOf(
        `&code_challenge=${challenge}&code_challenge_method=S256&scope=admin+read`,
      ),
      "invalid_scope",
    );

    const redirect = await approve(
      h,
      base + `&code_challenge=${challenge}&code_challenge_method=S256`,
      cookie,
    );
    const code = redirect.searchParams.get("code")!;
    const wrong = await h.fetch(
      "/token",
      formInit({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://client.test/callback",
        code_verifier: "y".repeat(64),
      }),
    );
    assert.equal(((await wrong.json()) as any).error, "invalid_grant");
    // The whole grant is gone, so the code cannot be retried with the right one.
    const retry = await h.fetch(
      "/token",
      formInit({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://client.test/callback",
        code_verifier: verifier,
      }),
    );
    assert.equal(((await retry.json()) as any).error, "invalid_grant");
  } finally {
    await h.dispose();
  }
});

test("an unknown client or an unregistered redirect URI is never redirected to", async (t) => {
  const h = await harness(t);
  try {
    const client = await registerClient(h);
    const unknown = await h.fetch(
      "/authorize?response_type=code&client_id=nope&redirect_uri=https%3A%2F%2Fclient.test%2Fcallback",
    );
    assert.equal(unknown.status, 400);
    assert.equal(unknown.headers.get("Location"), null);
    const attacker = await h.fetch(
      `/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://client.test/callback/../evil")}`,
    );
    assert.equal(attacker.status, 400);
    assert.equal(attacker.headers.get("Location"), null);
    assert.match(await attacker.text(), /matches redirect addresses exactly/);
  } finally {
    await h.dispose();
  }
});

test("device authorization grant: pending, slow_down, approval, single redemption, denial and expiry", async (t) => {
  const h = await harness(t);
  try {
    const start = await h.fetch(
      "/device_authorization",
      formInit({ client_id: "caelogram-cli", scope: "read write" }),
    );
    assert.equal(start.status, 200);
    const device = (await start.json()) as any;
    assert.match(device.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(device.verification_uri, `${ORIGIN}/device`);
    assert.equal(
      device.verification_uri_complete,
      `${ORIGIN}/device?user_code=${encodeURIComponent(device.user_code)}`,
    );
    assert.equal(device.interval, 5);
    assert.equal(device.expires_in, 900);

    const poll = () =>
      h.fetch(
        "/token",
        formInit({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: "caelogram-cli",
        }),
      );
    // Polling sooner than the interval is answered with slow_down, exactly as
    // the CLI contract expects.
    const early = await poll();
    assert.equal(early.status, 400);
    assert.equal(((await early.json()) as any).error, "slow_down");
    const age = () =>
      h.env.DB.prepare("UPDATE oauth_devices SET polled=?").bind(0).run();
    await age();
    const pending = await poll();
    assert.equal(
      ((await pending.json()) as any).error,
      "authorization_pending",
    );

    const cookie = await h.cookie();
    // The verification page requires a signed-in person.
    const anonymous = await h.fetch(`/device?user_code=${device.user_code}`);
    assert.match(await anonymous.text(), /Sign in to approve/);
    const page = await h.fetch(`/device?user_code=${device.user_code}`, {
      headers: { Cookie: cookie },
    });
    const body = await page.text();
    assert.match(body, /Caelogram CLI/);
    const csrf = field(body, "csrf");
    const denied = await h.fetch(
      "/device",
      formInit(
        { user_code: device.user_code, csrf, decision: "approve" },
        cookie,
      ),
    );
    assert.equal(denied.status, 403, "no consent cookie, no approval");

    const approved = await h.fetch(
      "/device",
      formInit(
        { user_code: device.user_code, csrf, decision: "approve" },
        `${cookie}; caelogram_consent=${csrf}`,
      ),
    );
    assert.equal(approved.status, 200);
    assert.match(await approved.text(), /Device connected/);

    await age();
    const issued = await poll();
    assert.equal(issued.status, 200);
    const tokens = (await issued.json()) as any;
    assert(tokens.access_token && tokens.refresh_token);
    assert.equal(tokens.scope, "read write");
    // A device code is redeemable once.
    await age();
    const again = await poll();
    assert.equal(again.status, 400);
    assert.equal(((await again.json()) as any).error, "expired_token");

    // Denial.
    const second = (await (
      await h.fetch(
        "/device_authorization",
        formInit({ client_id: "caelogram-cli", scope: "read" }),
      )
    ).json()) as any;
    const denyPage = await h.fetch(`/device?user_code=${second.user_code}`, {
      headers: { Cookie: cookie },
    });
    const denyCsrf = field(await denyPage.text(), "csrf");
    await h.fetch(
      "/device",
      formInit(
        { user_code: second.user_code, csrf: denyCsrf, decision: "deny" },
        `${cookie}; caelogram_consent=${denyCsrf}`,
      ),
    );
    await age();
    const refused = await h.fetch(
      "/token",
      formInit({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: second.device_code,
        client_id: "caelogram-cli",
      }),
    );
    assert.equal(((await refused.json()) as any).error, "access_denied");

    // Expiry.
    const third = (await (
      await h.fetch(
        "/device_authorization",
        formInit({ client_id: "caelogram-cli", scope: "read" }),
      )
    ).json()) as any;
    await h.env.DB.prepare("UPDATE oauth_devices SET expires=1,polled=0").run();
    const stale = await h.fetch(
      "/token",
      formInit({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: third.device_code,
        client_id: "caelogram-cli",
      }),
    );
    assert.equal(((await stale.json()) as any).error, "expired_token");
  } finally {
    await h.dispose();
  }
});

test("refresh rotates, reuse revokes the family, and revocation kills the grant", async (t) => {
  const h = await harness(t);
  try {
    const client = await registerClient(h);
    const cookie = await h.cookie();
    const redirect = await approve(
      h,
      `/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://client.test/callback")}&scope=read+write&code_challenge=${challenge}&code_challenge_method=S256`,
      cookie,
    );
    const first = (await (
      await h.fetch(
        "/token",
        formInit({
          grant_type: "authorization_code",
          code: redirect.searchParams.get("code")!,
          client_id: client.client_id,
          redirect_uri: "https://client.test/callback",
          code_verifier: verifier,
        }),
      )
    ).json()) as any;

    const refresh = (token: string) =>
      h.fetch(
        "/token",
        formInit({
          grant_type: "refresh_token",
          refresh_token: token,
          client_id: client.client_id,
        }),
      );
    const rotated = await refresh(first.refresh_token);
    assert.equal(rotated.status, 200);
    const second = (await rotated.json()) as any;
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.notEqual(second.access_token, first.access_token);
    // A refresh may not widen scope.
    const widened = await h.fetch(
      "/token",
      formInit({
        grant_type: "refresh_token",
        refresh_token: second.refresh_token,
        client_id: client.client_id,
        scope: "read write admin",
      }),
    );
    assert.equal(((await widened.json()) as any).error, "invalid_scope");
    // Reuse of the rotated token means a copy leaked: the family dies.
    const reuse = await refresh(first.refresh_token);
    assert.equal(reuse.status, 400);
    assert.equal(((await reuse.json()) as any).error, "invalid_grant");
    assert.equal((await refresh(second.refresh_token)).status, 400);
    const dead = await h.fetch("/api/tools/list_repositories", {
      method: "POST",
      headers: { Authorization: `Bearer ${second.access_token}` },
      body: "{}",
    });
    assert.equal(dead.status, 401);

    // A second grant, revoked explicitly.
    const next = await approve(
      h,
      `/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://client.test/callback")}&scope=read&code_challenge=${challenge}&code_challenge_method=S256`,
      cookie,
    );
    const live = (await (
      await h.fetch(
        "/token",
        formInit({
          grant_type: "authorization_code",
          code: next.searchParams.get("code")!,
          client_id: client.client_id,
          redirect_uri: "https://client.test/callback",
          code_verifier: verifier,
        }),
      )
    ).json()) as any;
    const ok = await h.fetch("/api/tools/list_repositories", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${live.access_token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(ok.status, 200);
    const revoked = await h.fetch(
      "/revoke",
      formInit({
        token: live.refresh_token,
        token_type_hint: "refresh_token",
        client_id: client.client_id,
      }),
    );
    assert.equal(revoked.status, 200);
    const after = await h.fetch("/api/tools/list_repositories", {
      method: "POST",
      headers: { Authorization: `Bearer ${live.access_token}` },
      body: "{}",
    });
    assert.equal(
      after.status,
      401,
      "revoking a refresh token kills its access tokens",
    );
    // An unknown token is still a successful revocation (RFC 7009 §2.2).
    assert.equal(
      (
        await h.fetch(
          "/revoke",
          formInit({ token: "caot_nonsense", client_id: client.client_id }),
        )
      ).status,
      200,
    );
  } finally {
    await h.dispose();
  }
});

test("an issued access token authenticates an MCP session and expires", async (t) => {
  const h = await harness(t);
  try {
    const device = (await (
      await h.fetch(
        "/device_authorization",
        formInit({ client_id: "caelogram-cli", scope: "read write" }),
      )
    ).json()) as any;
    const cookie = await h.cookie();
    const page = await h.fetch(`/device?user_code=${device.user_code}`, {
      headers: { Cookie: cookie },
    });
    const csrf = field(await page.text(), "csrf");
    await h.fetch(
      "/device",
      formInit(
        { user_code: device.user_code, csrf, decision: "approve" },
        `${cookie}; caelogram_consent=${csrf}`,
      ),
    );
    await h.env.DB.prepare("UPDATE oauth_devices SET polled=0").run();
    const tokens = (await (
      await h.fetch(
        "/token",
        formInit({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: "caelogram-cli",
        }),
      )
    ).json()) as any;

    const rpc = (body: unknown) =>
      h.fetch("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
    const initialize = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    assert.equal(initialize.status, 200);
    const session = (await initialize.json()) as any;
    assert.equal(session.result.serverInfo.name, "caelogram");
    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(listed.status, 200);
    const tools = (await listed.json()) as any;
    assert(
      tools.result.tools.some((tool: any) => tool.name === "list_repositories"),
    );

    // Expiry is enforced by the token record, and 401 points at the metadata.
    await h.env.DB.prepare(
      "UPDATE oauth_tokens SET expires=1 WHERE kind='access'",
    ).run();
    const expired = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.equal(expired.status, 401);
    assert.match(
      expired.headers.get("WWW-Authenticate") || "",
      /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/,
    );
    // A forged token that Caelogram never signed is refused without a lookup.
    const forged = await h.fetch("/api/tools/list_repositories", {
      method: "POST",
      headers: {
        Authorization: `Bearer caot_${"0".repeat(64)}.${"0".repeat(32)}`,
      },
      body: "{}",
    });
    assert.equal(forged.status, 401);
  } finally {
    await h.dispose();
  }
});

test("the shipped CLI client drives this server end to end, per docs/cli-auth-contract.md", async (t) => {
  const h = await harness(t);
  try {
    const cookie = await h.cookie("user_carol");
    // The CLI's own I/O, pointed at the worker. Sleeping stands for time
    // passing, which is also what clears the device poll interval.
    const deps = {
      fetch: (async (input: any, init?: any) => {
        const url = new URL(String(input?.url ?? input));
        return h.fetch(url.pathname + url.search, init);
      }) as typeof globalThis.fetch,
      now: () => Date.now(),
      sleep: async () => {
        await h.env.DB.prepare("UPDATE oauth_devices SET polled=0").run();
      },
      log: () => {},
    };
    const metadata = await discover(ORIGIN, deps);
    assert.equal(metadata.issuer, ORIGIN);
    assert.equal(
      metadata.deviceAuthorizationEndpoint,
      `${ORIGIN}/device_authorization`,
    );
    assert.equal(metadata.tokenEndpoint, `${ORIGIN}/token`);
    assert.equal(metadata.revocationEndpoint, `${ORIGIN}/revoke`);
    const device = await requestDeviceCode(
      metadata,
      DEFAULT_CLIENT_ID,
      DEFAULT_SCOPE,
      deps,
    );
    assert.equal(device.interval, 5);
    // Approve in the browser while the CLI is polling.
    const page = await h.fetch(`/device?user_code=${device.userCode}`, {
      headers: { Cookie: cookie },
    });
    const csrf = field(await page.text(), "csrf");
    await h.fetch(
      "/device",
      formInit(
        { user_code: device.userCode, csrf, decision: "approve" },
        `${cookie}; caelogram_consent=${csrf}`,
      ),
    );
    const credentials = await pollForToken(
      metadata,
      DEFAULT_CLIENT_ID,
      device,
      deps,
    );
    assert.equal(credentials.scope, "read write");
    assert(credentials.refreshToken);
    assert(credentials.expiresAt && credentials.expiresAt > Date.now());
    const refreshed = await refreshCredentials(
      metadata,
      DEFAULT_CLIENT_ID,
      credentials.refreshToken!,
      deps,
    );
    assert.notEqual(refreshed.accessToken, credentials.accessToken);
    assert.notEqual(refreshed.refreshToken, credentials.refreshToken);
    const call = (token: string) =>
      h.fetch("/api/tools/list_repositories", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    assert.equal((await call(refreshed.accessToken)).status, 200);
    assert.equal(
      await revokeToken(
        metadata,
        DEFAULT_CLIENT_ID,
        refreshed.refreshToken!,
        "refresh_token",
        deps,
      ),
      true,
    );
    assert.equal((await call(refreshed.accessToken)).status, 401);
  } finally {
    await h.dispose();
  }
});
