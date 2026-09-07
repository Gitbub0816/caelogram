// OAuth 2.0 device authorization grant (RFC 8628) client for the Caelogram CLI.
// The contract this expects from an authorization server is written down in
// docs/cli-auth-contract.md. Everything here takes its I/O through `Deps` so the
// flow is testable without a live server.
import { assert, Fault } from "./security.js";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const DEFAULT_CLIENT_ID = "caelogram-cli";
export const DEFAULT_SCOPE = "read write";

export type Deps = {
  fetch: typeof globalThis.fetch;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  log: (message: string) => void;
};

export const liveDeps = (): Deps => ({
  fetch: (...args) => globalThis.fetch(...args),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (message) => console.log(message),
});

export type ServerMetadata = {
  issuer: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
};

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};

export type Credentials = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds; absent when the server did not send `expires_in`. */
  expiresAt?: number;
  scope?: string;
};

const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const MAX_POLL_SECONDS = 1800;
/** Refresh this many milliseconds before the access token actually expires. */
const REFRESH_SKEW = 60_000;

export function requireHttps(url: string) {
  const u = new URL(url);
  assert(
    u.protocol === "https:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname),
    "Authorization endpoints must use HTTPS",
  );
  return u;
}

async function readJson(response: Response) {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function failure(body: Record<string, unknown>, fallback: string) {
  const code = typeof body.error === "string" ? body.error : undefined;
  const description =
    typeof body.error_description === "string" ? body.error_description : "";
  return new Fault(
    400,
    code ? `${code}${description && `: ${description}`}` : fallback,
  );
}

/** RFC 8414 section 3.1: `.well-known/<name>` goes between host and issuer path. */
export function metadataUrl(issuer: string, name: string) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, "");
  return new URL(`${u.origin}/.well-known/${name}${path}`).toString();
}

/**
 * Discovery, per the MCP authorization spec: ask the resource server which
 * authorization servers it trusts, then read that server's RFC 8414 metadata.
 * A service that serves no protected-resource document is treated as its own
 * authorization server.
 */
export async function discover(
  origin: string,
  deps: Deps,
): Promise<ServerMetadata> {
  requireHttps(origin);
  let issuer = origin.replace(/\/$/, "");
  const resource = await deps.fetch(
    metadataUrl(issuer, "oauth-protected-resource"),
    { headers: { Accept: "application/json" } },
  );
  if (resource.ok) {
    const body = await readJson(resource);
    const servers = body.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === "string")
      issuer = servers[0].replace(/\/$/, "");
  }
  requireHttps(issuer);
  const response = await deps.fetch(
    metadataUrl(issuer, "oauth-authorization-server"),
    { headers: { Accept: "application/json" } },
  );
  assert(
    response.ok,
    `No OAuth metadata at ${issuer} (HTTP ${response.status}). The service must serve /.well-known/oauth-authorization-server.`,
  );
  const body = await readJson(response);
  const device = body.device_authorization_endpoint;
  const token = body.token_endpoint;
  assert(
    typeof device === "string" && typeof token === "string",
    "Authorization server metadata lacks device_authorization_endpoint or token_endpoint",
  );
  const grants = body.grant_types_supported;
  assert(
    !Array.isArray(grants) || grants.includes(DEVICE_GRANT),
    "Authorization server does not advertise the device authorization grant",
  );
  const revocation = body.revocation_endpoint;
  return {
    issuer: typeof body.issuer === "string" ? body.issuer : issuer,
    deviceAuthorizationEndpoint: requireHttps(device).toString(),
    tokenEndpoint: requireHttps(token).toString(),
    revocationEndpoint:
      typeof revocation === "string"
        ? requireHttps(revocation).toString()
        : undefined,
  };
}

export async function requestDeviceCode(
  metadata: ServerMetadata,
  clientId: string,
  scope: string,
  deps: Deps,
): Promise<DeviceAuthorization> {
  const response = await deps.fetch(metadata.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
  });
  const body = await readJson(response);
  if (!response.ok) throw failure(body, "Device authorization request failed");
  assert(
    typeof body.device_code === "string" &&
      typeof body.user_code === "string" &&
      typeof body.verification_uri === "string",
    "Device authorization response is missing required fields",
  );
  const interval = Number(body.interval);
  const expiresIn = Number(body.expires_in);
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete:
      typeof body.verification_uri_complete === "string"
        ? body.verification_uri_complete
        : undefined,
    expiresIn:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Math.min(expiresIn, MAX_POLL_SECONDS)
        : 900,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

function credentials(body: Record<string, unknown>, deps: Deps): Credentials {
  assert(
    typeof body.access_token === "string",
    "Token response is missing access_token",
  );
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? deps.now() + expiresIn * 1000
        : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}

/** Poll the token endpoint until the user approves, denies, or the code expires. */
export async function pollForToken(
  metadata: ServerMetadata,
  clientId: string,
  device: DeviceAuthorization,
  deps: Deps,
): Promise<Credentials> {
  let interval = device.interval;
  const deadline = deps.now() + device.expiresIn * 1000;
  for (;;) {
    await deps.sleep(interval * 1000);
    const response = await deps.fetch(metadata.tokenEndpoint, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: device.deviceCode,
        client_id: clientId,
      }).toString(),
    });
    const body = await readJson(response);
    if (response.ok) return credentials(body, deps);
    const error = typeof body.error === "string" ? body.error : "invalid_grant";
    if (error === "slow_down") interval += 5;
    else if (error !== "authorization_pending") {
      if (error === "access_denied")
        throw new Fault(403, "Authorization was denied in the browser");
      if (error === "expired_token")
        throw new Fault(
          408,
          "The device code expired; run caelogram login again",
        );
      throw failure(body, "Token request failed");
    }
    if (deps.now() >= deadline)
      throw new Fault(
        408,
        "The device code expired; run caelogram login again",
      );
  }
}

export async function refreshCredentials(
  metadata: ServerMetadata,
  clientId: string,
  refreshToken: string,
  deps: Deps,
): Promise<Credentials> {
  const response = await deps.fetch(metadata.tokenEndpoint, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });
  const body = await readJson(response);
  if (!response.ok)
    throw new Fault(
      401,
      `Could not refresh the access token (${typeof body.error === "string" ? body.error : response.status}); run caelogram login again`,
    );
  const next = credentials(body, deps);
  // RFC 6749 section 6: a refresh token may be rotated, or omitted and reused.
  return { ...next, refreshToken: next.refreshToken ?? refreshToken };
}

/** RFC 7009 revocation. A missing endpoint or failure is not fatal for logout. */
export async function revokeToken(
  metadata: ServerMetadata,
  clientId: string,
  token: string,
  hint: "access_token" | "refresh_token",
  deps: Deps,
): Promise<boolean> {
  if (!metadata.revocationEndpoint) return false;
  try {
    const response = await deps.fetch(metadata.revocationEndpoint, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({
        token,
        token_type_hint: hint,
        client_id: clientId,
      }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const expired = (c: Credentials, deps: Deps) =>
  c.expiresAt !== undefined && deps.now() + REFRESH_SKEW >= c.expiresAt;

/** The whole interactive login: discovery, user prompt, polling. */
export async function deviceLogin(
  origin: string,
  clientId: string,
  scope: string,
  deps: Deps,
): Promise<{ metadata: ServerMetadata; credentials: Credentials }> {
  const metadata = await discover(origin, deps);
  const device = await requestDeviceCode(metadata, clientId, scope, deps);
  deps.log(`\n  Open ${device.verificationUri}`);
  deps.log(`  Enter the code: ${device.userCode}`);
  if (device.verificationUriComplete)
    deps.log(`  Or open directly: ${device.verificationUriComplete}`);
  deps.log("\nWaiting for approval...");
  return {
    metadata,
    credentials: await pollForToken(metadata, clientId, device, deps),
  };
}
