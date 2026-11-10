# Actions and slash commands (VL-24)

Registered workflows, GitHub Actions-style, inside the chat as a maximizable pane (VL-17, VL-18). Every run is a
durable flow (VL-11). Mock mode renders every screen here with the Mock pill (VL-13).

Open `index.html`; the top bar switches screens. `?chrome=0` hides the demo bar (used for the screenshots).

## Registered actions

| Action | Command | Least role that runs it | What it does |
| --- | --- | --- | --- |
| CI | `/ci` | contributor | Verify, lint, test, build `main` or a branch |
| Docs | `/docs` | community | Sync the wiki into the app |
| Triage | `/triage` | community | Label and route open issues |
| Release | `/release` | maintainer | Publish VibeLang to npm |

Everyone, including a signed-out viewer, can open Actions and watch runs — like a public repo on GitHub. Running is
gated per action (granular permissions skill); a command a role may not run never appears in its slash menu
(SCOPE-14). `/tour` and `/sandbox` sit in the same menu because the composer has one menu; sandboxes are brick 6.

## Screens

- `chat` — entry point. Actions is a collapsed pane row in the conversation (same pattern as the splash pane):
  play icon, "Actions", a badge with the latest run (`CI · 2m`), expand affordance. Why: everything is a chat
  (VL-17); the pane row is how the feature exists without opening it.
- `list` — the pane open inline: one row per registered action — status dot, name, last-run time. Click a row (or
  Tab + Enter) for its runs. Why: GitHub's workflow list, compressed to chat width.
- `max` — the pane maximized (VL-17): GitHub's two columns — actions on the left (active row pinned with the brand
  inset), the selected action's runs on the right with a `Run` button. Why: copying GitHub (VL-18) beats inventing;
  maximize is where wide layouts live.
- `runs` — one action's runs, inline: status dot, run title, `branch · sha · actor · when`, duration on the right.
  `Run` in the bar dispatches a run (contributor and up; hidden below). `‹ Actions` goes back. Why: rows instead of a
  table so nothing wraps on a phone.
- `trace` — a live run, maximized: steps on the left (`sui-plan-steps` dots: done / pulsing current / queued), the
  current step's log streaming in a terminal on the right, `Running` badge and `Cancel` in the bar. Why: GitHub's
  jobs+log split; the plan-steps component already means "a flow's steps" in this design system.
- `done` — a finished run: `Passed · 1m 4s` badge, all steps green, final log, `Re-run` in the bar. A failed run is
  the same with `Failed` (destructive badge) and the failed step's log shown first.
- `agent` — a run the agent started: normal assistant message ("Checking — I started CI on `effect-41`.") followed by
  a live run card: name, badge, mini steps, `branch · sha · elapsed`. The card opens the trace. Why: the agent acts
  through the same actions and shows its work in the conversation, instead of giving instructions.
- `slash-viewer` … `slash-maintainer` — the composer with `/` typed; the menu (`sui-completion-list`, the existing
  completion component) lists exactly the commands that role may run. Why one menu item per line with a short detail:
  the completion component's established label + detail format.
- `empty` — an action that never ran: `sui-empty`, "No runs yet", `Run` in the bar does the first one.
- `loading` — `sui-skeleton` rows in the pane. No spinner.
- `error` — `sui-alert-destructive` "Couldn't load runs" + `Retry` link. Same shape as the app's Reconnect.

## Slash menu by role (decided)

| Role | Sees |
| --- | --- |
| viewer (signed out) | `/tour` |
| new | + `/sandbox` (60 min) |
| community | + `/sandbox` (240 min), `/triage`, `/docs` |
| contributor | + `/sandbox` (600 min), `/ci` |
| maintainer | + `/sandbox` (2,000 min), `/release` |

A viewer can watch every run but start none — `/tour` only, because the tour is the one thing the splash already
offers signed-out. Running anything stateful needs an identity; sign-in is brick 2.

## Interactions and keyboard

- `/` in the composer opens the menu; typing filters; `↑`/`↓` move the highlight; `⏎` runs the highlighted command;
  `Esc` closes. This is the completion component's existing contract.
- A run started by button or command appears as the agent's run card in the chat (same as `agent`) — one place every
  run shows up, whoever started it.
- Pane rows and run rows are buttons: Tab to them, Enter opens. The pane bar's maximize toggle is a button; `Esc`
  minimizes a maximized pane.
- `Cancel` / `Re-run` / `Run` are real buttons in the pane bar; hidden when the role may not use them.
- Live updates: the run card, the runs list and the trace share one run record; a running dot pulses, elapsed counts
  (`sui-plan-step-elapsed`, tabular numbers).

## Components

Reused from the live app: `vl-pane`, `vl-docs` pane (bar, toggle, maximized), `sui-completion-*` (the slash menu),
`sui-plan-steps` (run steps), `sui-row-button` (action and run rows), `sui-badge` + `sui-status-dot` (run states),
`sui-button` variants, `sui-empty`, `sui-skeleton`, `sui-alert`, chat bubbles and composer.

New (`vl-act-*`, `vl-run*`, `vl-term*`, in `index.html`): the pane body grid, the maximized two-column grid, the run
row, the steps+log trace grid, the terminal (bar + mono body), the run card. All built from the app's tokens.

## Copy (every visible string)

Pane: `Actions`, `CI · 2m`. Bars: `Actions`, `‹ Actions / CI`, `‹ CI / Verify Effect 4.1.1`. Buttons: `Run`,
`Cancel`, `Re-run`, `Retry`. Badges: `Running`, `Passed · 1m 4s`, `Failed`. Steps: `Checkout`, `Install`, `Verify`,
`Lint`, `Test`, `Build`. Empty: `No runs yet`. Error: `Couldn't load runs`. Menu: the command labels and details in
the table above. Agent: `Checking — I started CI on effect-41.` Run meta: `main · 4c2f9a1 · agent · 2m ago`.

## Choices, one line each

- Actions live in a chat pane, not a separate page — VL-17, and the agent's runs need to live where the talk is.
- GitHub's exact layouts for list/runs/trace — VL-18; nobody learns anything new.
- Slash menu is the existing completion component over the composer — one menu, role-filtered, zero new UI.
- `Run` is a button for people and a command for everyone — same dispatch either way; the agent uses the same action.
- Status is dots and short badges, not sentences — minimal text is law.
- The trace maximizes by default — a log needs width; the chat column is too narrow at 720px.
- No marketing media in these screens — they're work surfaces; the media stay on the splash (VL-19 covers "throughout"
  via the collapsed splash pane beside every conversation).
