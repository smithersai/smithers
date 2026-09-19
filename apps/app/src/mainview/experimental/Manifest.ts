/*
 * Every experimental pane's identity, without its drawing.
 *
 * The flow block needs each pane's name and catalog copy at REGISTRATION
 * time, which is every boot; the drawing is needed only when someone opens
 * one. Keeping the two apart is what stops the mocks from riding in the app's
 * main chunk for people who never turn the flag on: this module is a few
 * hundred bytes of literals, and `Registry.loadPane` fetches a pane's own
 * chunk on demand.
 *
 * The rows below are a second copy of what each pane file declares — the same
 * trade `flows/FlowName.ts` makes for flow names. Manifest.test.ts holds the
 * two to each other in both directions, so the copy cannot drift.
 */

/** One pane's identity. `file` is its module under ./panes, without the extension. */
export interface PaneManifestRow {
  readonly file: string
  /** The flow leaf: `/experimental.<id>`. */
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly packages: ReadonlyArray<string>
}

/** The registry, in the order the slash menu lists them. */
export const EXPERIMENTAL_MANIFEST: ReadonlyArray<PaneManifestRow> = [
  { file: "Index", id: "index", title: "Experimental", summary: "Every hidden mock, and the abstraction each one draws", packages: ["@smthrs/*"] },
  { file: "Build", id: "build", title: "Build targets", summary: "The target graph, cache hits and the affected set", packages: ["@smthrs/build-cli", "@smthrs/build"] },
  { file: "Capability", id: "capability", title: "Capability and grants", summary: "Which rule allowed a call, and the grant set as it grew", packages: ["@smthrs/capability", "@smthrs/kernel"] },
  { file: "CellLoop", id: "cell-loop", title: "Cell loop", summary: "The model's cell, its calls, its variables and the exact context window", packages: ["@smthrs/harness", "@smthrs/chain"] },
  { file: "Control", id: "control", title: "Control plane", summary: "Lineage, credentials, steering and health", packages: ["@smthrs/control"] },
  { file: "Database", id: "database", title: "Database", summary: "The migration ladder, the backend, and write retries", packages: ["@smthrs/database"] },
  { file: "Decisions", id: "decisions", title: "Decisions", summary: "Jev's questions, criteria and floors", packages: ["@smthrs/model", "@smthrs/std"] },
  { file: "Evals", id: "evals", title: "Evals", summary: "Suites, cases, baselines and the gate", packages: ["@smthrs/evals"] },
  { file: "Flows", id: "flows", title: "Flow declarations", summary: "A flow's graph, effects, placement and key material", packages: ["@smthrs/core", "@smthrs/flow", "@smthrs/registry"] },
  { file: "Harnesses", id: "harnesses", title: "Harnesses", summary: "Which agent CLIs this machine has and who they are signed in as", packages: ["@smthrs/harness-detect"] },
  { file: "Integrations", id: "integrations", title: "Integrations", summary: "Webhook doors, their verification and their cursors", packages: ["@smthrs/integrations"] },
  { file: "Jj", id: "jj", title: "Version control", summary: "Every jj operation a run ran", packages: ["@smthrs/jj"] },
  { file: "Journal", id: "journal", title: "Journal", summary: "The append-only event tail with a sequence scrubber", packages: ["@smthrs/journal"] },
  { file: "Manifest", id: "manifest", title: "App manifest", summary: "Smithers rendering its own PACKAGE.ts: routes, panes, flows and layers", packages: ["@smthrs/create-app"] },
  { file: "Memory", id: "memory", title: "Memory", summary: "Facts, notes and threads, with the recall ranking that found them", packages: ["@smthrs/memory"] },
  { file: "Models", id: "models", title: "Models and seats", summary: "Which model each role uses, its credential and its route", packages: ["@smthrs/model", "@smthrs/harness-detect"] },
  { file: "Notifications", id: "notifications", title: "Notifications", summary: "The queue, its admission policy and its sinks", packages: ["@smthrs/notifications"] },
  { file: "Observability", id: "observability", title: "Observability", summary: "Metric handles, the OTLP target and the trace out", packages: ["@smthrs/observability"] },
  { file: "OpenCode", id: "opencode", title: "OpenCode server", summary: "Protocol v1 sessions, parts and permission cards", packages: ["@smthrs/opencode"] },
  { file: "Patterns", id: "patterns", title: "Patterns", summary: "The composition patterns, each as the graph it declares", packages: ["@smthrs/patterns"] },
  { file: "Plan", id: "plan", title: "Plan and step keys", summary: "The keyed action graph, its step keys and the diff between revisions", packages: ["@smthrs/plan", "@smthrs/core"] },
  { file: "Plugins", id: "plugins", title: "Plugin kernel", summary: "Hook order and which plugin won a resolution", packages: ["@smthrs/plugin"] },
  { file: "Projections", id: "projections", title: "Projections", summary: "Any gateway projection, by cursor, row by row", packages: ["@smthrs/gateway"] },
  { file: "RunStore", id: "run-store", title: "Run store", summary: "Who owns a run, its attempts, its fence and its next deadline", packages: ["@smthrs/run-store", "@smthrs/engine"] },
  { file: "Sandbox", id: "sandbox", title: "Sandbox", summary: "Where a step ran, which provider served it and whether it is alive", packages: ["@smthrs/sandbox"] },
  { file: "Scorers", id: "scorers", title: "Scorers", summary: "Every observation a scorer wrote, and why it sampled", packages: ["@smthrs/scorers"] },
  { file: "StepCache", id: "step-cache", title: "Step cache", summary: "Why a step did not run: the digest, the recorded result, the artifact", packages: ["@smthrs/step-cache", "@smthrs/artifacts", "@smthrs/keys"] },
  { file: "Sync", id: "sync", title: "Sync", summary: "The read path's cursor and how far behind it is", packages: ["@smthrs/sync"] },
  { file: "TimeTravel", id: "time-travel", title: "Time travel", summary: "Replay, fork and rewind a run at a frame", packages: ["@smthrs/time-travel"] },
  { file: "Tools", id: "tools", title: "Tools", summary: "Every tool the model can call, with its schema and disclosure level", packages: ["@smthrs/std", "@smthrs/fs", "@smthrs/registry", "@smthrs/mcp"] },
  { file: "Triggers", id: "triggers", title: "Triggers", summary: "Cron rules, their fires, and the claim and overlap decisions", packages: ["@smthrs/triggers"] },
]

/** The row a card's pane id names, or undefined once that pane is promoted away. */
export const manifestRow = (id: string): PaneManifestRow | undefined =>
  EXPERIMENTAL_MANIFEST.find((row) => row.id === id)
