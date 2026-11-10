# 0028. CLI and MCP sign-in: the person's agent identity

Status: implemented, 2026-11-09. Rulings: VL-13, VL-21, VL-26, VL-29; decisions 0009, 0019.
Will may override this policy. Number 0027 was already used for acceptance gates when this lane resumed; 0028 preserves both decisions.

## Design twice

Chosen: GitHub's device flow through the shared `@smthrs/integrations` GitHub auth (0019 moved it there). `vibelang-factory login`
asks the server for the public OAuth client id (`GET /api/auth/device`), runs the device flow itself, and trades the
grant at `POST /api/auth/device` for a session cookie the server marks as the person's **agent**. The CLI and MCP
server store the session where the CLI keeps its settings (`$XDG_CONFIG_HOME/vibelang-factory/session.json`, directory
0700, atomically replaced file 0600; `VIBELANG_SESSION` still overrides), and `logout` ends it on the server and locally. A post the agent
makes is named `<login> (agent)` by the server from the session — never from a caller-supplied name — and carries the
person's role for every check through 0019's policy, resolved per write so a demotion applies at once. An agent never
approves or folds the mythical history and never merges, whatever the person's role: the history machine's proved
`may` refuses agent principals person-only actions, and the issues authority refuses agent VIP acceptance/decline. A Maintainer minimum alone is not a human-only action: agents retain the person's other permissions. Mock mode (VL-13)
signs in as the fixture person with no network and labels its posts the same way; signed out, the mock keeps its
own surface labels, as before.

The label is `<login> (agent)`, rendered by the chat's existing label component (`.sui-chat-message-label`) with no
new copy. A person's own posts keep "You"; their agent's posts name the person so every reader sees who is
responsible.

Alternative: a separate bot identity (a GitHub App or a dedicated account named `vibelang-bot`) that posts under its
own login with its own role. That answers "who wrote this" with nobody, loses the person's role at every policy
check, and needs a second account lifecycle and grant path. We already trust the person's session; marking it as their
agent is one bit, one label, and no new identity. A second rejected label, `will's agent`, reads as possession and
line-wraps worse than the parenthetical.

## Rules the server keeps

- The session record carries `agent: true` only when issued through the device route; the browser callback never sets
  it, and an agent session can never bind a GitHub credential (`/api/auth/connect` refuses it), so an agent's writes
  stay the agent's.
- `POST /api/auth/device` is a journaled `vibelang/Account` step, bounded at 2 KiB with the three-second deadline,
  same-origin like every mutation; the access token is used for one identity lookup and discarded, as the browser
  callback's is.
- `GET /api/auth/device` is public and returns only the client id. Unconfigured authentication answers it 503, like
  sign-in.
- A local development deployment is a loopback http origin (`alchemy dev`); every other deployment is https. Without
  this, sign-in — browser or device — could never run locally, and VL-26's dogfooding would wait on production.
- Nothing logs a cookie, a device code or a token; the device step logs its outcome only.

## Evidence

Failing first: the suites below named no `login`/`logout` command and no agent label before this change. Green after:
CLI process cases (mock sign-in, logout, relogin refusal, live refusal), stdio MCP cases through `McpClient`
(discovery parity, sign-in, agent-named posts, logout, guest after), workerd cases for the device route, the agent
label, the carried role and the approve/fold refusal, and a CLI process over local workerd that posts as the fixture
person's agent and as Guest after logout. `e2e/live.spec.ts` expects the agent label when `VIBELANG_SESSION` names a
test session and Guest otherwise.


## Durable host and lifecycle

Authentication is infrastructure before authorization (0019), so its transport runs at the surface boundary; posts
and every other feature still go through Factory. The native mutations are `vibelang/Session` executions on the
existing `@smthrs/platform-node` SQLite host; `vibelang/SessionWait` uses SDK Poll and Sleep. Only bounded statuses
reach the journal. Device codes remain in private pending settings, and the access token stays inside the action
that exchanges it for the app cookie. Starting another process resumes the saved pending device grant and its
next permissible polling time. Pending and slow-down intervals are persisted, so repeated MCP calls cannot poll
GitHub faster. No app retry loop or background worker is introduced.

CLI login waits by default; `--wait false` returns the verification URL/code. MCP login defaults to returning that
code immediately; call it again after authorizing. `wait: true` waits durably. Denial and expiry clear the pending
grant. A revoked/expired stored session starts a new device flow. Logout revokes the remote session and removes local
session/pending files; an unreachable revocation returns failure while still removing local credentials. The explicit
`VIBELANG_SESSION` override is also revoked. No health probe blocks CLI login/logout.

Live requests re-read the session file, so a running MCP host sees its own login and a separate CLI login/logout
without restarting. Cookies bind to the exact origin, redirects are refused, and non-loopback origins require HTTPS.
Registered Post actions use the server-derived label and agent bit even if a caller supplies a button door;
reruns use their current caller's authenticated name and actor. Agent/person fixture issue and wiki journals are distinct.
Wiki drafts use the same role; save/propose remain person-only in Mock and live mode, including cached replay.

`vibelang.session.<step>` spans, `vibelang.session` outcome logs and `vibelang_session_steps` counters record native
login/poll/logout. The account host retains its existing step spans/logs/counts for device issuance. No new dependency
was added. Catalog entries reused: integrations (GitHub auth), flow (Actions, Poll, Sleep), platform-node (durable
SQLite host), and ui-css (the existing label).

## Proof boundary and deployment configuration

`identityDecision.postLabel` proves the exact guest, person and agent labels; three executable mutations each break
one case and must fail Dafny. Existing role/history machine proofs retain the role thresholds and person-only guards.
Signature verification, GitHub responses, Effect execution, persistence and HTTP remain library/host boundaries,
covered by real CLI/stdio/workerd/browser tests; this is not a claim that those implementations are formally proved.
The waiting CLI test scans the actual SQLite journal for device codes, tokens and cookies. A browser case observes
the same fixture post through the existing label, with no new UI control or copy.

Enable **Device Flow** on the GitHub OAuth/GitHub App used by the existing `GITHUB_CLIENT_ID`. The CLI needs no
client secret. Server-only configuration remains 0019's client secret, session signing/encryption keys, canonical
origin and initial maintainer numeric ID. GitHub's [device-flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
and [GitHub App setting](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#activating-or-deactivating-the-device-flow)
name the opt-in. The lead deploys; production browser tests opt in with an agent app session, not a GitHub token.


Mock identity uses `mock-session.json` separately from the live `session.json` and pending device grant. Its login
and logout never overwrite/revoke the live credential or make a network request, including when a live session or
`VIBELANG_SESSION` is already configured. A real loopback refusal service counts requests in the regression: zero.

## Clarified notes

`GET /api/auth/device` stays unchanged: only GitHub knows whether device flow is on, and the server cannot ask without minting a device code.

CLI and MCP login report a `misconfigured` device start as `Device sign-in is off for <origin>.`; other reasons keep their existing message. The SDK classifies GitHub's four client/configuration error codes at any HTTP status, with real-socket SDK and emitted CLI regressions.
