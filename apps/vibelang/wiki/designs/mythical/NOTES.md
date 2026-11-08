# Mythical history — design notes

Brick 5, VL-22. The mythical history is a second, clean, linear history beside `main`: epics of small
logical commits, each commit carrying a note (tried / evidence / folded / superseded) and links to the
real commits it stands for. Work is planned onto it, worked, landed on `main`, and folded back. The
view copies GitHub's commits page (VL-18) and lives as a pane in the chat that can be maximized (VL-17).

`index.html` is self-contained: the live stylesheet inlined verbatim, dark only (VL-27). The dashed bar
on top is the review harness, not app UI: it switches screens and the role. `#<screen>/<role>` in the
hash deep-links a state (e.g. `index.html#commit/maintainer`).

## Screens and states

| Screen | State |
| --- | --- |
| History | The default view: the first-parent epic list, GitHub's commits page regrouped by epic. |
| History / viewer | Signed out: `Sign in` in the top bar, no Plan work button. Reads are public. |
| History / maintainer | Adds nothing on the list; Amend appears on a commit, Bootstrap on the empty state. |
| Epic | One epic: its story, the atomic chain grouped Docs → Code → Tests, its trailers. |
| Commit | Message, sha, jj change id, the note's four sections, the diff, the link to the real commits. |
| Plan work | Dialog over History (contributor and up). Commit message, epic picker (shown open), place. |
| Follow work | One planned commit's life: planned → working → lands on main → folds in. Mid-flight, future steps muted. |
| Empty | Before bootstrap: "No mythical history yet." plus the one door for maintainers. |
| Bootstrap | `history.bootstrap`'s form: repository (fixed), budget. Maintainer only. |
| Loading | Skeleton epic rows. |
| Error | The projection is unreachable; Retry. |
| Agent in chat | The same append done by the agent from the chat: tool call, reply, the pane inline with a maximize button. |

## Interactions and keyboard paths

- **Epic expand/collapse**: click or Enter/Space on the epic header (`role="button"`, `aria-expanded`).
- **Commit → detail**: click or Tab+Enter on a commit row; every row is a link.
- **Back**: the breadcrumb (History / epic / commit), each crumb a link.
- **Filter**: the Filter commits input filters client-side; Tab reaches it from the ref picker.
- **Plan work**: button (contributor+) or the agent. In the dialog: Tab through Commit → Epic → Place →
  buttons; ↑/↓ move in the epic listbox; Enter on Plan work submits; Esc or × cancels to History.
- **Place**: radio group, arrow keys move; Amend a landed commit exists only for maintainers (it opens
  `history.amend`, which rewrites the branch).
- **Follow work**: the Planned row links here; the timeline's run, change and epic are links.
- **Maximize/minimize**: the pane bar's − / the chat pane's ⤢ (Tab+Enter). Live, maximized is
  `position: fixed; inset: 60px 0 0` with the view transition from brick 1f; the harness renders it in
  flow so the review bar can sit above.
- **Mock**: the Mock pill shows the page is running with no backend (VL-13); all data here is the mock's.

## Components

Reused from the live app: `vl-top`, `vl-home`, `vl-logo`, `vl-nav-link`, `vl-pill`, `vl-docs` + bar +
toggle (the pane chrome), `sui-collapsible` (epics), `sui-compact-group` (planned work), `sui-badge-*`,
`sui-status-dot`, `sui-ref-picker`, `sui-breadcrumbs`, `sui-card`, `sui-generated-links` (trailers),
`sui-commit-hash` (sha and jj change id), `sui-diff` (a commit's diff), `sui-dialog-*`, `sui-select-*`,
`sui-input`, `sui-field`, `sui-label`, `sui-flow-form-check`, `sui-item-conv` + `sui-activity-timeline`
+ aside (the work item, GitHub's PR page), `sui-empty`, `sui-alert`, `sui-skeleton`, `sui-chat-*`,
`sui-toolcall`, `sui-agent-output`, `sui-md`, `sui-open-in-chat`.

New (feature CSS, `mh-` prefix): `mh-pane`/`mh-pane-body` (pane content instead of the docs iframe),
`mh-toolbar`, `mh-epics`, `mh-story`, `mh-commits`/`mh-commit` (a commit row: plane badge, message,
note dot, fold count, change id, age), `mh-plane`, `mh-note-sections` (the note's four fixed sections),
`mh-mini` (the pane collapsed into a chat message), `mh-empty-img`.

## Copy (every visible string)

- Pane bar: `History · mythical`; minimize `−`, maximize `⤢`.
- Toolbar: `vibelang / History`, ref `mythical`, badge `tree = main`, placeholder `Filter commits`,
  button `Plan work`; viewer's nav adds `Sign in`.
- Planned group: `Planned · 1`; row badge `planned`; row tail `onto The Jj service learns to rebase`.
- Epic header: title, `7 commits · folds 9 · #46`; story is one sentence.
- Commit rows: `docs` / `code` / `test` badges, message, `folds 3`, change id, age (`3d`).
- Epic page: badges `tree = main`, `7 commits`, `folds 9 real commits`; group labels `Docs`, `Code`,
  `Tests`; trailers `Folded-from`, `Change`, `Run`.
- Commit page: `agent · 2 days ago`, `Amend…`; note: `Note`, `refs/notes/mythical`, `Tried`,
  `Evidence`, `Folded`, `Superseded`, `(none)`; `Open the real commits on GitHub ↗`.
- Plan dialog: `Plan work`, `Commit`, `Epic`, `New epic…`, `Place`, `Append to the epic`,
  `Insert after a commit…`, `Amend a landed commit…`, `Cancel`, `Plan work`.
- Work item: badge `working`; timeline `Planned onto …`, `Working · run_01J8M2XA`,
  `Lands on main as one real commit`, `Folds into the history; the note records what was tried`;
  aside `Epic`, `Change`, `Run`.
- Empty: `No mythical history yet.` (verbatim from the spec); button `Bootstrap history`.
- Bootstrap dialog: `Bootstrap history`, `Repository`, `Budget`, `Cancel`, `Bootstrap`.
- Error: `Couldn't load the history.`, `The projection on smithers/history is unreachable.`, `Retry`.
- Chat: `VibeLang agent`, tool `history.append`, reply `Planned. It appends to The Jj service learns
  to rebase and lands as one real commit on main.`, composer `Ask about VibeLang, or describe what to
  change`, status `Mock · answers are scripted`.

## Choices, one line each

- **Epics as collapsible cards on one page** — GitHub's commits list, one level up; the first-parent
  walk is the page.
- **`tree = main` badge next to the ref** — the invariant a reader checks first; one glance, no prose.
- **Planes as badges on rows, groups on the epic page** — the list stays one line per commit; the epic
  page shows the docs → code → tests order the spec mandates.
- **The note dot ◈ on every row** — every mythical commit must have a note; the dot makes a missing one
  visible as a bug.
- **Notes rendered as four fixed sections, `(none)` when empty** — the spec's rule; nothing is hidden.
- **Folded-from links go to GitHub** — plue no longer exists; `main` is mirrored there, so the real
  commits resolve.
- **Planned work is a dashed group on top of the list** — it is not history yet; dashed says proposed.
- **Amend is maintainer-only, plan is contributor+** — amend rewrites published history; planning only
  proposes (granular permissions; unauthorized actions never render).
- **Bootstrap gated to maintainers and a budget field is required** — it costs real money (~$400–600 in
  the spec's estimate), so the form names the budget up front.
- **Empty state omits "main has N commits."** — the spec adds it only with a live count; never
  fabricated.
- **The commit's "author" is `agent`** — notes and commits are written by flows; a person never edits a
  note by hand (they open a Change).
- **The work item reuses the PR-page shape (`sui-item-conv`)** — following work should feel like
  following a pull request (VL-18).
- **Chat screen shows the tool call, not just prose** — anything a person can do, the agent does
  through the same action, and the action is visible.
