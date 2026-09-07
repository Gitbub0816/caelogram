# CLI authorization contract

`caelogram login` implements the OAuth 2.0 device authorization grant
([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)) against whatever
authorization server the service origin points at. The client is `src/auth.ts`;
the server is `cloudflare/oauth.ts`, and **it satisfies this contract as
written — nothing below was renegotiated**. Anything not listed here is not
relied upon by the CLI.

Client behaviour is covered by `tests/auth.test.ts` against a stub HTTP layer.
The two halves are covered together in `tests/oauth.test.ts`, where the real
client functions run discovery, device login, refresh and logout against the
real worker over miniflare.

The endpoints the deployed server publishes are `POST /device_authorization`,
`POST /token` and `POST /revoke`, with the verification page at `/device`; the
CLI reads them from metadata and never hardcodes them.

## 0. Client identity

The CLI is a **public client** with no client secret. It sends
`client_id=caelogram-cli` unless overridden by `--client-id` or
`CAELOGRAM_CLIENT_ID`. The server must pre-register that identifier and accept
it without client authentication on the device authorization, token, and
revocation endpoints. Dynamic client registration (RFC 7591) is **not**
implemented by the CLI.

There is no redirect URI and no PKCE: the device grant has no browser redirect
back to the CLI. The device code is the only secret the CLI holds during login.

## 1. Discovery

Given a service origin (`--url`, `CAELOGRAM_URL`, or the stored value), the CLI:

1. `GET {origin}/.well-known/oauth-protected-resource` — the OAuth 2.0
   protected-resource metadata the MCP authorization spec requires
   ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)). If it returns 200 with
   `authorization_servers: ["https://issuer.example"]`, the first entry becomes
   the issuer. Any other response is ignored and the service origin itself is
   used as the issuer. Caelogram already serves this document.
2. `GET {issuer}/.well-known/oauth-authorization-server` — authorization server
   metadata ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)). A non-200
   response aborts login with a message naming the missing document. When the
   issuer has a path, `.well-known` is inserted between host and path per
   RFC 8414 section 3.1 (`https://x.example/tenant` →
   `https://x.example/.well-known/oauth-authorization-server/tenant`).

Required fields in the authorization server metadata:

| Field                           | Requirement                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| `issuer`                        | Optional; recorded for display only                                         |
| `device_authorization_endpoint` | **Required**, absolute HTTPS URL                                            |
| `token_endpoint`                | **Required**, absolute HTTPS URL                                            |
| `revocation_endpoint`           | Optional; without it `caelogram logout` only deletes local state            |
| `grant_types_supported`         | If present, **must** contain `urn:ietf:params:oauth:grant-type:device_code` |

All endpoint URLs must be `https:`, except `localhost`, `127.0.0.1` and `[::1]`
for local development. The CLI refuses plaintext remote endpoints.

## 2. Device authorization request

```http
POST {device_authorization_endpoint}
Content-Type: application/x-www-form-urlencoded

client_id=caelogram-cli&scope=read+write
```

Scope defaults to `read write` and is settable with `--scope`. Success is any
2xx JSON body:

| Field                       | Requirement                                               |
| --------------------------- | --------------------------------------------------------- |
| `device_code`               | **Required** string, opaque, sent back on every poll      |
| `user_code`                 | **Required** string, printed for the human to type        |
| `verification_uri`          | **Required** absolute URL, printed for the human to open  |
| `verification_uri_complete` | Optional; printed as a one-click alternative when present |
| `expires_in`                | Optional seconds; default 900, clamped to 1800            |
| `interval`                  | Optional seconds between polls; default 5                 |

A non-2xx response ends login and its `error` / `error_description` are shown
verbatim.

## 3. Token polling

The CLI waits `interval` seconds **before** its first poll, then repeats:

```http
POST {token_endpoint}
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code
&device_code=...&client_id=caelogram-cli
```

Responses the server must use ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) section 3.5,
[RFC 6749](https://www.rfc-editor.org/rfc/rfc6749) section 5.2 — all errors as
HTTP 400 with `{"error": "..."}`):

| `error`                 | CLI behaviour                                            |
| ----------------------- | -------------------------------------------------------- |
| `authorization_pending` | Wait `interval` and poll again                           |
| `slow_down`             | Add 5 seconds to `interval` permanently, then poll again |
| `access_denied`         | Stop; "Authorization was denied in the browser"          |
| `expired_token`         | Stop; ask the user to run `caelogram login` again        |
| anything else           | Stop; show `error: error_description`                    |

The CLI independently stops once `expires_in` has elapsed, so a server that
never answers cannot hang the CLI forever. It never polls faster than the
interval it was given, and it never retries after a terminal error.

Success is a 2xx JSON body:

| Field           | Requirement                                                            |
| --------------- | ---------------------------------------------------------------------- |
| `access_token`  | **Required** string; sent as `Authorization: Bearer` to `/api/tools/*` |
| `token_type`    | Should be `Bearer`; the CLI assumes bearer                             |
| `expires_in`    | Optional seconds; stored as an absolute expiry                         |
| `refresh_token` | Optional but **strongly expected** — without it the user re-logs in    |
| `scope`         | Optional; recorded and shown by `caelogram doctor`                     |

The access token must be a Caelogram access token accepted by the same service
origin. It is never a GitHub token.

## 4. Refresh

Before any API call, if `expires_in` was supplied and the token is within 60
seconds of expiry, the CLI refreshes without user interaction:

```http
POST {token_endpoint}
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=...&client_id=caelogram-cli
```

Same success body as above. If the response omits `refresh_token`, the CLI keeps
the existing one; if it returns a new one, the old one is discarded (rotation is
supported and recommended). Any non-2xx response aborts the command and tells
the user to log in again — the CLI does not retry refreshes.

## 5. Revocation

`caelogram logout` posts to `revocation_endpoint`
([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)) once per stored token:

```http
POST {revocation_endpoint}
Content-Type: application/x-www-form-urlencoded

token=...&token_type_hint=refresh_token&client_id=caelogram-cli
```

Revoking a refresh token should revoke the access tokens issued from it. The CLI
treats any non-2xx response, network failure, or missing endpoint as
"not revoked", deletes the local credential file regardless, and says so.

## 6. Local storage

Credentials go to `~/.config/caelogram/config.json`, directory mode `0700`, file
mode `0600`:

```json
{
  "url": "https://your-caelogram-service.example",
  "clientId": "caelogram-cli",
  "metadata": {
    "issuer": "https://issuer.example",
    "deviceAuthorizationEndpoint": "https://issuer.example/oauth/device_authorization",
    "tokenEndpoint": "https://issuer.example/oauth/token",
    "revocationEndpoint": "https://issuer.example/oauth/revoke"
  },
  "credentials": {
    "accessToken": "…",
    "refreshToken": "…",
    "expiresAt": 1700000000000,
    "scope": "read write"
  }
}
```

`expiresAt` is epoch milliseconds. Discovered metadata is cached so refresh does
not re-discover. A `token` string at the top level is the pre-OAuth format and
is still read, so existing installs keep working.

## 7. Non-interactive fallback

`CAELOGRAM_TOKEN` overrides everything, is never written to disk, and is the
supported path for CI and containers. It exists so automation does not need a
browser — not so humans paste tokens.

## 8. How the server holds up its end

All of it is implemented in `cloudflare/oauth.ts`:

- `caelogram-cli` is pre-registered as a public client by migration 0007, and
  both `.well-known` documents are served by the Worker, which is now its own
  authorization server.
- `/device` is the verification page: it identifies the human through their
  Clerk browser session, shows the client name and the requested scopes, and
  takes an approve/deny decision behind a CSRF token.
- Issued tokens carry an identity and the consented scope only. Repository
  access is resolved from GitHub on every request by `resolveAccess()`, so a
  token can never reach more than its owner can, and honours `scope`.
- The device endpoint is rate limited per address, device codes expire after 15
  minutes, polling faster than `interval` is answered with `slow_down`, and a
  device code is redeemable exactly once.
- Refresh tokens rotate on every use; presenting a rotated one revokes the whole
  grant. `/revoke` on a refresh token kills every access token issued from it.

One thing worth knowing that the contract does not specify: an access token
lives 15 minutes, so the CLI's own refresh-before-expiry path is exercised in
normal use rather than rarely.
