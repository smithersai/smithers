// Pure state and stop catalog for the Smithers interactive tour plugin.
// Framework-free so every surface (web, TUI, tests) shares the same tour model.

/** One interactive option a visitor can try inside a tour stop. */
export interface TourChoice {
  readonly id: string
  readonly label: string
  readonly status: string
  readonly preview: string
  readonly badge?: string
}

/** One stage in a durable-flow preview strip. */
export interface TourStage {
  readonly label: string
  readonly status: "completed" | "running" | "pending"
}

/** One stop of the guided tour. */
export interface TourStop {
  readonly id: string
  readonly eyebrow: string
  readonly title: string
  readonly subtitle: string
  readonly shortcut: string
  readonly stages?: ReadonlyArray<TourStage>
  readonly choices: ReadonlyArray<TourChoice>
  readonly action?: { readonly label: string; readonly to: string }
}

/** Where the visitor stands in the tour and which preview option they selected per stop. */
export interface TourState {
  readonly index: number
  readonly total: number
  readonly stop: TourStop
  readonly percent: number
  readonly hasPrevious: boolean
  readonly hasNext: boolean
  readonly chosen: Readonly<Record<string, string>>
  readonly activeChoice: TourChoice
}

/** The tour's view id. */
export const VIEW = "tour/tour"

/** The eight guided stops covering Smithers end to end. */
export const STOPS: ReadonlyArray<TourStop> = [
  {
    id: "chat",
    eyebrow: "01 · Conversation",
    title: "Chat & ⌘K anywhere",
    subtitle: "Ask in plain language or press ⌘K for slash commands. Every answer streams live and stays synced across tabs.",
    shortcut: "⌘K",
    choices: [
      {
        id: "ask-flows",
        label: "What can Smithers automate?",
        badge: "Agent",
        status: "Answered",
        preview: "Draft TODOs from issues, open branch sandboxes, run tests, open pull requests, and monitor your merge queue — all as durable flows.",
      },
      {
        id: "slash-tour",
        label: "/theme dark",
        badge: "Command",
        status: "Applied",
        preview: "Slash commands run typed flows immediately — /theme, /bug, /queue, /factory, and your own personal flows.",
      },
    ],
    action: { label: "Try interactive demo", to: "/app?agent=mock" },
  },
  {
    id: "flows",
    eyebrow: "02 · Durability",
    title: "Every action is a durable flow",
    subtitle: "Steps checkpoint to SQLite in your browser or Cloudflare Durable Objects on the server — reloads and crashes never lose work.",
    shortcut: "/flows",
    stages: [
      { label: "plan", status: "completed" },
      { label: "sandbox", status: "completed" },
      { label: "verify", status: "running" },
      { label: "publish", status: "pending" },
    ],
    choices: [
      {
        id: "step-journal",
        label: "Inspect journal",
        badge: "Run #42",
        status: "Running",
        preview: "Step 3/4 (verify) · 2 attempts · 0 secret leaks · deterministic replay ready from step 1.",
      },
      {
        id: "step-retry",
        label: "Retry from failed step",
        badge: "Resumable",
        status: "Completed",
        preview: "Earlier passed steps reuse their cached receipts; only the failed step runs again.",
      },
    ],
    action: { label: "Open Flows", to: "/app/flows" },
  },
  {
    id: "code",
    eyebrow: "03 · Repository",
    title: "Code, file tabs & repository home",
    subtitle: "Browse any connected GitHub repository, keep multiple files open in tabs, and ask the agent about exact lines.",
    shortcut: "⌘P",
    choices: [
      {
        id: "file-flow",
        label: "flow.ts",
        badge: "Tab 1",
        status: "Open",
        preview: 'export default Flow.make("triage", { steps: [classify, draftTodo, notify] })',
      },
      {
        id: "file-readme",
        label: "README.md",
        badge: "Tab 2",
        status: "Editable",
        preview: "Markdown files edit in place on your branch with live multiplayer sync.",
      },
    ],
  },
  {
    id: "stack",
    eyebrow: "04 · TODO Stack",
    title: "Issues become a stacked queue",
    subtitle: "People decide what matters and in what order; agents work through stacked TODOs with isolated branches and PRs.",
    shortcut: "T1 → T2",
    stages: [
      { label: "T1 · Merged", status: "completed" },
      { label: "T2 · In review", status: "completed" },
      { label: "T3 · Working", status: "running" },
      { label: "T4 · Queued", status: "pending" },
    ],
    choices: [
      {
        id: "todo-draft",
        label: "Draft T4 from issue #128",
        badge: "Draft",
        status: "Ready",
        preview: "Title: Add custom domain routing · Base: After T3 · Acceptance: Host header routes to repository app.",
      },
      {
        id: "todo-watch",
        label: "Watch T3 live",
        badge: "Cloud run",
        status: "Working",
        preview: "Streaming agent transcript and test output from Cloudflare sandbox · steer live without cancelling.",
      },
    ],
  },
  {
    id: "sandbox",
    eyebrow: "05 · Branch Workspace",
    title: "Sandboxes, terminal & co-editing",
    subtitle: "Open any branch to get a real Linux sandbox, live shell terminal, diff view, and multiplayer prompt & file editing.",
    shortcut: "?terminal",
    choices: [
      {
        id: "sandbox-term",
        label: "Terminal",
        badge: "Container",
        status: "Connected",
        preview: "$ pnpm test\n✓ 42 tests passed in 1.8s — ready to publish branch.",
      },
      {
        id: "sandbox-coedit",
        label: "Co-edit",
        badge: "2 people",
        status: "Synced",
        preview: "Shared CRDT document and prompt with live collaborator cursors and instant publish to GitHub.",
      },
    ],
  },
  {
    id: "queue",
    eyebrow: "06 · Human in the Loop",
    title: "Keyboard-first Review Queue",
    subtitle: "Every agent question, approval gate, and review waits in one full-screen queue — triage at speed with single keys.",
    shortcut: "g q",
    choices: [
      {
        id: "queue-approve",
        label: "Approve (a)",
        badge: "Approved",
        status: "Sent",
        preview: "Approval recorded with your identity. The parked durable flow resumes immediately.",
      },
      {
        id: "queue-changes",
        label: "Request changes (r)",
        badge: "Changes",
        status: "Sent",
        preview: "Feedback attached to the waiting step; the agent revises without restarting earlier steps.",
      },
    ],
    action: { label: "Open Queue", to: "/app/queue" },
  },
  {
    id: "factory",
    eyebrow: "07 · Autonomous Operations",
    title: "Factory lanes & fleet oversight",
    subtitle: "Monitor parallel agent lanes, answer open design questions, inspect spec reviews, and watch the merge queue land.",
    shortcut: "/factory",
    stages: [
      { label: "Design Qs", status: "completed" },
      { label: "Spec review", status: "completed" },
      { label: "Impl lanes", status: "running" },
      { label: "Merge queue", status: "pending" },
    ],
    choices: [
      {
        id: "factory-lanes",
        label: "Active lanes",
        badge: "3 running",
        status: "Healthy",
        preview: "lane-auth (green) · lane-stack (testing) · lane-docs (queued) · 0 stalled runners.",
      },
      {
        id: "factory-decide",
        label: "Open decisions",
        badge: "1 waiting",
        status: "Needs you",
        preview: "Press 1–9 to pick an option or a/c to accept or change a spec review.",
      },
    ],
  },
  {
    id: "start",
    eyebrow: "08 · Ready",
    title: "Start automating your codebase",
    subtitle: "Try the live in-browser demo with zero setup, or open Smithers and sign in with GitHub to connect your repositories.",
    shortcut: "/app",
    choices: [
      {
        id: "start-demo",
        label: "Interactive Demo",
        badge: "No sign-in",
        status: "Local",
        preview: "Runs Smithers' full browser engine in memory with a local demo agent — ask questions, run slash commands, and test approvals.",
      },
      {
        id: "start-github",
        label: "Connect GitHub",
        badge: "Production",
        status: "Ready",
        preview: "Sign in with GitHub, bring your model key or use hosted inference, and open any repository.",
      },
    ],
    action: { label: "Try interactive demo", to: "/app?agent=mock" },
  },
]

/** Clamps `index` to a valid stop index. */
export const clampStop = (index: number, total: number = STOPS.length): number =>
  Math.max(0, Math.min(Math.trunc(Number.isFinite(index) ? index : 0), total - 1))

/** Builds the complete view state at `index` with `chosen` preview selections. */
export const stateAt = (index: number, chosen: Readonly<Record<string, string>> = {}): TourState => {
  const at = clampStop(index, STOPS.length)
  const stop = STOPS[at]!
  const pickedId = chosen[stop.id]
  const activeChoice = stop.choices.find((choice) => choice.id === pickedId) ?? stop.choices[0]!
  return {
    index: at,
    total: STOPS.length,
    stop,
    percent: Math.round(((at + 1) / STOPS.length) * 100),
    hasPrevious: at > 0,
    hasNext: at < STOPS.length - 1,
    chosen,
    activeChoice,
  }
}

/** Moves forward by one stop, clamping at the last stop. */
export const nextStop = (state: TourState): TourState =>
  stateAt(state.index + 1, state.chosen)

/** Moves back by one stop, clamping at the first stop. */
export const previousStop = (state: TourState): TourState =>
  stateAt(state.index - 1, state.chosen)

/** Selects an interactive preview option on the current stop. */
export const choosePreview = (state: TourState, choiceId: string): TourState => {
  if (!state.stop.choices.some((choice) => choice.id === choiceId)) return state
  return stateAt(state.index, { ...state.chosen, [state.stop.id]: choiceId })
}

/** Restarts the tour at stop 0 with fresh preview choices. */
export const restartTour = (): TourState => stateAt(0, {})
