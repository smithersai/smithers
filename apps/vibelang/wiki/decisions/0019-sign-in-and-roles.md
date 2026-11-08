# 0019. GitHub identity and five project roles

Status: implemented locally, 2026-11-07. Rulings: VL-8, VL-11, VL-13, VL-21, VL-23, VL-29; SDK-1, SDK-11.
Will may override this policy.

## Design twice

Chosen: explicit project trust, with a small automatic first step. An unsigned visitor is Viewer. A verified GitHub
identity begins New. Its first accepted participation promotes it to Community, once; reading and starting a tour
do not count. Maintainers grant Contributor or Maintainer to another person. A person can step down; a maintainer
can demote a peer while another maintainer remains. An explicit grant, including a demotion to New, suppresses
automatic promotion. Signing out changes the current browser to Viewer, never the person's project grant.

Alternative: derive every role from GitHub repository permissions (read/triage → Community, write → Contributor,
maintain/admin → Maintainer). This reuses smithers.sh's policy but conflates repository write access and participation,
provides no useful New → Community step, and makes community trust depend on repository administration. We reuse
its authentication and keep this project's authorization policy separate. A configurable workflow can implement a
future policy through the same interface.

The initial maintainer is configured by immutable GitHub numeric ID. A system bootstrap grant is permitted only into
an empty project ledger, through a server-only host operation. An HTTP client never supplies an actor, role, or
bootstrap/participation mode. A person is addressed by numeric GitHub ID; mutable logins are display names.

## Each action names its least role

| Action | Least role | Scope |
| --- | --- | --- |
| Read public pages, conversations and history | Viewer | Current |
| Ask the agent | Viewer | Current; deployment token budget still applies |
| Start or end a personal tour | Viewer | Current |
| Read People and role events | New | Current |
| Create an issue, comment | New | Future brick 3; first accepted participation earns Community |
| Propose a VIP | Community | Future brick 3 |
| Triage issues | Contributor | Future brick 3 |
| Run a registered action | Contributor | Future brick 4; each action may require more |
| Start a sandbox | Contributor | Brick 6 landed alongside this lane; a separate allowance must also admit it |
| Merge or accept a VIP | Maintainer | Future; a person triggers the configured workflow |
| Project settings | Maintainer | Future |
| Grant roles | Maintainer | This brick; self promotion is forbidden |
| Step down | Community, own identity | Strictly lower role; preserve another maintainer |

These future permissions reserve policy names, not implemented feature claims. Roles alone grant neither model
credit nor sandbox minutes. Agents never approve or merge. A workflow may tighten the minimum; it cannot silently
weaken it.

## One machine and one authentication implementation

RoleGranted and ActionAuthorized are numbered events in conversation.vibe. Refusals are typed, including forbidden.
The project's role ledger uses that same decide/apply/receive machine. The host derives identity from its session,
resolves the current grant for every privileged operation, and rejects stale-session privilege after demotion.
Every write is a durable flow step. The policy interface delegates to the verified predicates, ready for workflow
policy without scattered UI conditions.

The library catalog entry for GitHub is @smthrs/integrations. Its GitHub.Auth module owns the proven apps/mvp adapter
(authorize with state and PKCE S256, exchange, refresh, identity, repository permission, revoke); apps/mvp keeps only
its own role mapping and re-exports. Authentication is core infrastructure: it establishes the principal before a
plugin or a flow may be authorized. No second OAuth implementation remains.

## UI and mock

The designer's roles design is copied verbatim into wiki/designs/roles with its UI. Mock identity
selection is available only in product mock mode, never as a live authorization header. Each role's view and
promotion runs without backend or model. Unauthorized controls are absent, not merely disabled. Copy stays minimal.

## Implementation and evidence

The shared adapter and purpose-bound cookie signatures landed in 2255b682. MVP keeps its encrypted GitHub
credential storage and its tested connection/revocation lifecycle. VibeLang sessions retain only the verified numeric
ID, login and local expiry. OAuth tokens are used for the callback's identity lookup and discarded; no token is put
in a session, flow result or journal. Sign out ends the local session. A future GitHub-writing feature must add an
explicit credential connection flow.

Accounts are one project Durable Object, whose numbered role ledger uses the same conversation reducer and whose
writes run vibelang/Account steps on the Smithers engine in its SQLite. The callback binds the exact configured
origin, signed state cookie and one-time encrypted PKCE verifier. Setup requires a valid initial maintainer ID and
encryption key; invalid or absent setup disables authentication while public reading, chat and tours keep working.
Role writes authenticate before reading at most 2 KiB with a three-second body deadline, outside the mutation lock.
Every grant resolves the session's current role, so a demotion applies to an existing cookie immediately.

The designer's index.html and NOTES.md are preserved under wiki/designs/roles. Native role selects retain the
designer's styling and open outside pane clipping (the lead's review note). People is read-only for every signed-in
role, and only maintainers see peer role selects. The design presents Community as the manual UI floor; the API
also accepts an explicit demotion to New and self-demotion for moderation/recovery. It never auto-promotes a person
with any previous grant. The account menu and modal restore keyboard focus; the mock-only Visit as picker selects
all five roles without an API request.

Initial evidence before integration with parallel lanes: 45 verified, zero errors; all 88 executable mutations
rejected (23 new role mutations, 65 inherited); 191 unit/scene tests; six session/grant workerd cases; nine role browser
cases across dark, light-preferring and phone projects. Final counts and command receipts live in the lane report.

The unchanged role proof passed at 45 verified / 0 errors, then hit the old 30-second wall budget under shared-host
contention with byte-identical source and emitted Dafny. Production batches now have 60 seconds and one solver core;
mutation batches retain 30 seconds and still reject timeouts as evidence. Contracts and proof obligations are unchanged.

The signed-in identity response carries a complete role-ledger snapshot and cursor. A view subscribes after that
cursor, so historical bootstrap/manual grants are not announced as new promotions. A dropped or cleanly ended role
stream offers Retry; it resumes at the last applied cursor without changing identity. A received demotion closes
an open grant confirmation immediately. Unconfigured live sign-in stays on the page with a retryable notice.

The mock restores its four historical grant events through apply and acquires its mutation engine only for a new
role action. Account viewing and CLI/MCP discovery do not execute fixture bootstrap flows. Named posts use the
session's login, ignore the wire name, and require the same Origin before recording or automatic promotion.
Logs, spans and counts use step/outcome only; tests check grant log privacy and the accepted-grant counter.

People reads and role-event subscriptions also use the Policy interface and its verified New minimum. No signed-in view relies on a separate ad hoc identity check for that action.

When a demo role has no remaining person after participation or demotion, Visit as creates a distinct fixture identity and records its grant through a current maintainer, preserving the same policy guards.

After integration, all eight production modules verify (111 results). Two new inherited reply-finish/failure mutations use the existing harness postcondition targeting so each checks its intended unchanged contract within the negative budget; positive proofs still check every obligation.

### Sandbox identity integration

The live gateway derives the immutable owner from a verified session, checks the canonical `sandbox` permission,
and rejects cross-origin mutations. Account execution and metering re-read that owner's current grant. Offline
sandboxes keep files, receipts and monthly allowance per identity; switching the role picker invalidates old UI
responses. Mock-agent Post payloads carry the captured owner to an accepted post-ID mapping, so a queued reply
cannot borrow a later selected identity. Missing owners fail closed. Live agent sandbox tools retain the closed
binding until an originating post owner is persisted and verified through the live reply flow.
