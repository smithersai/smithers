/**
 * Machine-readable coverage accounting for the 0.x-to-rc.0 test migration:
 * which old smithers test file, and which behavior of the external reference
 * corpus, each repository test answers for.
 *
 * This is migration bookkeeping, not a testing-library API, and it has no
 * consumer outside this package's own suite. It lives under `test/`, which the
 * publish allowlist does not ship and `scripts/build.mjs` does not compile, so
 * neither this module nor a generated copy of it reaches the tarball. Blocking
 * `./internal/*` in the export map hid it from resolution but still packed it.
 *
 * The rows carry their own `reason` text for every claim that is not `pinned`.
 *
 * @since 0.0.0
 */

/**
 * One behavior from an external test suite and its Smithers coverage status.
 *
 * @category models
 * @since 0.0.0
 */
export interface ParityRow {
  readonly source: string
  readonly behavior: string
  readonly flowsEquivalent: string
  readonly status: "pinned" | "partial" | "skipped"
  readonly reason?: string
}

const smithersRows: ReadonlyArray<ParityRow> = [
  {
    source: "smithers #1 packages/smithers/flows/engine/tests/replay-unsafe-approval.e2e.test.jsx",
    behavior: "Unsafe replay parks before reinvocation and a denial remains a veto across retries.",
    flowsEquivalent: "—",
    status: "skipped",
    reason:
      "The production engine has no unsafe-replay approval request contract; the removed test-only approval simulator was not parity."
  },
  {
    source: "smithers #2 packages/smithers/flows/engine/tests/crash-recovery.test.js",
    behavior: "Recovery preserves committed state and never re-executes completed work.",
    flowsEquivalent: "flows/packages/smithers/flows/engine-store/test/Replay.test.ts",
    status: "partial",
    reason: "Production replay is pinned, but the public adapter cannot kill and reconstruct a durable engine process."
  },
  {
    source:
      "smithers #3 packages/smithers/flows/engine/tests/quota-chain-failover.e2e.test.jsx + quota-park-lifecycle.e2e.test.jsx",
    behavior: "Quota-chain failover parks at the earliest reset only after every rung is limited.",
    flowsEquivalent: "agent/packages/smithers/agent/model/test/RequestExecutor.test.ts",
    status: "partial",
    reason:
      "Production model retry classification and reset normalization are pinned; the engine has no public quota-chain scheduler."
  },
  {
    source: "smithers #4 packages/smithers/flows/time-travel/tests/jumpToFrame.test.ts + rewindRollback.test.ts",
    behavior: "Failure at each rewind boundary atomically restores the pre-jump state.",
    flowsEquivalent: "flows/packages/smithers/flows/time-travel/test/RewindRollback.test.ts",
    status: "pinned"
  },
  {
    source: "smithers #5 packages/smithers/flows/engine/tests/task-heartbeats.test.jsx",
    behavior: "A stale owner cannot commit outputs or terminal state after losing its heartbeat lease.",
    flowsEquivalent: "flows/packages/smithers/flows/engine-store/test/Ownership.test.ts",
    status: "partial",
    reason:
      "RunDriver interruption on fence loss is pinned, but no adversarial store test proves a stale handler cannot commit output or terminal writes afterward."
  },
  {
    source:
      "smithers #6 packages/smithers/flows/engine/tests/xcombo-child-approval.e2e.test.jsx + xcombo-cancel-pause-subflow.e2e.test.jsx",
    behavior: "A parked child parks its parent and parent cancellation leaves no running child.",
    flowsEquivalent: "flows/packages/smithers/flows/engine/test/RetryOnInterrupt.test.ts",
    status: "partial",
    reason:
      "Production interruption propagation is pinned; the engine has no public parent-child park or subflow-timeout contract."
  },
  {
    source:
      "smithers #7 packages/smithers/flows/engine/tests/wait-for-event-correlation.e2e.test.jsx + durable-deferred-contract.test.js",
    behavior: "Signals are correlated and a pre-arrival survives durable resume.",
    flowsEquivalent: "flows/packages/smithers/flows/engine-store/test/DeferredPersistence.test.ts",
    status: "partial",
    reason:
      "Production deferred pre-arrival persistence is pinned; correlation normalization is not exposed by the engine."
  },
  {
    source: "smithers #8 packages/smithers/flows/engine/tests/durability.test.jsx",
    behavior: "Resume rejects changed flow/import hashes until explicitly accepted.",
    flowsEquivalent: "—",
    status: "skipped",
    reason: "The production engine persists flow tags and payloads, not entry/import hashes or an acceptance operation."
  },
  {
    source:
      "smithers #9 packages/scheduler/tests/approval-timeout-ondeny.test.js + packages/smithers/flows/engine/tests/approval-gate-flow.e2e.test.jsx",
    behavior: "Approval timeout modes and automatic approval use durable logical time.",
    flowsEquivalent: "—",
    status: "skipped",
    reason:
      "The production engine has no approval-timeout scheduler. Add a timeout failure only with a concrete subject and behavioral pin; no reserved testing error is exported."
  },
  {
    source:
      "smithers #10 packages/smithers/flows/engine/tests/pause-lifecycle.test.jsx + packages/driver/tests/pause-drain.test.js",
    behavior: "Pause drains in-flight work and cancel wins while draining.",
    flowsEquivalent: "agent/packages/smithers/control/test/ControlLive.test.ts",
    status: "partial",
    reason: "Production fenced pause/cancel control is pinned; the flow engine does not expose drain state."
  },
  {
    source: "smithers #11 packages/smithers/flows/engine/tests/engine-transactional-writes.test.jsx",
    behavior: "Frame, snapshot, output, and attempt writes commit atomically.",
    flowsEquivalent: "flows/packages/smithers/flows/engine-store/test/JournalIntegration.test.ts",
    status: "partial",
    reason: "Production journal commits are pinned, but there is no public multi-boundary failure injector."
  },
  {
    source: "smithers #12 packages/scheduler/tests/scheduleTasks.test.js + schedule-dispatch-invariants.test.js",
    behavior: "Scheduling preserves FIFO, priority, dependencies, and group caps.",
    flowsEquivalent: "—",
    status: "skipped",
    reason: "The production flow engine has no priority/group scheduler contract."
  },
  {
    source:
      "smithers #13 packages/scheduler/tests/makeFlowSession-coverage.test.js + packages/smithers/flows/engine/tests/engine.test.jsx",
    behavior: "Loop termination re-evaluates until and fails with ralph_max_reached at its bound.",
    flowsEquivalent: "—",
    status: "skipped",
    reason:
      "The production engine has no loop runtime. Add a loop-limit failure only with a concrete subject and behavioral pin; no reserved testing error is exported."
  },
  {
    source:
      "smithers #14 packages/smithers/flows/engine/tests/deps-deadlock.test.jsx + makeFlowSession-coverage.test.js",
    behavior: "Dependency deadlock fails with stable diagnostics after one stable-finish rerender.",
    flowsEquivalent: "flows/packages/smithers/flows/engine-store/test/CycleDetection.test.ts",
    status: "partial",
    reason:
      "Production parent-chain cycle detection fails with the typed FlowCycleDetected carrying a stable cycle path; it is not a smithers-style dependency-deadlock scheduler with stable-finish rerender diagnostics."
  }
]

// The harness ran a provider-tool-call loop until the cell loop replaced it,
// and the suites that pinned that loop went with it. A pi row whose behavior
// still exists is retargeted at the suite that now proves it — deferred tool
// loading, for instance, is a model-layer contract and never depended on the
// loop. A row whose behavior was the loop is `skipped` with the deletion named
// as its reason, because the cell loop declares no provider tools at all.
const piRows: ReadonlyArray<ParityRow> = [
  {
    source: "pi §4 deferred tool loading",
    behavior: "A tool result activates deferred definitions additively for the next turn.",
    flowsEquivalent: "agent/packages/smithers/agent/model/test/DeferredTools.test.ts",
    status: "pinned"
  },
  {
    // The deleted DeferredToolCache.test.ts pinned both halves against the
    // context window; ContextWindow.test.ts now carries them, so the row points
    // at the module that owns activation rather than at the Anthropic wire.
    source: "pi §4 deferred tool loading",
    behavior: "Tool activation is additive and cache-safe.",
    flowsEquivalent: "agent/packages/smithers/agent/harness/test/ContextWindow.test.ts",
    status: "pinned"
  },
  {
    source: "pi §6 abort discipline",
    behavior: "Fiber interruption aborts a child batch without starting later work.",
    flowsEquivalent: "agent/packages/smithers/agent/harness/test/CellTurn.test.ts",
    status: "partial",
    reason:
      "The cell loop reports one typed abort on interruption and starts no later frame; the provider tool-call batch this constrained went away with the legacy loop."
  },
  {
    source: "pi §6 abort discipline",
    behavior: "Aborted child settlements remain well-formed transcript tool results.",
    flowsEquivalent: "agent/packages/smithers/agent/harness/test/Transcript.test.ts",
    status: "pinned"
  },
  {
    source: "pi §7 streaming",
    behavior: "Model transport and child progress stream without producer pre-join.",
    flowsEquivalent: "—",
    status: "skipped",
    reason:
      "The layered streaming harness went away with the legacy provider-tool-call loop; the cell loop emits model deltas and per-call progress, but no surviving suite pins the no-pre-join ordering."
  },
  {
    source: "pi §7 length stop",
    behavior: "A length-stopped tool batch fails instead of succeeding partially.",
    flowsEquivalent: "—",
    status: "skipped",
    reason:
      "The cell loop has no provider tool batch to reject; a truncated cell is a correctable observation, which is a different contract."
  }
]

/**
 * Every static test title in the targeted OpenCode session sources.
 *
 * The manifest test extracts the reference titles independently and requires
 * this inventory to match, so a filename-only placeholder cannot pass.
 *
 * @category models
 * @since 0.0.0
 */
export const openCodeBehaviorInventory = {
  "packages/smithers/flows/core/test/session-compaction.test.ts": [
    "compaction prompt preserves detailed work state and relevant files",
    "compaction describes tool media without embedding base64"
  ],
  "packages/smithers/flows/core/test/session-create.test.ts": [
    "creates a fresh projected session when the ID is omitted",
    "returns the original session when the ID is retried",
    "stores supplied immutable create attributes",
    "returns the existing Session when one ID is reused with different create arguments",
    "returns one recorded session to concurrent exact retries",
    "returns the current Session projection after updates",
    "returns the current Session projection after projected updates",
    "persists creation through the existing legacy created event",
    "persists caller-ID creation through the existing created event",
    "omits legacy creation rows from the V2 Session event stream",
    "replays one prompt lifecycle into a fresh target database",
    "does not mask unrelated created projector defects",
    "reports unfinished Session operations as unavailable",
    "switches the selected agent through the durable Session event",
    "rejects an agent switch for a missing Session",
    "switches the selected model through the durable Session event",
    "ignores a model switch when the selected model is unchanged",
    "treats an omitted variant as the default variant",
    "rejects a model switch for a missing Session"
  ],
  "packages/smithers/flows/core/test/session-history.test.ts": [
    "returns an exhausted page for a migrated Session with no event sequence",
    "treats after as an exclusive aggregate sequence",
    "paginates public events in aggregate order across filtered gaps without duplicates",
    "includes events committed between pages",
    "reports exhaustion for exact-limit and limit-plus-one pages",
    "fails with NotFoundError for a missing Session"
  ],
  "packages/smithers/flows/core/test/session-projector.test.ts": [
    "projects staged, cleared, and committed reverts",
    "orders projected messages and context by durable aggregate sequence",
    "marks an inbox row promoted with the Prompted event sequence",
    "projects durable context messages supported by the updater",
    "rejects distinct creator events that reuse one projected message ID",
    "does not revive a stale incomplete assistant projection",
    "does not revive a stale incomplete in-memory assistant projection",
    "updates only the newest incomplete assistant projection"
  ],
  "packages/smithers/flows/core/test/session-prompt.test.ts": [
    "exposes the execution registry",
    "delegates execution continuation through SessionExecution",
    "delegates process-local interruption through SessionExecution",
    "delegates interruption without requiring a recorded Session",
    "durably admits one user message before transcript promotion",
    "resolves attachment MIME before admission",
    "streams durable Session events after an aggregate sequence",
    "resumes through a recorded message without appending another prompt",
    "records distinct messages when the ID is omitted",
    "returns the original recorded message when the ID is retried",
    "wakes execution when an exact prompt retry recovers a committed message",
    "rejects reuse of one ID with a different prompt",
    "rejects reuse of one ID with a different delivery mode",
    "returns one recorded message to concurrent exact retries",
    "promotes one message once under concurrent promotion attempts",
    "promotes steers only through the captured inbox cutoff",
    "reprojects pending inbox input without scheduling execution",
    "returns an exact retry of a legacy projected prompt",
    "returns an exact retry of a legacy projected queued prompt",
    "rejects reuse of one globally unique message ID across sessions",
    "rejects a prompt ID already used by visible Session history",
    "starts execution by default after recording the prompt",
    "starts execution when resume is explicitly true",
    "only records the prompt when resume is false"
  ],
  "packages/smithers/flows/core/test/session-run-coordinator.test.ts": [
    "joins concurrent resumes for one key",
    "joins a wake-started execution without forcing a successor",
    "starts execution when woken while idle",
    "snapshots only active executions",
    "cleans active executions after failure and defect",
    "cleans active executions when its scope closes",
    "coalesces wakes received during active execution",
    "runs again when woken during the follow-up",
    "does nothing when interrupted while idle",
    "interrupts active execution and clears its pending wake",
    "runs a wake registered during interruption cleanup",
    "starts a resume registered during interruption cleanup",
    "starts one follow-up when a wake races with failure",
    "does not cancel execution when a joined waiter is interrupted",
    "runs different keys concurrently",
    "trampolines synchronous self-waking execution"
  ],
  "packages/smithers/flows/core/test/session-runner-message.test.ts": [
    "omits empty assistant turns",
    "maps every top-level V2 Session message type",
    "replays durable tool media into canonical tool messages without structured base64",
    "restores OpenAI encrypted reasoning metadata",
    "drops provider-native continuation metadata from failed assistant turns",
    "drops provider-native continuation metadata after a model switch"
  ],
  "packages/smithers/flows/core/test/session-runner-model.test.ts": [
    "maps catalog OpenAI AI SDK models into native Responses routes",
    "keeps catalog apiKey credentials out of provider JSON",
    "uses merged API settings for OpenAI-compatible auth and request defaults",
    "overlays selected OpenAI Session variant bodies",
    "overlays selected OpenAI-compatible Session variant bodies",
    "rejects an explicit unavailable Session variant during model resolution",
    "overlays selected Anthropic Session variant bodies",
    "maps catalog Anthropic AI SDK models into native routes",
    "uses resolved credentials for bearer auth",
    "prefers stored credentials over configured auth",
    "does not project OAuth account metadata into the request body",
    "rejects catalog APIs without a native route",
    "reports whether a catalog model has a supported native route"
  ],
  "packages/smithers/flows/core/test/session-runner-recorded.test.ts": [
    "executes one recorded V2 prompt through the recorded HTTP transport"
  ],
  "packages/smithers/flows/core/test/session-runner-tool-events.test.ts": [
    "local tool success serializes media base64 once and reconstructs from structured content",
    "provider-executed success retains its compatibility result",
    "binary failure emits no success event",
    "old success event data containing result still decodes",
    "step finish records settlement without publishing step ended"
  ],
  "packages/smithers/flows/core/test/session-runner-tool-registry.test.ts": [
    "filters disabled tools with edit aliases and ordered wildcard precedence",
    "keeps permission decoration isolated between registrations",
    "reuses model definitions across provider turns",
    "removes a scoped registration",
    "preserves an interrupted registration until its scope closes",
    "returns model errors without swallowing interruption or defects",
    "propagates retention failures through settlement",
    "exposes settlement only through materialization",
    "passes complete invocation identity to the canonical handler",
    "encodes output and applies generic settlement bounding",
    "enforces transformed codecs at execution and projection boundaries",
    "executes the unchanged registration advertised for a provider turn",
    "rejects a call when its advertised registration was removed",
    "rejects only the replaced name from a multi-tool provider turn",
    "treats revealing a previous overlay as stale",
    "keeps captured execution running after registration mutation"
  ],
  "packages/smithers/flows/core/test/session-runner.test.ts": [
    "advertises and executes a globally attached application tool",
    "starts a real runner turn after default prompt recording",
    "streams one request with registry definitions from chronological V2 user history",
    "retries the first provider turn after system context becomes available",
    "interrupts a source Location runner after a Session moves",
    "fails gracefully when a stored context snapshot cannot be decoded",
    "reuses one durable baseline after the context producer changes",
    "includes the effective default agent system before durable context",
    "uses the configured default agent system for omitted-agent sessions",
    "uses an explicitly selected non-build agent system",
    "updates selected-agent skill guidance after an agent switch",
    "keeps the sampled agent when selection changes during observation",
    "keeps the sampled model when selection changes during model resolution",
    "admits removed context as a chronological System message",
    "keeps the baseline and chronological System updates after a model switch",
    "preserves the baseline while context is temporarily unavailable",
    "rebuilds the baseline directly after completed compaction",
    "automatically compacts into a completed summary and retained recent turn",
    "forces one compaction and retries after provider context overflow",
    "persists a second context overflow after one recovery",
    "recovers once from a raw context overflow failure",
    "publishes the original overflow when recovery summarization fails",
    "interrupts overflow recovery while the summary provider is running",
    "preserves effective System updates while compaction rebaseline is blocked",
    "projects reasoning and tool events without executing or continuing tools",
    "continues with reloaded history after durably settling one local tool call",
    "reloads a model switch before a tool-driven continuation turn",
    "restores durable reasoning provider metadata in a second-turn request",
    "replays durable provider-executed tool results inline in a second-turn request",
    "starts recorded local tools eagerly and awaits settlement before continuing",
    "settles repeated provider-local tool call IDs against their owning assistant messages",
    "joins concurrent resume calls into one active provider run",
    "steers an active provider turn with newly recorded prompts",
    "promotes queued input after continuation ends",
    "preserves durable queued input for a later wake after interruption",
    "preserves durable steering input for a later resume after interruption",
    "promotes queued inputs one at a time in FIFO order",
    "promotes queued input after steering continuation ends",
    "promotes steers before the next queued input",
    "coalesces multiple active steering prompts into one continuation turn",
    "runs steering input accepted while the active provider turn fails",
    "durably fails local tools left running by a prior process before continuing",
    "durably fails hosted tools left running by a prior process before continuing inline",
    "durably fails pending tool input left by a prior process before continuing",
    "promotes the first queued input when woken while idle",
    "retries inbox input after prompt projection rolls back",
    "does not strand a committed promotion when a post-commit listener defects",
    "runs different sessions concurrently",
    "bounds 64-character session prompt cache keys",
    "fans out one failed run and allows a later retry",
    "durably settles local tool failures before continuing",
    "returns unexpected local tool defects to the model and continues",
    "returns policy-blocked tools to the model and continues",
    "interrupts runner continuation when permission approval is declined",
    "returns permission corrections to the model and continues",
    "interrupts runner continuation when a question is dismissed",
    "awaits started local tools before surfacing provider stream failure",
    "durably fails blocked local tools when a provider turn is interrupted",
    "interrupts a blocked provider turn without local tool execution",
    "durably fails blocked local tools when interrupted while awaiting settlement",
    "forces a text response on an agent's configured final step",
    "resets the configured step allowance when steering input promotes",
    "projects provider errors as terminal assistant step failures",
    "projects provider errors emitted before assistant step start",
    "does not recover context overflow after durable assistant output",
    "projects raw provider stream failures as terminal assistant step failures",
    "does not continue automatically after a provider error follows a local tool call",
    "durably fails a hosted tool when its provider errors before returning a result",
    "durably fails a hosted tool left unresolved at normal provider EOF",
    "durably fails a hosted tool left unresolved by a raw provider stream failure",
    "keeps interleaved assistant text blocks separate",
    "broadcasts provider ${kind} deltas without storing projection rewrites",
    "durably closes partial ${kind} when the provider stream fails",
    "durably closes partial ${kind} when the provider stream is interrupted",
    "rejects duplicate streamed text starts",
    "transitions streamed raw tool input to parsed called input",
    "rejects malformed streamed tool input ordering"
  ],
  "packages/smithers/flows/core/test/session-todo.test.ts": [
    "replaces persisted todos in order and publishes updates"
  ],
  "packages/smithers/flows/core/test/session-tool-progress.test.ts": [
    "projects durable progress and keeps final settlements durable"
  ]
} as const

/**
 * OpenCode source files covered by the behavior inventory.
 *
 * @category models
 * @since 0.0.0
 */
export const requiredOpenCodeSources = Object.keys(openCodeBehaviorInventory)

/**
 * Flattened source/behavior inventory used by coverage gates.
 *
 * @category models
 * @since 0.0.0
 */
export const requiredOpenCodeBehaviors = Object.entries(openCodeBehaviorInventory).flatMap(
  ([source, behaviors]) => behaviors.map((behavior) => ({ source, behavior }))
)

const key = (source: string, behavior: string) => `${source}\u0000${behavior}`

const pinned = new Map<string, Pick<ParityRow, "flowsEquivalent" | "status" | "reason">>([
  [
    key("packages/smithers/flows/core/test/session-runner-message.test.ts", "omits empty assistant turns"),
    { flowsEquivalent: "agent/packages/smithers/agent/harness/test/Transcript.test.ts", status: "pinned" }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner-message.test.ts",
      "drops provider-native continuation metadata from failed assistant turns"
    ),
    { flowsEquivalent: "agent/packages/smithers/agent/harness/test/Transcript.test.ts", status: "pinned" }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "joins concurrent resume calls into one active provider run"
    ),
    {
      flowsEquivalent: "flows/packages/smithers/flows/engine-store/test/RunCoordinator.test.ts",
      status: "partial",
      reason: "The coordinator coalesces wakes; Smithers has no OpenCode Session aggregate adapter."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "steers an active provider turn with newly recorded prompts"
    ),
    { flowsEquivalent: "agent/packages/smithers/agent/harness/test/Steering.test.ts", status: "pinned" }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "promotes queued inputs one at a time in FIFO order"
    ),
    { flowsEquivalent: "agent/packages/smithers/agent/harness/test/Steering.test.ts", status: "pinned" }
  ],
  [
    key("packages/smithers/flows/core/test/session-runner.test.ts", "promotes steers before the next queued input"),
    { flowsEquivalent: "agent/packages/smithers/agent/harness/test/Steering.test.ts", status: "pinned" }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "durably settles local tool failures before continuing"
    ),
    {
      flowsEquivalent: "agent/packages/smithers/agent/harness/test/Sandbox.test.ts",
      status: "partial",
      reason:
        "A refused flow call resolves with the { ok: false, error } envelope the cell branches on, so a failed call never fails the run and never discards the calls beside it; the journaled failure settlement is pinned in agent/packages/smithers/agent/test/AgentTrace.test.ts and durable storage remains engine-owned."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "forces one compaction and retries after provider context overflow"
    ),
    {
      flowsEquivalent: "agent/packages/smithers/agent/harness/test/CellTurn.test.ts",
      status: "partial",
      reason:
        "The cell loop forces one sealed compaction and asks the model again on the compacted window; it compacts on a declared token budget, so provider-overflow retry went away with the legacy provider-tool-call loop."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "persists a second context overflow after one recovery"
    ),
    {
      flowsEquivalent: "—",
      status: "skipped",
      reason:
        "Provider-overflow recovery went away with the legacy provider-tool-call loop, so there is no one-shot recovery for a second overflow to exhaust."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "recovers once from a raw context overflow failure"
    ),
    {
      flowsEquivalent: "—",
      status: "skipped",
      reason:
        "The cell loop compacts on a declared token budget and never recovers from a raw provider overflow; that recovery went away with the legacy provider-tool-call loop."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "does not recover context overflow after durable assistant output"
    ),
    {
      flowsEquivalent: "—",
      status: "skipped",
      reason: "The overflow-recovery contract this constrains went away with the legacy provider-tool-call loop."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "forces a text response on an agent's configured final step"
    ),
    { flowsEquivalent: "agent/packages/smithers/agent/harness/test/CellTurn.test.ts", status: "pinned" }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "projects raw provider stream failures as terminal assistant step failures"
    ),
    {
      flowsEquivalent: "agent/packages/smithers/agent/harness/test/Transcript.test.ts",
      status: "partial",
      reason:
        "The transcript projects a metadata-free failed settlement preserving partial content; durable Session projection remains engine-owned."
    }
  ],
  [
    key("packages/smithers/flows/core/test/session-runner.test.ts", "keeps interleaved assistant text blocks separate"),
    { flowsEquivalent: "agent/packages/smithers/agent/model/test/ModelEvent.test.ts", status: "pinned" }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "broadcasts provider ${kind} deltas without storing projection rewrites"
    ),
    {
      flowsEquivalent: "agent/packages/smithers/agent/harness/test/Transcript.test.ts",
      status: "partial",
      reason:
        "Transcript ignores deltas and projects only settled entries, so no broadcast is stored as a rewrite; durable storage is engine-owned."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "durably closes partial ${kind} when the provider stream fails"
    ),
    {
      flowsEquivalent: "agent/packages/smithers/agent/model/test/AnthropicMessages.test.ts",
      status: "partial",
      reason:
        "The model boundary flushes an open block without settling a failed stream and maps the failure to a typed ModelError; durable fragment storage remains engine-owned."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner.test.ts",
      "durably closes partial ${kind} when the provider stream is interrupted"
    ),
    {
      flowsEquivalent: "agent/packages/smithers/agent/model/test/ModelEvent.test.ts",
      status: "partial",
      reason:
        "Interrupted fragments settle as aborted with repaired tool JSON and preserved metadata; durable fragment storage remains engine-owned."
    }
  ],
  [
    key("packages/smithers/flows/core/test/session-runner.test.ts", "rejects malformed streamed tool input ordering"),
    { flowsEquivalent: "agent/packages/smithers/agent/model/test/ToolStream.test.ts", status: "pinned" }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-tool-progress.test.ts",
      "projects durable progress and keeps final settlements durable"
    ),
    {
      flowsEquivalent: "agent/packages/smithers/agent/harness/test/CellTurn.test.ts",
      status: "partial",
      reason: "The cell loop emits live per-call start and settlement; durable storage remains engine-owned."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner-recorded.test.ts",
      "executes one recorded V2 prompt through the recorded HTTP transport"
    ),
    {
      flowsEquivalent: "agent/packages/smithers/agent/model/test/RequestExecutor.test.ts",
      status: "partial",
      reason:
        "Byte-identical replay of a recorded request through the HTTP transport is pinned at the model boundary; the whole-session recorded replay went away with the legacy provider-tool-call loop."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner-tool-registry.test.ts",
      "preserves an interrupted registration until its scope closes"
    ),
    {
      flowsEquivalent: "agent/packages/smithers/agent/model/test/DeferredTools.test.ts",
      status: "partial",
      reason:
        "Smithers pins retained deferred definitions at the model boundary, but does not expose mutable scoped registrations."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner-tool-registry.test.ts",
      "returns model errors without swallowing interruption or defects"
    ),
    {
      flowsEquivalent: "agent/packages/smithers/agent/model/test/ModelEvent.test.ts",
      status: "partial",
      reason:
        "Interruption normalization is pinned at the model boundary; OpenCode registration defects are vendor-specific."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner-tool-registry.test.ts",
      "propagates retention failures through settlement"
    ),
    {
      flowsEquivalent: "—",
      status: "skipped",
      reason: "The Smithers registry is immutable and has no fallible retention operation."
    }
  ],
  [
    key(
      "packages/smithers/flows/core/test/session-runner-tool-registry.test.ts",
      "enforces transformed codecs at execution and projection boundaries"
    ),
    {
      flowsEquivalent: "agent/packages/smithers/agent/model/test/ModelRequest.test.ts",
      status: "partial",
      reason: "Provider request codecs are pinned; Smithers has no mutable OpenCode tool-registration codec."
    }
  ]
])

const defaultCoverage = (source: string): Pick<ParityRow, "flowsEquivalent" | "status" | "reason"> => {
  if (source === "packages/smithers/flows/core/test/session-runner-model.test.ts") {
    return {
      flowsEquivalent: "agent/packages/smithers/agent/model/test/Route.test.ts",
      status: "partial",
      reason:
        "Smithers pins provider-neutral route/auth lowering, not OpenCode catalog and Session variant compatibility."
    }
  }
  if (source === "packages/smithers/flows/core/test/session-runner.test.ts") {
    return {
      flowsEquivalent: "—",
      status: "skipped",
      reason:
        "This OpenCode durable Session-runner behavior has no equivalent public Smithers harness contract; only exact translated descendants are pinned above."
    }
  }
  if (source.startsWith("packages/smithers/flows/core/test/session-runner")) {
    return {
      flowsEquivalent: "—",
      status: "skipped",
      reason:
        "This OpenCode registration, compatibility, or durable Session behavior has no equivalent public Smithers harness contract."
    }
  }
  return {
    flowsEquivalent: "—",
    status: "skipped",
    reason:
      "Smithers has no OpenCode-compatible mutable Session aggregate; this source behavior is inventoried without claiming harness parity."
  }
}

const openCodeRows: ReadonlyArray<ParityRow> = requiredOpenCodeBehaviors.map(({ source, behavior }) => ({
  source,
  behavior,
  ...(pinned.get(key(source, behavior)) ?? defaultCoverage(source))
}))

/**
 * Coverage claims for Smithers rows 1–14, pi §§4/6/7, and every inventoried
 * OpenCode behavior.
 *
 * @category models
 * @since 0.0.0
 */
export const rows: ReadonlyArray<ParityRow> = [...smithersRows, ...piRows, ...openCodeRows]
