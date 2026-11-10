# Desktop app — design notes

Brick 7, VL-6: the same app in a native Electrobun window; local models and the local file system are
the only differences. So the design changes only three things: a native titlebar, a model picker that
includes local models, and a folder chip that scopes the agent to a local directory. Everything else —
the chat, the panes, ⌘K, the Mock pill (VL-13 holds here too) — is the web app unchanged.

`index.html` is self-contained (live stylesheet inlined, dark only, VL-27). The dashed bar on top is
the review harness, not app UI; `#<screen>` deep-links a state (`index.html#models`).

## Screens and states

| Screen | State |
| --- | --- |
| Local work | The main screen: the agent editing local files, seen in the chat. |
| Pick a model | The composer's model picker open: downloaded local models, cloud models, Manage models…. |
| Models | The manager pane: Local (downloaded / downloading / available) and Cloud (sign-in state). |
| No folder | Empty state before a folder is opened; the composer still answers questions. |
| Offline | No network: Offline badge in the titlebar, composer status says local models only. |
| Model error | The chosen model can't load; the composer disables until another is chosen. |
| Loading | Model loading: skeleton transcript, disabled send, status names the model. |

Roles do not vary: the desktop window is the person's own machine, so there is nothing to gate.
Sign-in state matters only for cloud models, shown per model in the manager.

## Interactions and keyboard paths

- **Open folder**: the Open folder button or ⌘O opens the native folder picker (Electrobun's, not
  styled by us). The picked folder becomes the composer's folder chip and a system message
  (`Opened ~/code/river · 214 files`); the titlebar takes the path.
- **Close folder**: the chip's ×; the chat returns to the No folder state.
- **Pick a model**: the model chip in the composer opens the picker above it; ↑/↓ move, Enter chooses,
  Esc closes. `Manage models…` opens the Models pane.
- **Models pane**: Download starts a download (row shows the progress bar and percent); Delete removes
  a downloaded model; Sign in opens the provider's OAuth flow for a cloud model. − minimizes back to
  the chat.
- **Local work**: the agent's file operations appear as tool calls (`fs.search`, `fs.edit`), each
  expandable (Enter/Space on the trigger); the edit shows its diff inline and the changed-files list
  follows. Nothing here is a new action — the agent reads and edits through the same tools, pointed at
  the local disk.
- **Error recovery**: Choose a model opens the Models pane; until then the composer is disabled and
  says why.

## Components

Reused from the live app: `vl-top`, `vl-pill` (Mock), `vl-nav-link`, `vl-docs` pane chrome (the Models
pane), `sui-chat-*` (transcript, bubbles, docked composer), `sui-toolcall` (fs.search / fs.edit),
`sui-diff` (a local edit), `sui-commit-files` (the changed-files list), `sui-table` card (the model
manager), `sui-progress` (downloading), `sui-badge-*`, `sui-status-dot`, `sui-provider-badge`,
`sui-model-badge`, `sui-model-sel-*` + `sui-select-*` (the picker), `sui-empty`, `sui-alert`,
`sui-skeleton`, `sui-section-header`, `vl-kbd`.

New (feature CSS, `dt-` prefix): `dt-titlebar` + `dt-lights` (the Electrobun window chrome, a drag
region live), `dt-chip` (folder and model chips in the composer toolbar), `dt-modelsel`/`dt-modelsel-pop`
(the picker's open state anchored to the chip), `dt-pane`/`dt-pane-body` (pane content instead of the
docs iframe), `dt-model-row`.

## Copy (every visible string)

- Titlebar: `VibeLang · ~/code/river` (or `VibeLang`); badges `Qwen3 8B local`, `Offline`.
- System message: `Opened ~/code/river · 214 files`.
- Agent label: `VibeLang agent · Qwen3 8B · local`; reply `Renamed in 6 files.`
- Tool calls: `fs.search · "startServer"`, `9 matches · 6 files`; `fs.edit · src/server.vibe`.
- Composer: placeholder `Describe what to change in ~/code/river` (or `Ask about VibeLang` with no
  folder); statuses `Offline · local models only`, `No model loaded`, `Loading Qwen3 8B…`.
- Picker: `Local`, `Cloud`, `4.9 GB · downloaded`, `Manage models…`.
- Models pane: `Models`, `Local`, `6.0 GB free`, `Downloaded`, `Not downloaded`, `Delete`, `Download`,
  `Cloud`, `Signed in`, `Not signed in`, `Sign in`.
- Empty: `No folder open`, `Open folder ⌘O`.
- Error: `Qwen3 8B couldn't load.`, `Not enough free memory.`, `Choose a model`.

## Choices, one line each

- **Only three additions** — VL-6 says local models and the local file system are the only difference,
  so the titlebar, the model picker and the folder chip are the whole design.
- **The titlebar carries the model badge and the folder path** — what the window is and where it works,
  visible without opening anything.
- **Model choice lives in the composer, management in a pane** — picking is per-conversation and
  frequent; downloading gigabytes is rare and wants a page (VL-17 pane, maximizable).
- **Local first in the picker** — the desktop app's reason to exist is local models; cloud is the
  fallback section.
- **The folder is a chip, not a mode** — the app still answers questions with no folder open; the chip's
  × is the whole off-ramp.
- **Local work shows as ordinary tool calls and diffs** — anything the agent does is the same action a
  person could do; no special "local" rendering was invented.
- **Offline is a badge plus a composer status, not a screen** — the app keeps working on local models;
  blocking the UI would be wrong.
- **A model that can't load disables the composer** — sending into a dead model would fail later and
  stranger; the alert names the fix and its button opens the manager.
- **The native folder picker is not mocked** — Electrobun owns it; we design the entry point (button,
  ⌘O) and the result (chip, system message, titlebar path), not the OS dialog.
- **Mock pill stays** — VL-13's invariant covers this surface too; mock and local-model are orthogonal.
