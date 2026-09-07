# Account and GitHub setup

The frontend is **React + Vite**, using `@clerk/react`. It is not Next.js. The API runs on Cloudflare Workers with D1 and encrypted private R2 storage.

## 1. Your Clerk application

Create the application in your own Clerk dashboard. Enable Google, GitHub, and email verification code sign-in/sign-up. For passwordless email, enable email codes and disable the password requirement. Complete the production OAuth provider credentials and domain setup in Clerk before launch; development provider credentials are not a production setup.

Use these application paths:

| Purpose                     | Path               |
| --------------------------- | ------------------ |
| Embedded sign-in            | `/sign-in`         |
| Embedded sign-up            | `/sign-up`         |
| Embedded account management | `/account`         |
| After sign-in or signup     | `/?connect=github` |
| After sign-out              | `/`                |

`SignIn`, `SignUp`, and `UserProfile` are rendered inside Caelogram, styled in charcoal, warm gray, and gold. They are not Clerk-hosted account pages. Provider availability and email verification behavior come from your Clerk configuration. OAuth necessarily redirects through the chosen identity provider before returning to the embedded app.

Set Worker bindings `CLERK_PUBLISHABLE_KEY` (the `pk_…` value) and `CLERK_ISSUER` (the exact HTTPS issuer/FAPI origin of your instance, no trailing slash). Set `PUBLIC_ORIGIN` to the exact HTTPS Caelogram origin. Do not supply a Clerk secret key to the browser. This implementation validates session JWTs with Clerk's published keys and does not need the Clerk backend secret key.

Browser requests obtain a fresh token through Clerk, verify signature/issuer/expiry/session ID and authorized party, and derive the workspace from the verified user ID. Caller-provided tenant, repository, and role claims are ignored. Each account owns a personal workspace; shared organization membership is not implemented. Signing out clears the rendered workspace. Agent credentials are independent and must be revoked in Access & integrations when no longer needed.

## 2. Public GitHub App

GitHub sign-in in Clerk establishes identity only. It does **not** grant Caelogram permission to read repositories. Create a public-installable GitHub App for the repository layer, not a broad-scoped OAuth App.

Configure:

- Installation availability: **Any account**; users choose selected repositories.
- Homepage: your Caelogram HTTPS origin.
- User authorization callback: `https://YOUR_ORIGIN/auth/github/callback`.
- Setup URL: `https://YOUR_ORIGIN/?connect=github`.
- Expiring user access tokens: enabled. Do not disable expiration.
- Webhook: `https://YOUR_ORIGIN/webhooks/github`, push event, a random shared webhook secret.
- Repository permissions: Metadata read, Contents read/write, Pull requests read/write. No administration, secrets, or workflow write permission.

Configure Worker secrets `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY` (full PEM), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_SLUG`, and `GITHUB_WEBHOOK_SECRET`. These are placeholders in the deployment examples, not credentials checked into the repository. Keep all actual secrets in Cloudflare, never in git or chat.

After login, a user authorizes their GitHub account, installs/selects repositories on GitHub, returns and refreshes the list, then chooses a repository and branch to map. No administrator assigns tenant installation IDs. Listing is restricted to repositories that the user can push to and the App can access; archived, disabled, and suspended installations are excluded. Read-only repository mapping is not currently offered because this workflow includes changeset publication.

OAuth state is random, hashed in D1, expires after ten minutes, bound to an HttpOnly Secure SameSite=Lax browser cookie, and consumed atomically. Access/refresh credentials are encrypted in R2. Refresh is serialized per workspace; a failed rotation or expired refresh token requires reauthorization. GitHub credentials are never returned to agents or browser API consumers.

## 3. Agents and MCP clients: Caelogram is an OAuth 2.1 authorization server

The Worker issues its own tokens. An MCP client discovers the service, registers
itself, sends the person through a consent screen in their browser, and receives
a token; nobody pastes a credential. `cloudflare/oauth.ts` holds the whole
server, `cloudflare/migrations/0007_oauth_server.sql` its schema.

| Endpoint                                  | Method    | Specification                          |
| ----------------------------------------- | --------- | -------------------------------------- |
| `/.well-known/oauth-protected-resource`   | GET       | RFC 9728 protected resource metadata   |
| `/.well-known/oauth-authorization-server` | GET       | RFC 8414 authorization server metadata |
| `/register`                               | POST      | RFC 7591 dynamic client registration   |
| `/authorize`                              | GET, POST | OAuth 2.1 code grant, PKCE RFC 7636    |
| `/token`                                  | POST      | RFC 6749 §4.1.3 and §6, RFC 8628 §3.4  |
| `/device_authorization`                   | POST      | RFC 8628 §3.1                          |
| `/device`                                 | GET, POST | RFC 8628 §3.3 verification page        |
| `/revoke`                                 | POST      | RFC 7009                               |

Both metadata documents also answer the path-suffixed form the MCP
authorization specification allows (`…/oauth-protected-resource/mcp`). The
metadata, registration, token and revocation endpoints answer cross-origin
(`Access-Control-Allow-Origin: *`) because they carry no cookies; `/authorize`
and `/device` are cookie-authenticated browser pages and reject a cross-origin
POST.

**Scopes** are the product's existing four: `read`, `write`, `publish`, `admin`.
A client may never receive more than it registered for, and a refresh may never
widen what was consented to.

**Clients.** Registration is open: an MCP client must be able to configure itself
without a human provisioning anything, and a registration on its own grants
nothing — every token still needs a signed-in person to approve a consent
screen. Public clients (`token_endpoint_auth_method: "none"`, the default) get no
secret and are held together by PKCE and exact redirect-URI matching; a client
that asks for `client_secret_basic` or `client_secret_post` receives one secret,
returned once and stored only as a digest. Redirect URIs must be absolute, free
of wildcards and fragments, and either `https:`, `http:` on a loopback host, or a
private-use scheme such as `com.example.app:`; they are matched literally at
`/authorize`, never by prefix. `caelogram-cli` is pre-registered as a public
client for the device grant.

**Tokens.** Access tokens live 15 minutes, refresh tokens 30 days and rotate on
every use; presenting a rotated refresh token is treated as a leak and revokes
the whole grant, as does a failed PKCE verification. Every credential is a
`<prefix>_<random>.<HMAC>` string — the HMAC is checked before any database
lookup — and only its SHA-256 digest is stored. Authorization codes are single
use, expire in two minutes, and are bound to the client, the redirect URI and the
PKCE challenge. Revoking a refresh token revokes every access token issued from
the same authorization.

**What a token means.** It carries an identity and a consented scope, and
nothing else: no tenant, no repository list, no role. `resolveAccess()` asks
GitHub which repositories the person may push to on every request, so a token
never widens access, and a grant revoked on GitHub stops working here within the
access cache TTL without anything being revoked in Caelogram.

Sign-in for `/authorize` and `/device` reuses the Clerk browser session
(`__session` cookie on your origin) — there is no second login. Both pages are
CSRF-protected with a one-time value held in an `HttpOnly; SameSite=Lax` cookie
and as a digest in D1, and both refuse to be framed.

Production configuration:

- Apply migration `0007_oauth_server.sql` (`npm run cloud:migrate`). Without it
  every OAuth endpoint fails; `/api/diagnostics` lists the missing tables.
- `PUBLIC_ORIGIN` must be the exact HTTPS origin. It is the issuer, and every
  advertised endpoint is derived from it.
- Leave `ISSUER` **unset**. It now means "front this resource with an external
  authorization server"; if it is set, discovery points clients away from
  Caelogram's own endpoints.
- `OAUTH_SIGNING_KEY` is optional; it defaults to `DATA_KEY`. Set it to an
  independent 32-byte secret if you would rather rotate token signing without
  touching storage encryption. Changing either invalidates outstanding tokens.
- Clerk must be configured (`CLERK_PUBLISHABLE_KEY` or `CLERK_ISSUER`), because
  the consent screens identify the person from the Clerk session.
- The existing cron expires codes, device codes, tokens and rate counters.

### Legacy agent tokens

Pasted `caeg_` tokens still work and remain the supported path for CI.
Map your repository in the browser first. In **Access & integrations → Agent access**, choose repositories and create a token. Tokens expire in 1, 4, or 8 hours. Context reads and changesets are included; draft PR publication requires a separate checkbox. No agent token can administer accounts, grant access, connect installations, or issue another token. Only token hashes and grant metadata are stored in D1. Copy the credential once into your client’s secret/environment configuration, not its prompt.

```sh
caelogram login --url https://YOUR_ORIGIN
caelogram status
caelogram init --client claude
```

`caelogram login` uses the device grant above and needs no pasted credential; `CAELOGRAM_TOKEN` overrides it for CI and containers. MCP endpoint: `https://YOUR_ORIGIN/mcp`, with `Authorization: Bearer <token>` — either an OAuth access token from the flows above or an agent token. Revoke tokens in the console; disconnecting GitHub revokes every agent token in that workspace. Revoked or newly inaccessible GitHub repositories are also removed from each request's effective grants.

## 4. Deploy and verify

From the checkout containing `package.json` and `wrangler.jsonc`:

```sh
npm ci
npm run cloud:migrate
npm run cloud:deploy
```

Apply every D1 migration in `cloudflare/migrations` before deploying this release, `0007_oauth_server.sql` included. Your `caelogram` database and `caelogram-private` bucket already exist if provisioned earlier; do not recreate them. Configure the existing D1 ID in the DB binding. The bucket binding must remain `SOURCE`.

Live acceptance checklist: create two separate Clerk accounts; complete Google/GitHub/email-code sign-in; verify logout and account routes; install the App on a small sandbox repository; map an existing branch; resolve a task; obtain context through a restricted agent token; submit and validate; explicitly publish a draft PR; verify webhook freshness; verify account B cannot fetch account A's repository/task; revoke access and verify denial. CI and human review must gate merges because the Worker never runs repository tests.

The automated suite covers JWT trust boundaries, OAuth replay/browser binding, encrypted token rotation, grant filtering, scoped tokens, D1/R2 isolation, and the changeset workflow using a GitHub test provider. It does not replace a live configured Clerk/GitHub acceptance run.

## References

[Clerk React quickstart](https://clerk.com/docs/react/getting-started/quickstart), [Clerk CSP guidance](https://clerk.com/docs/guides/secure/best-practices/csp-headers), [GitHub App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [GitHub token rotation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
