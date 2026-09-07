import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEVICE_GRANT,
  deviceLogin,
  discover,
  expired,
  metadataUrl,
  pollForToken,
  refreshCredentials,
  requestDeviceCode,
  requireHttps,
  revokeToken,
  type Deps,
  type ServerMetadata,
} from "../src/auth.js";

const ORIGIN = "https://caelogram.test";
const AS = {
  issuer: ORIGIN,
  device_authorization_endpoint: `${ORIGIN}/oauth/device_authorization`,
  token_endpoint: `${ORIGIN}/oauth/token`,
  revocation_endpoint: `${ORIGIN}/oauth/revoke`,
  grant_types_supported: [DEVICE_GRANT, "refresh_token"],
};
const metadata: ServerMetadata = {
  issuer: ORIGIN,
  deviceAuthorizationEndpoint: AS.device_authorization_endpoint,
  tokenEndpoint: AS.token_endpoint,
  revocationEndpoint: AS.revocation_endpoint,
};
const device = {
  deviceCode: "device-code",
  userCode: "WDJB-MJHT",
  verificationUri: `${ORIGIN}/device`,
  expiresIn: 60,
  interval: 5,
};

type Reply = { status?: number; body?: unknown };
type Call = { url: string; method: string; form: URLSearchParams };

/** A fake HTTP layer plus a virtual clock; no network and no real waiting. */
function harness(handler: (call: Call) => Reply) {
  const calls: Call[] = [];
  const slept: number[] = [];
  let clock = 1_700_000_000_000;
  const deps: Deps = {
    fetch: async (input: any, init: any = {}) => {
      const call: Call = {
        url: String(input),
        method: init.method ?? "GET",
        form: new URLSearchParams(init.body ?? ""),
      };
      calls.push(call);
      const reply = handler(call);
      const status = reply.status ?? 200;
      return new Response(
        reply.body === undefined ? null : JSON.stringify(reply.body),
        { status, headers: { "Content-Type": "application/json" } },
      );
    },
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    log: () => {},
  };
  return { deps, calls, slept, advance: (ms: number) => (clock += ms) };
}

const discovery = (call: Call) => {
  if (call.url.endsWith("/.well-known/oauth-protected-resource"))
    return { body: { resource: ORIGIN, authorization_servers: [ORIGIN] } };
  if (call.url.endsWith("/.well-known/oauth-authorization-server"))
    return { body: AS };
  return null;
};

test("RFC 8414 metadata URLs insert .well-known before any issuer path", () => {
  assert.equal(
    metadataUrl("https://a.test/tenant/7", "oauth-authorization-server"),
    "https://a.test/.well-known/oauth-authorization-server/tenant/7",
  );
  assert.equal(
    metadataUrl("https://a.test/", "oauth-protected-resource"),
    "https://a.test/.well-known/oauth-protected-resource",
  );
});

test("plaintext remote endpoints are refused; loopback is allowed", () => {
  assert.throws(() => requireHttps("http://caelogram.test"), /HTTPS/);
  assert.doesNotThrow(() => requireHttps("http://localhost:4310"));
  assert.doesNotThrow(() => requireHttps("https://caelogram.test"));
});

test("discovery follows protected-resource metadata to the authorization server", async () => {
  const h = harness(
    (call) => discovery(call) ?? { status: 404, body: { error: "not_found" } },
  );
  const found = await discover(ORIGIN, h.deps);
  assert.deepEqual(found, metadata);
  assert.deepEqual(
    h.calls.map((c) => c.url),
    [
      `${ORIGIN}/.well-known/oauth-protected-resource`,
      `${ORIGIN}/.well-known/oauth-authorization-server`,
    ],
  );
});

test("discovery falls back to the service origin when no resource metadata exists", async () => {
  const h = harness((call) =>
    call.url.endsWith("oauth-authorization-server")
      ? { body: AS }
      : { status: 404, body: {} },
  );
  assert.equal(
    (await discover(ORIGIN, h.deps)).tokenEndpoint,
    AS.token_endpoint,
  );
});

test("discovery fails loudly when the authorization server is absent", async () => {
  const h = harness(() => ({ status: 404, body: {} }));
  await assert.rejects(discover(ORIGIN, h.deps), /No OAuth metadata/);
});

test("discovery rejects a server that does not support the device grant", async () => {
  const h = harness((call) =>
    call.url.endsWith("oauth-authorization-server")
      ? { body: { ...AS, grant_types_supported: ["authorization_code"] } }
      : { status: 404, body: {} },
  );
  await assert.rejects(discover(ORIGIN, h.deps), /device authorization grant/);
});

test("device authorization request sends client_id and scope and reads the code", async () => {
  const h = harness(() => ({
    body: {
      device_code: "device-code",
      user_code: "WDJB-MJHT",
      verification_uri: `${ORIGIN}/device`,
      verification_uri_complete: `${ORIGIN}/device?user_code=WDJB-MJHT`,
      expires_in: 600,
      interval: 7,
    },
  }));
  const d = await requestDeviceCode(
    metadata,
    "caelogram-cli",
    "read write",
    h.deps,
  );
  assert.equal(d.interval, 7);
  assert.equal(d.expiresIn, 600);
  assert.equal(d.userCode, "WDJB-MJHT");
  assert.equal(h.calls[0].method, "POST");
  assert.equal(h.calls[0].form.get("client_id"), "caelogram-cli");
  assert.equal(h.calls[0].form.get("scope"), "read write");
});

test("a missing interval defaults to five seconds per RFC 8628", async () => {
  const h = harness(() => ({
    body: {
      device_code: "d",
      user_code: "U",
      verification_uri: `${ORIGIN}/device`,
    },
  }));
  const d = await requestDeviceCode(metadata, "caelogram-cli", "read", h.deps);
  assert.equal(d.interval, 5);
  assert.equal(d.expiresIn, 900);
});

test("happy path: the whole login yields tokens with an absolute expiry", async () => {
  const h = harness((call) => {
    const d = discovery(call);
    if (d) return d;
    if (call.url === AS.device_authorization_endpoint)
      return {
        body: {
          device_code: "device-code",
          user_code: "WDJB-MJHT",
          verification_uri: `${ORIGIN}/device`,
          expires_in: 600,
          interval: 5,
        },
      };
    return {
      body: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read write",
      },
    };
  });
  const start = h.deps.now();
  const { credentials } = await deviceLogin(
    ORIGIN,
    "caelogram-cli",
    "read write",
    h.deps,
  );
  assert.equal(credentials.accessToken, "access-1");
  assert.equal(credentials.refreshToken, "refresh-1");
  assert.equal(credentials.scope, "read write");
  // Polling slept once (5s) before the token call, so expiry is 5s later.
  assert.equal(credentials.expiresAt, start + 5000 + 3600_000);
  const token = h.calls.at(-1)!;
  assert.equal(token.form.get("grant_type"), DEVICE_GRANT);
  assert.equal(token.form.get("device_code"), "device-code");
  assert.equal(token.form.get("client_id"), "caelogram-cli");
});

test("authorization_pending keeps polling at the advertised interval", async () => {
  let attempts = 0;
  const h = harness(() =>
    ++attempts < 3
      ? { status: 400, body: { error: "authorization_pending" } }
      : { body: { access_token: "access-2", expires_in: 60 } },
  );
  const c = await pollForToken(metadata, "caelogram-cli", device, h.deps);
  assert.equal(c.accessToken, "access-2");
  assert.deepEqual(h.slept, [5000, 5000, 5000]);
});

test("slow_down adds five seconds to the polling interval each time", async () => {
  let attempts = 0;
  const h = harness(() => {
    attempts++;
    if (attempts === 1) return { status: 400, body: { error: "slow_down" } };
    if (attempts === 2)
      return { status: 400, body: { error: "authorization_pending" } };
    if (attempts === 3) return { status: 400, body: { error: "slow_down" } };
    return { body: { access_token: "access-3" } };
  });
  const c = await pollForToken(
    metadata,
    "caelogram-cli",
    { ...device, expiresIn: 600 },
    h.deps,
  );
  assert.equal(c.accessToken, "access-3");
  assert.equal(c.expiresAt, undefined);
  assert.deepEqual(h.slept, [5000, 10000, 10000, 15000]);
});

test("access_denied stops polling immediately", async () => {
  const h = harness(() => ({ status: 400, body: { error: "access_denied" } }));
  await assert.rejects(
    pollForToken(metadata, "caelogram-cli", device, h.deps),
    /denied/,
  );
  assert.equal(h.calls.length, 1);
});

test("expired_token stops polling immediately", async () => {
  const h = harness(() => ({ status: 400, body: { error: "expired_token" } }));
  await assert.rejects(
    pollForToken(metadata, "caelogram-cli", device, h.deps),
    /expired/,
  );
});

test("polling gives up once the device code lifetime elapses", async () => {
  const h = harness(() => ({
    status: 400,
    body: { error: "authorization_pending" },
  }));
  await assert.rejects(
    pollForToken(
      metadata,
      "caelogram-cli",
      { ...device, expiresIn: 12 },
      h.deps,
    ),
    /expired/,
  );
  // 5s + 5s + 5s crosses the 12s lifetime: three attempts, then give up.
  assert.equal(h.calls.length, 3);
});

test("an unexpected token error is surfaced with its description", async () => {
  const h = harness(() => ({
    status: 400,
    body: { error: "invalid_client", error_description: "unknown client" },
  }));
  await assert.rejects(
    pollForToken(metadata, "caelogram-cli", device, h.deps),
    /invalid_client: unknown client/,
  );
});

test("refresh exchanges the refresh token and keeps a non-rotated one", async () => {
  const rotating = harness(() => ({
    body: {
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
    },
  }));
  const rotated = await refreshCredentials(
    metadata,
    "caelogram-cli",
    "refresh-old",
    rotating.deps,
  );
  assert.equal(rotated.accessToken, "access-new");
  assert.equal(rotated.refreshToken, "refresh-new");
  assert.equal(rotating.calls[0].form.get("grant_type"), "refresh_token");
  assert.equal(rotating.calls[0].form.get("refresh_token"), "refresh-old");

  const stable = harness(() => ({
    body: { access_token: "access-new", expires_in: 3600 },
  }));
  const kept = await refreshCredentials(
    metadata,
    "caelogram-cli",
    "refresh-old",
    stable.deps,
  );
  assert.equal(kept.refreshToken, "refresh-old");
});

test("a rejected refresh asks the user to log in again", async () => {
  const h = harness(() => ({ status: 400, body: { error: "invalid_grant" } }));
  await assert.rejects(
    refreshCredentials(metadata, "caelogram-cli", "refresh-old", h.deps),
    /caelogram login again/,
  );
});

test("expiry is judged with a minute of clock skew", () => {
  const h = harness(() => ({ body: {} }));
  const now = h.deps.now();
  assert.equal(
    expired({ accessToken: "a", expiresAt: now + 300_000 }, h.deps),
    false,
  );
  assert.equal(
    expired({ accessToken: "a", expiresAt: now + 30_000 }, h.deps),
    true,
  );
  assert.equal(expired({ accessToken: "a" }, h.deps), false);
});

test("logout revokes both tokens and tolerates servers without revocation", async () => {
  const h = harness(() => ({ status: 200 }));
  assert.equal(
    await revokeToken(
      metadata,
      "caelogram-cli",
      "refresh-1",
      "refresh_token",
      h.deps,
    ),
    true,
  );
  assert.equal(h.calls[0].url, AS.revocation_endpoint);
  assert.equal(h.calls[0].form.get("token_type_hint"), "refresh_token");
  assert.equal(
    await revokeToken(
      { ...metadata, revocationEndpoint: undefined },
      "caelogram-cli",
      "refresh-1",
      "refresh_token",
      h.deps,
    ),
    false,
  );
  assert.equal(h.calls.length, 1);
});
