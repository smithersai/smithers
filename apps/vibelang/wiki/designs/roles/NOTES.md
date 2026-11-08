# Sign-in, roles and promotions (brick 2; VL-21)

Roles: viewer (signed out), new, community, contributor, maintainer. Open `index.html` and switch screens from the
top bar; every screen renders at 1280px and 390px with no horizontal scroll (shots in `shots/`).

## Screens and states

| Screen | What it shows |
| --- | --- |
| `viewer` | Signed out: the nav ends in a **Sign in** button with the GitHub mark. Everything else is unchanged; a viewer reads and chats. |
| `signing-in` | The button disabled reading "Signing in…", plus the `sui-loading-bar` at the top. |
| `sign-in-error` | A `sui-toast[data-tone="failed"]`: "Sign-in failed. GitHub didn't answer." with **Retry** and dismiss. |
| `new` | First sign-in: system message "Signed in as **ada**."; nav shows a **New** badge and the avatar. |
| `community` | The account menu open under the avatar: "Signed in as **ada**", the role badge, **People**, **Sign out**. |
| `people-community` | The People pane read-only: five people with role badges; your row is marked "you". |
| `people-maintainer` | The same pane with a role select per person; one select open (Maintainer ▸ Contributor/Community, New disabled). |
| `promote-dialog` | Confirm: "Promote rira to Maintainer?" — "Maintainers merge, promote and edit the wiki directly." Cancel / Promote. |
| `auto-promotion` | First participation: after joss's first post, a system message "You're now **Community**." and the nav badge has changed from New to Community. |
| `mock-picker` | Mock mode's identity picker: beside the **Mock** pill, a "Visit as" select with all five roles; the page re-renders as that identity with no backend. |
| `agent` | A maintainer posts "Promote rira to contributor"; a system event "rira is now Contributor." lands in the transcript and the agent confirms. |

## How a person sees their role

Always two places: a role badge in the top nav (next to the avatar), and the account menu's header. Badge variants:
Maintainer `sui-badge-default` (brand), Contributor `sui-badge-success`, Community `sui-badge-secondary`,
New `sui-badge-outline`. Signed-out viewers see no badge — the Sign in button is in its place. On screens ≤600px the
nav badge hides (the avatar menu still shows it) and Docs/GitHub yield to identity controls.

## Who may do what (least role per action)

| Action | Viewer | New | Community | Contributor | Maintainer |
| --- | --- | --- | --- | --- | --- |
| Read, chat with the agent, tour | ✓ | ✓ | ✓ | ✓ | ✓ |
| Sign in (GitHub OAuth) | ✓ | — | — | — | — |
| Post as a named person (multiplayer attribution) | — | ✓ | ✓ | ✓ | ✓ |
| See the People pane | — | ✓ | ✓ | ✓ | ✓ |
| Propose wiki edits | — | — | — | ✓ | ✓ |
| Edit the wiki directly | — | — | — | — | ✓ |
| Promote/demote roles | — | — | — | — | ✓ |

Community is "minimal privileges but has participated" (VL-21): it signs attribution and nothing more. Actions a
role can't take never appear (no disabled teasers).

## Promotions

- **Automatic: new → community on first participation.** The person's first accepted post flips the role; a system
  message in the conversation ("You're now **Community**.") is the only notice, and the nav badge changes at the
  same moment. No modal, no toast — it isn't an action they took.
- **Manual: maintainer only.** People pane → role select on a person's row → pick the new role → confirm dialog
  ("Promote/Demote X to Y?") with one line naming what the role may do. **New is disabled** in the select: it's the
  automatic entry state, never assigned by hand. A maintainer's own row has no select.
- **The agent does it through the same action.** A maintainer can ask in chat; the promotion runs as the same
  command the select calls, and the result lands as a system event in the transcript ("rira is now Contributor."),
  so everyone watching the conversation sees it. The agent confirms in one sentence.

## Mock mode: the identity picker (VL-13)

With no backend there is no OAuth, so mock mode shows **Mock** + a "Visit as" select listing all five roles
(viewer included). Choosing one re-renders the whole page as that identity: viewer gets the Sign in button and
posting stays anonymous; the rest get a fixture person (ada, joss, rira, will) with that role. Sign-in in mock mode
succeeds instantly as the picked identity. On phone the trigger shrinks to the role name.

## Interactions and keyboard paths

- **Sign in:** Tab to **Sign in**, Enter → GitHub OAuth redirect (live) or instant (mock). Failure is a toast;
  **Retry** re-runs it; dismiss with the ✕ or Esc.
- **Account menu:** Tab to the avatar, Enter opens; ↑/↓ move, Enter activates, Esc closes and returns focus to the
  avatar (the `sui-action-menu` pattern).
- **People pane:** menu → **People**, opens as a maximizable chat pane (same chrome as the wiki pane). Rows are
  read-only text for everyone but maintainers.
- **Change a role (maintainer):** Tab to the person's role select, Enter/Space opens, ↑/↓ choose, Enter opens the
  confirm dialog; Tab between Cancel/Promote, Enter commits, Esc cancels at either step.
- **Identity picker (mock):** same select keyboard pattern; applies immediately, no dialog.

## Components

Reused: `vl-top`/`vl-nav`/`vl-nav-link`/`vl-pill`, `sui-chat-*` (incl. the system-message bubble for role events),
`sui-badge` variants, `sui-avatar[data-lane]`, `sui-action-menu`, `sui-select-*`, `sui-dialog-*`, `sui-toast*`,
`sui-loading-bar`, `sui-button(-solid|-sm)`, Lucide maximize path for the pane toggle.

New: `.vl-people` pane (`-bar`, `-list`, `-person`, `-who`, `-name`, `-handle`, `-toggle`) on the wiki/docs pane
chrome; `.vl-account` (menu anchor); `.vl-role-select` (open-select anchor); `.vl-visit-as` (hides the prefix on
phone). People rows reuse `sui-avatar` with initials until GitHub avatars load live.

## Copy (every visible string)

"Sign in", "Signing in…", "Sign-in failed. GitHub didn't answer.", "Retry". System: "Signed in as **ada**.",
"You're now **Community**.", "**rira** is now Contributor." Menu: "Signed in as **ada**", "People", "Sign out".
Pane: "People · 5", "you". Roles: "New", "Community", "Contributor", "Maintainer". Dialog: "Promote rira to
Maintainer?", "Maintainers merge, promote and edit the wiki directly.", "Cancel", "Promote". Mock: "Mock",
"Visit as: Community", "Viewer". Agent: "Done — rira is a Contributor."

## Choices

- **Sign in is a nav button, not a gate.** Viewers can read and chat (the app is a public factory); signing in only
  adds attribution and privileges.
- **Role lives in the nav, always visible.** VL-21 asks that promotion be thoughtful; seeing your own role at all
  times is what makes a promotion mean something.
- **Automatic promotion is a chat system event**, because everything is a chat (VL-17) and role changes are events
  of the same conversation state machine — multiplayer clients and the agent all see them.
- **Confirm dialog only for manual changes**, with one line of consequence; automatic ones never interrupt.
- **People is a pane**, like the wiki: one chrome pattern for all reference UI, maximizable, phone-safe.
- **"Visit as" is mock-only tooling** sitting next to the Mock pill, so a visitor can try every role with no
  backend (VL-13) and the live app never shows it.
