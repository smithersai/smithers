# Bring your own agent (MCP)

A person connects Claude Code, Codex, Cursor or another Streamable HTTP MCP client to a repository at
`https://smithers.sh/evmts/voltaire/mcp`. They sign in with GitHub and approve the connection in Smithers. The client
acts for that person within the token's scopes and the person's current role on the repository. Its writes are
attributed as `<login> (agent)`. See [roles per repository](../decisions/0079-roles-per-repository.md) and
[person-only acts](../decisions/0017-everything-is-a-plugin.md).

## Routes

The [site Worker](../../worker/index.ts) sends the two discovery paths to ChatApi unchanged and rewrites
`/<owner>/<repo>/mcp` to `/api/repos/<owner>/<repo>/mcp`, keeping the method, query, headers and body.
[The shared contract](../../src/features/mcp/contract.ts) names the routes and protocol versions.

| Route | Answers |
|---|---|
| `POST /<owner>/<repo>/mcp` | Streamable HTTP MCP with the repository in the path as its default. |
| `POST /api/mcp` | Streamable HTTP MCP across repositories. Each call is checked against the token and the target repository. |
| `GET /.well-known/oauth-protected-resource` | Protected resource metadata (RFC 9728). |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414). |
| `POST /api/mcp/oauth/register` | Dynamic Client Registration (DCR, RFC 7591). |
| `/api/mcp/oauth/authorize` | Authorization request details and the person's consent submission. |
| `GET /app/mcp/authorize` | The app document for the browser's consent screen. |
| `POST /api/mcp/oauth/token` | Exchange a single-use authorization code for an access token. |
| `GET /api/me/mcp-tokens`, `DELETE /api/me/mcp-tokens/<id>` | List and revoke the signed-in person's own connections. Both are person-only. |

## Authorization

OAuth 2.1 uses the authorization code grant with PKCE `S256`. The client discovers the server, registers its redirect
URI through DCR and opens the browser. Consent shows the client, repository, scopes and effective role. A code is
bound to the client, redirect URI and PKCE challenge and expires after five minutes.

The client sends `Authorization: Bearer sma_…`. Tokens are opaque (`sma_` followed by 64 hex digits), stored as SHA-256
digests and expire after 30 days by default. The token carries `mcp:read` and, when granted, `mcp:write`. A
repository-scoped token stays on that repository. The token list returns summaries without token values or digests.

## Who reads, who writes

Public reads follow repository visibility. Private reads and writes use the same GitHub repository roles as the app,
checked on the target repository. A write also needs `mcp:write` and the role that the action requires. ChatApi
resolves an MCP credential as `act.kind: "agent"`, so `person_only` applies even to an Admin's agent. Approvals,
merges, triage overrides and settings, issue commitments, TODO commits and drops, secrets writes, runner registration
and model credential writes remain the person's.

## Tools

`tools/list` is the client-facing catalog. `tools/call` checks repository access and the action's permissions on every
call. The catalog covers repository files and refs, docs, issues and pull requests, and workflows. Where the person's
role permits, the agent can open issues, comment, draft TODOs and post work links. Workflows the client fetches for
local execution run on the client's machine.

## Observability

ChatApi records `mcp.request` logs and spans with the route, outcome and status. Its counters are
`smithers_mcp_requests` (route, outcome), `smithers_mcp_tool_calls` (tool, role, outcome) and `smithers_mcp_oauth`
(step, outcome). The shared person-only guard records `auth.person_only` and counts
`smithers_person_only_refusals` by act and caller kind. Tokens, authorization codes, PKCE verifiers, GitHub credentials
and tool payloads stay out of logs, traces and metrics.

## Tests

| Test | Proves |
|---|---|
| `worker/index.mcp.test.ts` | Both discovery requests reach ChatApi unchanged. The repository POST keeps its authorization header, query and JSON body through the rewrite. The consent and app run paths serve the app shell. |
| `worker/index.test.ts` | Existing API, alias, custom domain, docs and asset routing. |

To test the full connection, run a real Streamable HTTP client through discovery, registration, consent, exchange,
`tools/list` and `tools/call`. Check public and private reads, role and repository scope, revocation and the
`person_only` refusal.
