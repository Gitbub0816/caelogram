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

## 3. Agents

Map your repository in the browser first. In **Access & integrations → Agent access**, choose repositories and create a token. Tokens expire in 1, 4, or 8 hours. Context reads and changesets are included; draft PR publication requires a separate checkbox. No agent token can administer accounts, grant access, connect installations, or issue another token. Only token hashes and grant metadata are stored in D1. Copy the credential once into your client’s secret/environment configuration, not its prompt.

```sh
caelogram login --url https://YOUR_ORIGIN
caelogram status
caelogram init --client claude
```

Set `CAELOGRAM_TOKEN` securely before login. MCP endpoint: `https://YOUR_ORIGIN/mcp`, with `Authorization: Bearer <Caelogram agent token>`. Automatic OAuth discovery/client registration and device login are not provided by this token flow. Revoke tokens in the console; disconnecting GitHub revokes every agent token in that workspace. Revoked or newly inaccessible GitHub repositories are also removed from each request's effective grants.

## 4. Deploy and verify

From the checkout containing `package.json` and `wrangler.jsonc`:

```sh
npm ci
npm run cloud:migrate
npm run cloud:deploy
```

Apply all three D1 migrations before deploying this release. Your `caelogram` database and `caelogram-private` bucket already exist if provisioned earlier; do not recreate them. Configure the existing D1 ID in the DB binding. The bucket binding must remain `SOURCE`.

Live acceptance checklist: create two separate Clerk accounts; complete Google/GitHub/email-code sign-in; verify logout and account routes; install the App on a small sandbox repository; map an existing branch; resolve a task; obtain context through a restricted agent token; submit and validate; explicitly publish a draft PR; verify webhook freshness; verify account B cannot fetch account A's repository/task; revoke access and verify denial. CI and human review must gate merges because the Worker never runs repository tests.

The automated suite covers JWT trust boundaries, OAuth replay/browser binding, encrypted token rotation, grant filtering, scoped tokens, D1/R2 isolation, and the changeset workflow using a GitHub test provider. It does not replace a live configured Clerk/GitHub acceptance run.

## References

[Clerk React quickstart](https://clerk.com/docs/react/getting-started/quickstart), [Clerk CSP guidance](https://clerk.com/docs/guides/secure/best-practices/csp-headers), [GitHub App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [GitHub token rotation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
