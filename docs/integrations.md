# Integration research

Verified against official documentation on 2026-09-06. Implemented transport uses `@modelcontextprotocol/sdk` 1.30.x. Capability discovery and version negotiation are preferred to assuming all clients support the same extensions.

| Surface     | Verified capability                                                                                   | Caelogram implementation / boundary                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub      | GitHub App installation tokens; Git objects and refs; draft pull requests                             | Server-side App adapter, per-repository token requests, explicit branches, no credentials in clients                                                                                             |
| MCP         | Streamable HTTP and separate OAuth resource-server authorization                                      | Official SDK transport; protected-resource metadata; issuer/JWKS/audience-checked JWTs; external issuer provisioning required                                                                    |
| Claude Code | Remote HTTP MCP, local stdio, plugins, skills, hooks                                                  | CLI configuration generator; portable skill; plugin manifest. No arbitrary terminal webview is assumed                                                                                           |
| Codex       | MCP configuration including remote URL and token environment settings                                 | TOML generator and portable skill. No assumed custom panel in the Codex terminal or app                                                                                                          |
| Cursor      | MCP integration, plugins, install/deep-link surfaces                                                  | MCP configuration generator and VS Code-compatible extension source; installation in actual Cursor remains to be verified                                                                        |
| VS Code     | Native tree views and WebviewPanel extension API                                                      | Repository tree plus script-free task/changeset inspector using SecretStorage and escaped text                                                                                                   |
| ChatGPT     | Current developer entry point redirects Apps SDK to Plugins; UI integration has its own host contract | Remote MCP core is independent. A ChatGPT-native UI bundle is deferred pending target-host extension verification and OAuth onboarding; no claim that a generic MCP result embeds arbitrary HTML |

## Sources

- [GitHub installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation): installation credentials are server-side and temporary. Scope repository access to the installation and token request.
- [Git references REST API](https://docs.github.com/en/rest/git/refs): create dedicated refs; do not force-update user branches.
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization): resource-server metadata, OAuth discovery, audience binding, and separation from the authorization server. The unversioned “latest” authorization URL did not resolve in this research session; this document deliberately names the verified revision rather than asserting it is the newest.
- [Claude Code MCP](https://code.claude.com/docs/en/mcp): remote HTTP configuration and authentication.
- [Claude Code plugins](https://code.claude.com/docs/en/plugins): plugin packaging and supported customization surfaces.
- [Codex MCP](https://developers.openai.com/codex/mcp/), currently redirecting to [ChatGPT Learn MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): client configuration reference.
- [OpenAI Plugins](https://developers.openai.com/plugins): current landing page reached from the Apps SDK entry point; the developer surface must be verified per target host before embedding UI.
- [Cursor MCP](https://cursor.com/docs/mcp) and [Cursor plugins](https://cursor.com/docs/plugins): provider-independent tool connectivity and plugin surfaces.
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview): native panel with explicit capabilities and content-security policy.

## Installation

Use `caelogram init --client <claude|codex|cursor>` to print configuration. Review the output and merge it into your client configuration. The client needs a Caelogram token in its environment (or an external issuer's supported OAuth flow); it must never use a GitHub App installation token.

Copy `integrations/skills/caelogram` to your client's supported skill directory. For Claude plugin packaging, place that skill under `integrations/claude/skills/caelogram`, then use the client's local plugin loading workflow. The shipped manifest intentionally contains no fabricated cloud URL and does not override users' agent settings or approval rules.

For the native IDE inspector, package `integrations/vscode` with the VS Code extension tooling or load the folder in an Extension Development Host. Run “Caelogram: Connect session”, then use the Caelogram Explorer section. The token is stored in the editor's SecretStorage and keyed by service origin. Repository text is HTML-escaped, scripts are disabled, and no credentials appear in deep links. The command implementation passes syntax checks; an installed VS Code/Cursor host smoke test remains a release gate.

The web console supports direct repository IDs through `?repo=<id>` after authentication. A deep link never grants access by itself. Embedded panels can show status, but publication remains an explicit, separately scoped operation.
