# Sandboxes with minutes (VL-25)

A sandbox is a throwaway machine in the chat: a terminal pane that maximizes (VL-17), started by a button, by
`/sandbox`, or by the agent. Minutes are a monthly allowance per role (VL-21). Mock mode renders every screen here
with the Mock pill (VL-13).

Open `index.html`; the top bar switches screens. `?chrome=0` hides the demo bar (used for the screenshots).

## Minutes by role (decided)

| Role | Minutes / month |
| --- | --- |
| Viewer (signed out) | — |
| New | 60 |
| Community | 240 |
| Contributor | 600 |
| Maintainer | 2,000 |

Minutes reset monthly; only a running sandbox burns them. At 10 left the badge turns warning and a system message
says so in the chat; at 0 the sandbox stops, the badge goes destructive, and a system message records it. A stopped
sandbox's files stay until it is started again or the month resets. The agent spends the person's minutes — its work
runs in the person's sandbox, so no separate allowance exists to game.

## Screens

- `chat` — entry point: the Sandboxes pane collapsed to a row — terminal icon, "Sandboxes", a badge with the minutes
  left (`48 min`). Why: the allowance matters before the pane is open, like GitHub showing your codespaces count.
- `pane` — the pane open inline: a KPI (`48`, `min left of 600`, progress bar, `Resets monthly`), `New sandbox`,
  and a row per sandbox — pulsing dot when running, name (`sturdy-goggles`), state badge. Why: number first, action
  beside it, then the things themselves.
- `max` — the pane maximized: the same plus the allowances table by role. Why: the table is reference data; it earns
  the maximized surface, not the chat-width one.
- `starting` — a new sandbox provisioning: name, `Starting`, an indeterminate progress bar. No spinner.
- `running` — the sandbox live: bar with its name, a `48 min left` badge, `Stop`, maximize; the terminal below,
  focusable, prompt in brand violet. The chat around it shows how it started: `/sandbox` → "Started sturdy-goggles."
- `agent` — the agent working in it: its message ("Running it in a sandbox.") and the terminal showing its commands,
  first line `# vibelang agent`. Why: same pane, same minutes, whoever drives — the agent acts instead of
  instructing.
- `low` — 10 minutes left: warning badge, system bubble "9 minutes left". One warning, not a countdown nag.
- `zero` — out of minutes: system bubble "Out of minutes — sturdy-goggles stopped", destructive `0 min` badge,
  terminal dimmed and frozen, `Stop` gone (nothing to stop). `New sandbox` is disabled in the pane.
- `stopped` — stopped with minutes remaining: the row shows a `Start` button (ghost). Stopping is `Stop` in the
  running pane's bar — one destructive button where the terminal is.
- `viewer` — signed out: `sui-empty`, "Sign in to start a sandbox", `Sign in`. Sandboxes cost money; no anonymous
  compute.
- `error` — start failed: `sui-alert-destructive` "Couldn't start a sandbox" + `Retry`.

## Interactions and keyboard

- `New sandbox` button or `/sandbox` in the composer (the actions design owns the shared slash menu; it lists
  `/sandbox` with the role's minutes as the detail).
- A sandbox row is a button: Tab + Enter opens its terminal pane. `Stop` and `Start` are buttons in Tab order.
- The terminal takes focus (visible ring); type into it when focused. The bar's maximize toggle goes full-width;
  `Esc` minimizes.
- While it runs, the badge counts down and the KPI matches; `Stop` ends it at once and the row flips to `Stopped`
  with `Start`.

## Components

Reused from the live app: `vl-pane` (collapsed row), `vl-docs` pane (bar, toggle, maximized), `sui-kpi` (minutes),
`sui-progress` (allowance bar and the indeterminate starting bar), `sui-row-button` (sandbox rows), `sui-badge` +
`sui-status-dot` (state and minutes), `sui-table` card (allowances), `sui-empty` (viewer), `sui-alert` (error), chat
bubbles including the system bubble (warnings).

New (`vl-sb-*`, `vl-term*`, in `index.html`): the pane body grid, the KPI + button head, the sandbox row, the
terminal (mono body on `--code-bg`, brand prompt, dimmed when stopped). All built from the app's tokens.

## Copy (every visible string)

Panes: `Sandboxes`, `sturdy-goggles`, `quiet-otter`. KPI: `48`, `min left of 600`, `Resets monthly`. Table: `Role`,
`Minutes`, `Viewer`, `New`, `Community`, `Contributor`, `Maintainer`, `—`, `Minutes reset monthly`. Buttons: `New
sandbox`, `Stop`, `Start`, `Sign in`, `Retry`. Badges: `48 min`, `Running`, `Stopped`, `48 min left`, `9 min left`,
`0 min`. States: `Starting`. System: `9 minutes left`, `Out of minutes — sturdy-goggles stopped`. Viewer: `Sign in to
start a sandbox`. Error: `Couldn't start a sandbox`. Agent: `Started sturdy-goggles.`, `Running it in a sandbox.`

## Choices, one line each

- Sandboxes live in a chat pane, not a dashboard — VL-17; the terminal is content in the conversation.
- Minutes are a number and a bar, not a paragraph — show a count, not a sentence (minimal text).
- Monthly allowance, reset on the 1st — GitHub Codespaces' model (VL-18); predictable, no rollover math to explain.
- Names are Codespaces-style (`sturdy-goggles`) — throwaway machines shouldn't need naming (VL-18).
- One warning at 10 minutes and one message at 0 — enough to act, never a nag.
- At 0 the work stays and the machine stops — minutes buy compute, not storage; deleting work would punish the
  curious.
- The agent's terminal is the same pane with its name on the first line — one component, no agent-only UI.
- No marketing media in these screens — work surfaces stay bare; the media live on the splash (VL-19).
