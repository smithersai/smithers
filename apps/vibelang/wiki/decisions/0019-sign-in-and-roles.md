# 0019. GitHub identity and five project roles

Status: accepted policy, 2026-11-07. Rulings: VL-8, VL-11, VL-13, VL-21, VL-23, VL-29; SDK-1, SDK-11.
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
| Create an issue, comment | New | Future brick 3; first accepted participation earns Community |
| Propose a VIP | Community | Future brick 3 |
| Triage issues | Contributor | Future brick 3 |
| Run a registered action | Contributor | Future brick 4; each action may require more |
| Start a sandbox | Contributor | Future brick 6; a separate allowance must also admit it |
| Merge or accept a VIP | Maintainer | Future; a person triggers the configured workflow |
| Project settings | Maintainer | Future |
| Grant roles | Maintainer | This brick; self promotion is forbidden |
| Step down | Own current identity | Strictly lower role; preserve another maintainer |

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

The designer's roles design will be copied verbatim into wiki/designs/roles before its UI lands. Mock identity
selection is available only in product mock mode, never as a live authorization header. Each role's view and
promotion runs without backend or model. Unauthorized controls are absent, not merely disabled. Copy stays minimal.
