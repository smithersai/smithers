# Smithers TUI v2 — Design Document

Version: 1.0  
Status: Proposed

## 1. Design objective

Smithers TUI v2 should feel like a serious operator console, not a boxed-in chatbot and not a dashboard from a proof of concept.

The product is terminal-native. That means its design language should prioritize:

- density without clutter
- clarity over decoration
- motion with restraint
- strong focus affordances
- minimal border nesting
- excellent keyboard discoverability
- stable layouts under streaming updates

## 2. Design principles

### 2.1 One shell, many workflows
The user should feel like they are in one durable control plane, not jumping between disconnected screens.

### 2.2 Feed over bubbles
The center of the UI is a structured activity feed. Terminal space is expensive. Use vertical rhythm, source labels, and cards only when necessary.

### 2.3 Status should be glanceable
Long-running work must announce itself with compact badges, not require opening a separate screen.

### 2.4 Focus is sacred
At any moment, the user should know:
- which region has focus
- what `Enter` does
- what `Esc` does
- what the next likely action is

### 2.5 Borders are a tax
Use borders for shell segmentation and overlays. Avoid nested boxes for every message.

### 2.6 Color is semantic, not decorative
Use color to indicate focus, state, warnings, approvals, and failures. Do not flood the screen with accent colors.

### 2.7 Every dense view needs an escape hatch
Collapsed blocks, filters, inspector tabs, and external viewers are how the TUI stays powerful without becoming visually noisy.

## 3. Visual language

## 3.1 Overall feel

Target feeling:
- calm
- competent
- dark-by-default
- terminal-respecting
- slightly industrial
- less playful than chat products
- more precise than a generic dashboard

The design should borrow:
- command palette confidence from Amp
- multi-workspace awareness from cmux
- slash-command and attachment fluency from OpenCode
- session tree and queueing ideas from pi
- compact tool rendering from oh-my-pi
- contextual search and help from lazygit/k9s

## 3.2 Layout density rules

- Prefer 1-row headers over boxed titles.
- Prefer whitespace separators over heavy frames.
- Prefer a single selected row highlight and accent marker over full-background painting.
- Limit nested bordered containers to overlays, diff viewers, and inspector panels.
- Keep the main shell to three visible columns max.

## 3.3 Theme tokens

Do not hardcode one neon palette. Use semantic tokens.

Core tokens:

| Token | Description/Usage |
|---|---|
| `bg` | Primary application background |
| `surface` | Secondary background for rails |
| `surfaceMuted` | Tertiary background |
| `border` | Used sparingly for structural separation |
| `text` | Primary readable text |
| `textMuted` | Less prominent text |
| `accent` | Main brand color for active items |
| `focus` | Specific highlight for keyboard focus |
| `success` | Reserved strictly for completion |
| `warning` | Reserved for pending approvals |
| `error` | Reserved for hard failures |
| `info` | Context or metadata highlighting |
| `selection` | Highlight for user-selected rows |

> [!TIP]
> **Default theme guidance:**
> - terminal-compatible dark background
> - cool accent for active/focus
> - green only for success
> - amber only for approvals/warnings
> - red reserved for failures/destructive actions

## 3.4 Typography and glyph rules

- Use plain monospace text.
- Avoid emoji; width handling is inconsistent and makes the UI look consumer-ish.
- Use ASCII or stable Unicode glyphs with fallback.
- Provider markers should be textual, not icon-font dependent.

| Glyph | Meaning |
|---|---|
| `[SM]` | Smithers |
| `[CC]` | Claude Code |
| `[CX]` | Codex |
| `[GM]` | Gemini |
| `[AI]` | AI SDK |
| `◐` | running |
| `!` | attention |
| `✓` | success |
| `×` | failure |
| `…` | truncated |

## 4. Shell layout

## 4.1 Wide layout (>= 140 cols)

- Left rail: 24 cols
- Center feed: flexible
- Right inspector: 36–42 cols
- Composer: 3–6 rows
- Top line: 1 row
- Bottom line: 1 row

Use wide layout for the ideal experience.

## 4.2 Standard layout (100–139 cols)

- Left rail remains visible
- Right inspector narrows to 28–32 cols
- Less metadata in workspace rows
- Feed cards become more compact

## 4.3 Compact layout (80–99 cols)

- Left rail remains
- Right inspector becomes toggleable overlay
- Feed becomes single dominant pane
- Composer pills wrap more aggressively

## 4.4 Narrow layout (< 80 cols) / "Quiet Harbor" SSH Mode

- Single-pane mode
- Workspace switcher becomes overlay
- Inspector is modal
- Utilities open fullscreen
- **"Quiet Harbor" Activation:** When running via SSH or a heavily constrained TTY, the UI automatically strips away complex borders, disables heavy animations/spinners, limits right-rail inspector expansions, and optimizes entirely for pure streaming speed and readability.

This mode is not just a fallback; it's explicitly engineered for server-side troubleshooting and low-bandwidth connections.

## 5. Shell anatomy

## 5.1 Top line

Content:
- app name
- repo / cwd short name
- current workspace title
- current provider profile
- mode (`operator` / `plan` / `direct`)
- active runs count
- approval count
- compact hint: `Ctrl+O actions`

Rules:
- no border
- use separators
- show only one accent region: active mode/profile
- approvals/failures must be visually obvious

Example:
```text
Smithers  repo: api  workspace: auth-fix  profile: Claude+SDK  mode: operator  2 runs  1 approval   Ctrl+O actions
```

## 5.2 Left workspace rail

Purpose:
- switch tasks quickly
- surface attention at a glance
- support multi-workspace operation like cmux, but in Smithers terms

Each workspace row contains:
- leading state marker
- title
- provider tag
- unread badge
- optional secondary line with repo/summary

Visual rules:
- active workspace has a left accent bar
- unread is a small badge, not a bright full-row color
- failed and approval-needed states override unread styling
- no border between every row
- progressive disclosure: in standard widths, hide provider tag until focused; compound status icons natively convey priority without noise.

Example:
```text
▌ auth refactor        [CC]  ◐1
  docs sync            [AI]   ✓
! pr review            [SM]  A1
  incident triage      [GM]   ×
```

## 5.3 Center feed

Purpose:
- unify conversation and orchestration
- show the story of the work

Structure:
- timestamp column
- source label column
- body area
- optional metadata line
- selected item subtle background or inverted label

Feed item types use different affordances:

### User item
- compact
- bold source label `You`
- text body only unless attachments exist
- attachments shown as pills on metadata line

### Assistant item
- source label `Smithers`
- markdown allowed
- code blocks with minimal framing
- long lists wrapped cleanly
- summary line shown when item is collapsed

### Tool item
- collapsed by default when verbose
- grouped when repeated
- one-line summary:
  - tool name
  - target
  - status
  - duration
- expandable body for stdout/stderr/diff

### Run item
- always compact summary visible
- includes workflow name, run id, step, elapsed, progress
- expandable into timeline preview

### Approval item
- detaches from the scrolling feed
- docks as a mandatory Action Bar above the composer
- prominent warning styling and explicit action hints
- must not be visually buried or pushed off-screen by streaming output

### Artifact item
- file name
- type
- source workflow/run
- open / diff / copy affordances

### Error item
- red label only
- compact human summary first
- stack/details collapsed underneath

## 5.4 Right inspector

The inspector is the precision surface. It is dynamic, not tab-driven. 

Behavior:
- rather than persistent empty tabs (Run, Diff, Context), the pane's title and contents morph exactly to the selection
- breadcrumb title pattern: `Inspector • Run a93f` or `Inspector • src/auth.ts`
- selected feed item acts as the tab bar
- inspector must be useful even while the feed keeps streaming

> [!TIP]
> **Braille/ASCII DAG Visualizations:** When inspecting complex workflow runs, utilize terminal Braille patterns (`⠋`, `⠙`, `⠹`) and block characters to render a beautiful, GitHub-Actions-style visual dependency graph. Do not rely entirely on flat text lists for deep orchestration visibility.

Example states:
- selecting a run item shows run graph + status
- selecting a workflow mention shows schema + last runs
- selecting an attachment shows preview + token estimate
- selecting a tool block shows raw output + copy/save

## 5.5 Composer

The composer is a small command desk, not a giant chat box.

Structure:
- optional first line for attachment and mode pills
- main text area
- bottom metadata line for context/token budget and send hints

Rules:
- auto-grow up to 6 rows, then scroll internally
- preserve draft while switching workspaces
- show inline chips for unified `@` context and `#` workflow mentions
- show current queue state if follow-up exists
- show provider/profile hint quietly, not loudly
- **Visual Token Budget Bar:** Context budgets (`18k ctx`) should be accompanied by a tactile mini-bar `[████████░░]` that fills up as the user attaches files via `@`, shifting from green to amber to red as they approach the context limit.

Example:
```text
[#review-pr] [@src/auth.ts] [@README.md] [+2]
Build a reusable auth-fix workflow and run it against current diff.
budget 18k ctx    Enter send    Alt+Enter queue    Ctrl+G editor
```

## 6. ASCII mockups

## 6.1 Main workspace

```text
Smithers  repo: api  workspace: auth-refactor  profile: Claude+SDK  mode: operator  2 runs  1 approval   Ctrl+O actions

▌ auth refactor         [CC]  ◐1         12:41  You       Build a reusable Smithers workflow for auth fixes.
  docs sync             [AI]   ✓         12:41  Smithers  Plan:
! pr review             [SM]  A1                   - inspect existing .smithers/workflows
  incident triage       [GM]   ×                   - factor shared retry and review steps
                                                   - launch #auth-fix over current diff

                                               12:42  Run       auth-fix  a93f  running  validate -> patch  3/7
                                               12:43  Tool      smithers.workflows.read  .smithers/workflows/review-pr.tsx  18ms
                                               12:44  Artifact  .smithers/workflows/auth-fix.tsx
                                                
 [ Approval Action Bar ] Push generated patch to workspace branch?    [Enter] open   [a] approve   [d] deny

                                                               ┌ Inspector: Run ───────────────────────┐
                                                               │ auth-fix / a93f                        │
                                                               │ step: patch            elapsed: 03:12  │
                                                               │ provider: Claude Code                  │
                                                               │ retries: 0              cost: $0.41    │
                                                               │ nodes                                   │
                                                               │  ✓ inspect                              │
                                                               │  ✓ design                               │
                                                               │  ◐ patch                                │
                                                               │  ○ validate                             │
                                                               └────────────────────────────────────────┘

[#auth-fix] [@src/auth.ts] [@README.md]  Build it to be reusable, not one-off.
budget 18k ctx   Enter send   Alt+Enter queue   Ctrl+G editor
```

## 6.2 Command palette

```text
┌ Actions ──────────────────────────────────────────────────────────────────────┐
│ > run workflow                                                               │
│                                                                               │
│ Smithers                                                                      │
│   Run workflow...                              /run                           │
│   Open workflow catalog                        /workflows                     │
│   Show approvals                               /approvals                     │
│   Show live runs                               /runs                          │
│                                                                               │
│ Workspace                                                                     │
│   New workspace                               /new                            │
│   Resume workspace                            /resume                         │
│   Open session tree                           /tree                           │
│                                                                               │
│ Provider                                                                      │
│   Switch profile                               /provider                      │
│   Switch mode                                  /mode                          │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 6.3 Workflow picker (`#`)

```text
┌ Workflows ────────────────────────────────────────────────────────────────────┐
│ > review-pr            PR review against current diff         last ✓ 4m       │
│   auth-fix             Reusable auth remediation flow         last × 1h       │
│   docs-refresh         Refresh docs and changelog            last ✓ 1d       │
│                                                                               │
│ review-pr                                                                    │
│   input: { target?: string, diff?: boolean, push?: boolean }                 │
│   providers: SDK analyze -> Claude Code patch -> SDK summary                 │
│   tags: review, reusable, repo                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 6.4 Large paste guard

```text
┌ Large paste detected ─────────────────────────────────────────────────────────┐
│ 1,842 lines / 412 KB                                                         │
│                                                                              │
│ How should Smithers ingest this content?                                     │
│                                                                              │
│  > Attach as file reference                                                  │
│    Paste inline into composer                                                │
│    Summarize and attach                                                      │
│    Cancel                                                                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 6.5 Approval dialog

```text
┌ Approval required ────────────────────────────────────────────────────────────┐
│ Workflow: auth-fix                                                            │
│ Run: a93f                                                                     │
│ Action: git push origin smithers/auth-fix                                     │
│ Reason: publish generated patch for PR review                                 │
│                                                                               │
│ [A] Approve once   [S] Approve for workspace   [D] Deny   [Esc] Cancel        │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 7. Interaction design

## 7.1 Focus model

There are four core focusable regions:
- workspace rail
- feed
- inspector
- composer

Rules:
- `Tab` advances focus
- `Shift+Tab` reverses focus
- focused region always shows a clear visual marker
- overlays trap focus until dismissed
- on send, focus stays in composer by default
- on new approval or failure, the workspace rail gets attention but does not steal focus

## 7.2 Selection model

The feed always has a current selection, even while auto-scrolling.

Rules:
- selection can follow newest item while feed is “live”
- manual movement freezes auto-follow
- pressing `End` or reselecting “latest” resumes follow mode
- right inspector always reflects the current selection

## 7.3 Collapse model

Default collapse rules:
- tool output over N lines collapsed
- logs collapsed
- large diffs summarized
- assistant summaries can collapse long blocks

Expand affordances:
- `Space` toggle
- `Enter` open full viewer when the item has a deep surface

## 7.4 Search and filter

- `/` searches within focused non-composer pane
- palette searches globally
- workflow and session pickers fuzzy-match aggressively
- matched text highlighted subtly
- `Esc` clears filter and returns to prior selection

## 7.5 Auto-scroll behavior

- new streaming content follows unless user moved away
- feed header shows `LIVE` vs `PAUSED`
- on paused state, status line hints how to return to live tail

## 7.6 Notifications and attention

States:
- unread
- waiting
- approval
- failed
- complete

Visual encoding:
- approval: amber badge and leading `!`
- failed: red marker
- unread complete: muted badge
- running: spinner marker
- selected workspace with unread uses badge, not flashing color

## 7.7 Empty states

- A new workspace never starts uniquely blank.
- Display a non-persistent "Welcome Bento Board" inside the feed space showing:
  - Repo git status
  - 3 suggested actions based on repository heuristics (e.g. found `package.json` -> suggest `#test`)
- The board naturally scrolls away when the first feed item occurs.

## 8. Component specifications

## 8.1 Workspace row
Height:
- compact: 1 row
- expanded: 2 rows in wide mode only

Fields:
- marker
- title
- provider
- status
- secondary summary

## 8.2 Feed source label
Examples:
- `You`
- `Smithers`
- `Run`
- `Tool`
- `Approval`
- `Artifact`
- `Error`

Rules:
- fixed width
- source color stable by type
- selected row may invert source label

## 8.3 Tool block
Collapsed line:
- `Tool smithers.runs.inspect a93f ✓ 42ms`

Expanded:
- header
- args summary
- output preview
- open raw / save / copy

## 8.4 Attachment pill
Fields:
- label
- type glyph
- remove affordance

Styles:
- neutral by default
- warning color for large/binary attachments
- active selection in composer highlight

## 8.5 Progress bar
Use simple block characters:
- `██████░░░░ 6/10`

Rules:
- always pair with numbers
- do not rely on color only

## 8.6 Status line
Contents vary by focus.

Examples:
- composer focused: `Enter send  Alt+Enter queue  Ctrl+G editor  Ctrl+O actions`
- feed focused: `Enter open  Space expand  / search  . actions`
- workspace rail focused: `Enter switch  n new  . actions`

## 9. Theming

Built-in themes:
- Terminal
- Ghost
- Indigo
- Amber
- High Contrast

Theme requirements:
- semantic tokens only
- respect terminal background when possible
- user-overridable
- no dependence on truecolor for readability

## 10. Accessibility

- state conveyed with text and glyphs, not color only
- approval and failure never share the same shape
- focus indicator visible even in monochrome themes
- animations limited and disable-able
- keyboard help searchable
- large diff/log viewers support copy and pager export

## 11. Design decisions to reject

Reject:
- full-width bordered chat bubbles for every message
- top-level tab bars as the main navigation
- hidden destructive single-letter commands
- rainbow palettes
- modal stacks with unclear escape behavior
- content that jumps horizontally while streaming
- overly clever provider icons dependent on patched fonts
