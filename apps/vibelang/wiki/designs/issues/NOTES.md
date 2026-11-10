# Issues as a tree, tasks, and proposing a VIP — NOTES

Roadmap brick 3 (VL-20). One self-contained `index.html`: the full live stylesheet (`live-app.css`) inlined
verbatim, dark only (VL-27, `data-theme="dark"`), mock mode pill shown (VL-13). The thin dark strip at the very top
(`d-bar`) is design-doc chrome, not the app: it switches Screen (15 screens), Role (viewer → maintainer) and the list
State (populated / empty / loading / error). `shots/` has every screen at 1280×800 and 390×844; `desktop.png` /
`phone.png` are the default Issues screen. `body.html` + `extra.css` are the sources `index.html` is assembled from
(cat-able, no build tool); `shots.mjs` re-renders every screenshot.

## The model

- **Issue** — anything filed: bug, idea, question, VIP candidate. Open to every signed-in role. Numbered `#n` like
  GitHub. A VIP's number *is* its issue number (no separate VIP-n sequence — one namespace, GitHub-like).
- **Tree** — an issue may have one parent and any children. Shown three ways: `child of #38` and `N children` in a
  row's meta line, a `Tree` card on the detail (parent link + child rows), and timeline events when links change.
- **Task** — not a separate object: an open issue a maintainer **committed to**, with an assignee. Badge
  `Task · Queued|Running|Done`, dashed/half-filled state icons (reusing `sui-state-icon` kinds). A task can be
  uncommitted back to a plain issue (`Uncommit`, maintainer).
- **VIP** — an issue with the VIP template (Title, Summary, Example, Prior art; one language feature) and a review
  state: `In review` (warning badge) → `Accepted` (success) or `Declined` (destructive, closed). Reviewed with Will:
  only a maintainer sees Accept/Decline.

## Screens (the bar's Screen menu)

1. **Issues** — GitHub-like list in `sui-issues-view`: Open/Closed filters with counts, kind segmented
   (All / Issues / Tasks / VIPs), search, `New issue`. Rows: state icon, title, `VIP · state` / `Task · state` badges,
   labels, meta (`#n · opened 2d ago by jun · child of #38 · 2 children · → VibeLang agent`), comment count.
2. **Tasks** — same component, Tasks selected; only committed issues; assignee in meta (`→ VibeLang agent`).
3. **VIPs** — same component, VIPs selected; action is `Propose a VIP`.
4. **Issue · open (#42)** — `sui-item-conv` with aside. Header: title + number, `Open` badge, opener line, role-gated
   actions (`Split` contributor+, `Commit` maintainer). Body: opening post, **Tree card** (Part of #38, children #49
   open, #50 a queued task assigned to the agent), timeline events (label added, linked under #38), comments (one from
   the agent linking a related issue), comment composer. Aside: Assignees, Labels, Parent.
5. **Issue · commit dialog** — the moment an issue becomes a task. `sui-dialog`: title `Commit #42 as a task`, one
   field (Assignee radio list: VibeLang agent preselected, Will, Maya), Cancel / Commit. Who commits: a maintainer;
   the assignee is who does the work — the agent is the default because the factory's agents pick up tasks.
6. **Issue · committed task** — result: `Task · Queued` badge beside `Open`, assignee in the aside, a `Task` aside
   section with the queued icon, `Uncommit` replacing `Commit`, and a timeline event
   `will committed this as a task and assigned VibeLang agent · just now`.
7–10. **Propose a VIP, steps 1–4** — narrow page, `ix-steps` indicator (done = filled check, current = brand).
   Step 1 Summary (title placeholder `One language feature` — the one-feature rule lives in the placeholder, not
   prose), step 2 Example (mono code field), step 3 Prior art (one per line), step 4 Review (the composed VIP card)
   with `Submit VIP`.
11. **VIP · in review (#45)** — detail with `VIP · In review` badge; maintainer sees `Decline` / `Accept` in the
    header; aside names Proposer and Reviewer (Will). Everyone below maintainer sees no actions (SCOPE-14).
12. **VIP · accepted (#44)** — `VIP · Accepted`, timeline shows proposed → accepted → committed as task #47; the
    aside links the task. The VIP → task path is visible without prose.
13. **Chat · agent files an issue** — live chat transcript: collapsed `Issues · 9 open` pane (VL-17, expands with view
    transitions like the splash pane), user request, agent acts (`Filed #48.`) and attaches an issue card with
    `Open issue`. The agent never gives instructions; it does the action.
14. **Chat · agent splits and links** — `Split #38 into three children, linked under it.` plus a card listing the
    children with their state icons/badges and `Open #38`.
15. **Roles** — action × role table (least-role per action, granular-permissions skill). Caption:
    `The agent acts through the same actions. Anything above your role never appears.`

## States

- **Empty** — `sui-empty`: icon, `No open issues` / `No tasks committed` / `No VIPs in review`, one action.
- **Loading** — five `sui-skeleton` rows inside the list frame; filters stay rendered.
- **Error** — `sui-alert-destructive` `Couldn't load issues` + `Retry`.
- **Role** — the Role menu re-renders affordances live: viewer gets `Sign in` in the top nav and loses
  `New issue`, composers, `Split`, `Commit`, `Accept`/`Decline` (hidden, never disabled — SCOPE-14);
  new/community keep file+comment; contributor adds `Split`; maintainer adds `Commit`/`Uncommit` and VIP review.

## Interactions and keyboard paths

- List: `Tab` moves through filters → segmented → search → rows (each row title is a link); `Enter` opens; rows focus
  visibly via the existing `sui-issues-link` focus ring. `j`/`k` move row selection like GitHub (engineering note; the
  mock is static).
- Segmented control: `role="radiogroup"`, arrow keys move between kinds, per the `sui-segmented` pattern.
- Commit dialog: opens from `Commit`; `Tab` cycles radio rows (arrow keys move within the radiogroup), `Enter` commits,
  `Esc` cancels (implemented in the mock: Esc on the dialog screen returns to the open issue), focus returns to
  `Commit` on close.
- VIP form: `Continue`/`Back` advance steps; `Enter` in a single-line field advances; step 4 `Submit VIP`. Validation:
  an empty title blocks step 1 with `sui-issue-form-error` `Name the feature.` (designed, not pictured).
- Issue detail: aside links and action buttons are plain links/buttons in `Tab` order; comment composer submits with
  `⌘⏎` (single-line fields never submit on `Enter`).
- Chat: unchanged from the live app (`⌘K` prompt, docked composer, `⏎` sends); the issues pane expands in place with
  the app's existing view-transition, and maximizes like the docs pane.
- Every screen keeps the live top bar; `‹ Chat` / `‹ Issues` / `‹ VIPs` breadcrumb back links return to the parent.

## Components

Reused from the live stylesheet, unchanged: `vl-top`, `vl-nav-link`, `vl-pill` (Mock), `vl-pane`, `vl-code`,
`sui-page-header*`, `sui-page-body`, `sui-issues-*`, `sui-state-icon`, `sui-badge*`, `sui-segmented`, `sui-input`,
`sui-textarea`, `sui-label`, `sui-field`, `sui-empty`, `sui-skeleton`, `sui-alert*`, `sui-button*`, `sui-card*`,
`sui-item-conv-*`, `sui-issue-form*`, `sui-dialog-*`, `sui-table*`, `sui-chat-*`, `sui-msg-scroller*`.

New (prefix `ix-`, in `extra.css`): `ix-steps` (VIP step pills), `ix-tree`/`ix-tree-row`/`ix-tree-kids` (indented child
lists, borrows `sui-file-tree` indentation), `ix-avatar` (initial circle; `data-agent` tints it warning so agent
actors read at a glance), `ix-pick` (radio rows), `ix-aside-section`, `ix-mini` (chat card rows), `ix-roles` table
alignment, `ix-chat-card`. State icons are three small inline SVGs (open dot, check, dashed queued, half running)
drawn on `sui-state-icon`'s existing `data-kind` colors.

## Copy (every visible string)

Bar (design chrome): `Issues, tasks, VIPs`, `Screen`, `Role`, `List`, option labels as in the Screen list above plus
`Viewer New Community Contributor Maintainer`, `Populated Empty Loading Error`.
Nav: `Mock`, `Docs ↗`, `GitHub ↗`, `Sign in` (viewer only).
List: `‹ Chat`, `Issues`/`Tasks`/`VIPs`, `New issue`, `Propose a VIP`, `Open`, `Closed`, `All`, `Issues`, `Tasks`,
`VIPs`, `Search`, empty titles (`No open issues`, `No tasks committed`, `No VIPs in review`), `Couldn't load issues`,
`Retry`. Row meta: `#n · opened|closed Xd ago by who · child of #38 · N children · → assignee`.
Detail: `‹ Issues`, `Open`, `Task · Queued`, `N comments`, `Split`, `Commit`, `Uncommit`, `Tree`, `N children`,
`Part of #38 …`, aside labels `Assignees`, `No one`, `Task`, `Queued`, `Labels`, `Parent`, `Proposer`, `Reviewer`,
composer `Comment`. Events: `added the compiler label`, `linked this under #38`,
`committed this as a task and assigned VibeLang agent`, `proposed this VIP`, `accepted this VIP`,
`committed #47 as a task and assigned Will`.
Dialog: `Commit #42 as a task`, `Assignee`, `VibeLang agent`, `Will`, `Maya`, `Cancel`, `Commit`.
VIP form: `Propose a VIP`, steps `Summary Example Prior art Review`, `Title`, `One language feature`, `Example`,
`Prior art`, `One per line`, `Back`, `Continue`, `Submit VIP`.
VIP detail: `VIP · In review`, `VIP · Accepted`, `VIP · Declined`, `Accept`, `Decline`.
Chat: `Issues · 9 open`, `Filed #48.`, `Split #38 into three children, linked under it.`, `Open issue`, `Open #38`,
`Ask about VibeLang`, `Ready`, agent badge `agent`.
Roles: column/row labels as in the table; caption quoted above.

## Decisions (one line each)

- **Tasks are a state of an issue, not a second object** — VL-20's "clear difference" reads clearest when the same
  #n page gains a `Task` badge, assignee and timeline event; nothing to convert or migrate.
- **Commit is maintainer-only, assignee defaults to the agent** — granular permissions; the factory's agents are the
  default workforce, people are assigned explicitly.
- **One issue namespace, VIPs and tasks filtered by segmented kind** — GitHub-like (VL-18); counts stay honest.
- **VIP number = issue number** — like PEP/RFC; no parallel counter to keep in sync.
- **The one-feature rule lives in the title placeholder** — minimal text law; no explanatory prose blocks.
- **Tree shows parent + children on the detail, `child of`/`N children` in rows** — enough to navigate; a full graph
  view is YAGNI until the tree gets deep.
- **Split and link are contributor/community actions, also done by the agent in chat** — open process with filters:
  shaping the tree needs track record, filing doesn't.
- **Viewer sees Sign in, never disabled buttons** — SCOPE-14: unauthorized actions never appear.
- **Roles screen is a page in the app** — VL-21 asks that promotion be thoughtful; the table is the reference the
  promotion UI (brick 2) will point at.
- **Dark only, Mock pill, panes and view transitions** — VL-27, VL-13, VL-17 carried through unchanged.
