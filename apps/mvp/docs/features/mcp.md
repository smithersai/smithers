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
call. The catalog covers repository files and refs (`repo_tree`, `repo_read_file`, `repo_refs`), docs (`docs_list`, `docs_read`), issues and pull requests (`issues_list`, `issue_get`, `pulls_list`, `pull_get`, `pull_files`), and workflows (`flows_list`, `flow_get`). Where the person's
role permits, the agent can open issues, comment, draft TODOs and post work links. Workflows the client fetches for
local execution run on the client's machine.

A public repository answers reads before anyone clones or syncs it on Smithers. When Code Storage or the GitHub
projection has nothing yet, `worker/mcp/LiveDeps.ts` reads GitHub's REST API with the deployment read token
(`worker/github/ReadToken.ts`: `GITHUB_TOKEN`, else the App's `metadata: read` installation token, else anonymous).
Anonymous reads share GitHub's 60-per-hour limit across all of Cloudflare's egress addresses and run out within
minutes, so the token is the default. A 403 that is not quota exhaustion is retried once anonymously, and a private
repository still answers `not_found`. Quota exhaustion surfaces as the `rate_limited` tool error.

## Attach to a conversation

The person mints an attach reference for a repository, branch and conversation. The agent claims it with a PKCE S256
challenge and reads out a pairing code. The person opens consent and approves that claim using the code. The agent
redeems the approval with its PKCE verifier and sends its resulting bearer token on every MCP request.

| POST route | Caller and result |
|---|---|
| `/api/attach/intents` | Signed-in person, from the same origin. Returns a ten-minute reference. |
| `/api/attach/claims` | Agent. Returns an opaque claim and pairing code. |
| `/api/attach/consent` | Same person and origin. Returns the target, client, and the permissions on offer. |
| `/api/attach/approvals` | Same person and origin. Returns a single-use approval code and the id the person can revoke. |
| `/api/attach/tokens` | Agent holding the approval code and PKCE verifier. Returns an eight-hour grant and bearer token. |
| `/api/attach/revocations` | Grant's person, from the same origin. Ends the grant. |
| `/api/attach/mcp/<owner>/<repo>/<branch>` | Agent holding a valid grant for this target. |

`conversation_read` returns recent messages in the bound conversation. `conversation_respond` settles a pending
question from the person who attached the agent. The grant keeps the narrower of the approved permissions and the
person's current repository role and branch access. A delegated credential cannot grant or revoke access.

Each attachment has one Postgres row across Worker isolates. Indexed approval code and bearer token digests look up
that row. Claim, redemption and revocation lock only the matching attachment. A live token holds a shared lock through
its tool call so revocation takes effect in order. Unknown tokens use a read-only lookup. Claim and redemption share
a limit of 120 requests per network per minute, with a separate limit of 1,200 for MCP. Each request records only its
route and status in the `attach.request` log and span and the
`smithers_attach_requests` counter. See the [attach integration tests](../../worker/attach/LiveMount.test.ts) and
[decision 0173](../decisions/0173-byoa-only-mcp-attach-and-jev-config.md).

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
| `worker/mcp/LiveDeps.test.ts` | The public GitHub fallback reads refs, tree, files, issues and pulls. It sends the deployment read token, retries a non-quota 403 anonymously and reports quota exhaustion as `rate_limited`. |
| `packages/smithers/test/McpRemote.test.ts` | `smthrs mcp login` PKCE and token storage, and the `smthrs mcp serve` stdio bridge. |

To test the full connection, run a real Streamable HTTP client through discovery, registration, consent, exchange,
`tools/list` and `tools/call`. Check public and private reads, role and repository scope, revocation and the
`person_only` refusal.

## Cloud Factory MCP tools and one-time sandbox auth

Every repository exposes 15 Cloud Factory tools alongside the core BYOA catalog over `/<owner>/<repo>/mcp`:

- **Shared Cloud Object Store**: `artifact_list`, `artifact_get`, `artifact_put` (backed by R2 + Postgres `cloud_objects` with SHA-256 verification and strict cache-write isolation for untrusted callers).
- **Stacked Changesets**: `changeset_stack_list`, `changeset_create` (`changeset_stacks` table, tracking trusted vs untrusted gate status).
- **Project Wiki**: `wiki_list`, `wiki_read`, `wiki_write` (canonical writes sync live to `feed_documents` `wiki/<page>`, while untrusted contributors write isolated proposals under `proposed/<login>/`).
- **Mythical History**: `mythical_history_list`, `mythical_history_record` (linear commit narrative with tree-equality verification against `main`; canonical writes require trusted execution).
- **Backpressure Audit Reports**: `audit_report_list`, `audit_report_get`, `audit_report_publish` (mirrors trusted audits to `uphill` and untrusted community audits to `uphill/untrusted-<login>`).
- **Pull Requests**: `pull_create` (requires Member or Maintainer access, opens a PR attributed to `@<login> (agent)`, and never approves or merges).
- **One-Time Sandbox & Agent Auth**: `auth_one_time_mint` and `POST /api/repos/:owner/:repo/auth/one-time` print a short-lived single-use `smot_` token plus copy-paste shell and MCP snippets (`cache-control: no-store`). Ephemeral sandboxes redeem it atomically once via `POST /api/auth/one-time/redeem` (or `apps/mvp/scripts/mint-one-time-auth.mjs --redeem`) into an attenuated 2-hour `sma_` bearer token. Non-maintainers always receive `untrusted_contributor` trust.
