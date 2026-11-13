import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * What a run that COMPLETED leaves on disk when its launching process exits.
 *
 * The release validation launched `hello` with `smithers run` and with
 * `smithers up -d`. Both were reported `completed` by the control plane and
 * both left `.flows/engine.db` `flows_runs` `suspended`/`released`, because
 * `AgentSession` writes `control.run.completed` from the flow body's exit
 * while the engine has yet to record the round's `Complete` result, and
 * `packages/smithers/src/Command.ts` `awaitRun` returns on that event and closes
 * the scope. The journal timed the gap at 10 to 14 ms: `control.run.completed`
 * at 1788163027537, `flows.engine.run-decision interrupt-released` at
 * 1788163027551. Every later process that composed an executor then claimed
 * the released row and replayed the agent turn — run-1 reached 162 journal
 * events and 16 run decisions across 11 pids, and its reported token count was
 * six times the truth.
 *
 * Two compositions over one pair of real SQLite files, the first composition's
 * scope closing on exactly the event the CLI closes on, and the rows read back
 * with `node:sqlite` because the pin is about what the next process finds.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import { Control, ControlLive, type ControlRuntime, type ControlSchema, SqlControlRuntime } from "@smthrs/control"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Jj from "@smthrs/jj"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { NotificationQueue } from "@smthrs/notifications"
import { NodeRuntime } from "@smthrs/platform-node"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Migrations as RunStoreMigrations, type Ownership, RunStore } from "@smthrs/run-store"
import { Context, Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentSession from "../src/AgentSession.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as Safety from "./Safety.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const envelope: ControlSchema.Envelope = { capabilities: [], flows: [], budget: {} }

const agentDescriptor = new Descriptor.FlowDescriptor({
  name: "agents/hello",
  description: "The agent that finishes.",
  body: new Descriptor.BodyRefMarkdown({
    path: "/flows/agents/hello/flow.md",
    baseDirectory: "/flows/agents/hello",
    contentDigest: "a".repeat(64)
  }),
  input: new Descriptor.SchemaRefNone(),
  output: new Descriptor.SchemaRefNone(),
  model: Option.some("anthropic:test-model"),
  flows: [],
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  modelInvocable: false,
  path: "/flows/agents/hello",
  frontmatter: {},
  provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
})

const registryLayer = Layer.succeed(Registry.Registry)(
  Registry.makeNoop({
    list: () => Effect.succeed([agentDescriptor]),
    visible: () => Effect.succeed([]),
    get: () => Effect.succeed(agentDescriptor),
    getOption: (name) => Effect.succeed(name === agentDescriptor.name ? Option.some(agentDescriptor) : Option.none()),
    loadBody: () =>
      Effect.succeed(
        new Descriptor.FlowBodyPrompt({ text: "Write the result and stop.", baseDirectory: "/flows/agents/hello" })
      )
  })
)

const controlFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
  {
    flowId: "agents/hello",
    executionDigest: Descriptor.executionDigest(agentDescriptor),
    description: "The agent that finishes.",
    deployClass: false,
    envelope
  }
]

const noteFlow = {
  capabilities: [],
  name: "note/save",
  description: "Save one line to the run's note log.",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ saved: Schema.Number }),
  effects: { reads: [], writes: ["/notes/**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
} as const

/** One cell call and a settled turn: the `hello` flow of the smoke, in miniature. */
const doneFrame = `await ctx.call("note/save", { text: "done" })
ctx.done("settled")`

/** Every model call every composition in this file makes, in order. */
const calls: Array<string> = []

const scripted = (engineHost: string): Model.Model =>
  Model.make({
    stream: () =>
      Stream.unwrap(Effect.sync(() => {
        calls.push(engineHost)
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell-0" }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: "cell-0",
            text: "```cell\n" + doneFrame + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell-0" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      }))
  })

const seatFor = (engineHost: string): SeatResolver.Service["resolve"] => (id) =>
  Effect.succeed(
    Seat.make({
      id,
      modelId: "test-model",
      model: scripted(engineHost),
      route,
      contextWindowTokens: SeatResolver.contextWindowTokensFor("test-model")
    })
  )

const jj = Jj.layerNoop({
  snapshot: () => Effect.succeed({ commitId: "completed-persist", changeId: "completed-persist" }),
  restore: () => Effect.void,
  diff: () => Effect.succeed("")
})

const controlStores = (filename: string) =>
  Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
    Layer.provideMerge(
      Layer.provideMerge(
        DatabaseMigrations.layer([Migrations.set, RunStoreMigrations.set]),
        Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
      )
    )
  )

const notes: Array<string> = []

/**
 * One process over the same durable storage and engine layers as the native
 * host. The lower-level composition injects the state decorator before engine
 * construction; it does not cover NodeRuntime.layer's logging and phase spans.
 */
const host = (
  root: string,
  owner: Ownership.OwnerId,
  engineHost: string,
  onSweep: Effect.Effect<void> = Effect.void
) => {
  const registration = AgentSession.layer({
    quotaPolicy: Safety.quotaPolicy,
    budget: Safety.budget,
    flows: [
      FlowBinding.source("test/notes", [
        FlowBinding.make({
          flow: noteFlow,
          handler: (input) =>
            Effect.sync(() => {
              notes.push(`${engineHost}:${input.text}`)
              return { saved: notes.length }
            })
        })
      ])
    ],
    limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000 },
    maxFrames: 4
  }).pipe(
    Layer.provide(
      Layer.mergeAll(Agent.layer, SeatResolver.layer({ resolve: seatFor(engineHost) }), scriptedCompletionJudge).pipe(
        Layer.provide(Safety.layer)
      )
    )
  )
  // Inject a decorator before the engine captures its services. The real SQL
  // state remains unchanged and every operation still reaches it.
  const state = Layer.effect(DurableEngineState.DurableEngineState)(
    Effect.map(DurableEngineState.DurableEngineState, (real) => ({
      ...real,
      staleRunningRuns: (...args: Parameters<typeof real.staleRunningRuns>) =>
        real.staleRunningRuns(...args).pipe(Effect.tap(() => onSweep))
    }))
  ).pipe(Layer.provideMerge(NodeRuntime.storage(join(root, "engine.db"), root)))
  const execution = Layer.merge(StepBoundary.layer, WorkspaceSandbox.layerFileSystem()).pipe(
    Layer.provideMerge(state)
  )
  const engine = registration.pipe(
    Layer.provideMerge(
      EngineStore.layer({
        owner: { hostId: engineHost },
        journalSource: `${engineHost}-engine`,
        isAlive: () => Effect.succeed(false),
        deferRecovery: true
      }).pipe(Layer.provideMerge(execution))
    ),
    Layer.tap((context) => Context.get(context, EngineStore.Driver).reportRecovery),
    Layer.provide([AtomicFileSystem.layer, NodeCrypto.layer, NodePath.layer, jj])
  )
  return ControlLive.layer.pipe(
    Layer.provide(engine),
    Layer.provideMerge(
      Layer.mergeAll(
        SqlControlRuntime.layer({ owner, flows: controlFlows }).pipe(Layer.orDie),
        NotificationQueue.layer,
        registryLayer
      )
    ),
    Layer.provideMerge(Layer.merge(controlStores(join(root, "control.db")), NodeCrypto.layer))
  )
}

const roots = new Set<string>()

afterEach(async () => {
  calls.length = 0
  notes.length = 0
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "flows-completed-persist-"))
  roots.add(root)
  return root
}

interface RunRow {
  readonly status: string
  readonly finished_at_ms: number | null
  readonly waiting_reason: string | null
  readonly owner_pid: number | null
}

const readRun = (root: string, database: string, runId: string): RunRow | undefined => {
  const handle = new DatabaseSync(join(root, database), { readOnly: true })
  try {
    return handle.prepare(
      "SELECT status, finished_at_ms, waiting_reason, owner_pid FROM flows_runs WHERE run_id = ?"
    ).get(runId) as unknown as RunRow | undefined
  } finally {
    handle.close()
  }
}

/** Every run decision the engine journal holds for a run, in order. */
const readDecisions = (root: string, runId: string): ReadonlyArray<string> => {
  const handle = new DatabaseSync(join(root, "engine.db"), { readOnly: true })
  try {
    const rows = handle.prepare(
      "SELECT payload_json FROM flows_journal_events WHERE run_id = ? AND event_type = 'flows.engine.run-decision' ORDER BY seq"
    ).all(runId) as unknown as ReadonlyArray<{ readonly payload_json: string }>
    return rows.map((row) => String((JSON.parse(row.payload_json) as { decision?: unknown }).decision))
  } finally {
    handle.close()
  }
}

/** How many times the control journal recorded a turn opening for a run. */
const countTurns = (root: string, runId: string): number => {
  const handle = new DatabaseSync(join(root, "control.db"), { readOnly: true })
  try {
    const row = handle.prepare(
      "SELECT COUNT(*) AS turns FROM flows_journal_events WHERE run_id = ? AND event_type = 'control.agent.turn-opened'"
    ).get(runId) as unknown as { readonly turns: number }
    return row.turns
  } finally {
    handle.close()
  }
}

/**
 * Rewrites one engine row into the state a launcher killed between the two
 * settlement writes leaves behind: `suspended`/`released`, no result, no
 * owner and no claim. It is the row the release validation read for run-1 and
 * run-9, written directly here so the pin survives the fix that stops the
 * launcher producing it.
 */
const releaseEngineRow = (root: string, runId: string): void => {
  const handle = new DatabaseSync(join(root, "engine.db"))
  try {
    handle.prepare(
      `UPDATE flows_runs SET status = 'suspended', waiting_reason = 'released', finished_at_ms = NULL,
         owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL, heartbeat_at_ms = NULL,
         claim_host_id = NULL, claim_pid = NULL, claim_nonce = NULL, claimed_at_ms = NULL,
         state_json = json_remove(state_json, '$.result')
       WHERE run_id = ?`
    ).run(runId)
  } finally {
    handle.close()
  }
}

const firstOwner: Ownership.OwnerId = { hostId: "completed-persist-first", pid: 1, nonce: "first" }
const secondOwner: Ownership.OwnerId = { hostId: "completed-persist-second", pid: 2, nonce: "second" }

const launch = Effect.gen(function*() {
  const control = yield* Control.Control
  const card = yield* control.plan({ flowId: "agents/hello", input: {} })
  yield* control.approve(card.approval)
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "run:hello"
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
    return yield* Effect.die("expected an accepted run")
  }
  return receipt.runId
})

/**
 * Waits for exactly the event `packages/smithers/src/Command.ts` `awaitRun` returns
 * on, and returns the moment it lands. Polling the engine row instead would
 * hand the engine a head start the CLI never gives it.
 */
const awaitCompletionEvent = (runId: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    yield* control.watch({ runId }).pipe(
      Stream.filter((event) => event.kind === "control.run.completed"),
      Stream.take(1),
      Stream.runCollect
    )
  })

/**
 * Follows the engine journal until the terminal row's transaction commits.
 * A fresh reader also replays a decision committed before it subscribed.
 */
const terminalEngineRow = (root: string, runId: string, afterSequence?: JournalEvent.Seq) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.stream({
      runId: JournalEvent.RunId.make(runId),
      ...(afterSequence === undefined ? {} : { afterSequence })
    }).pipe(
      Stream.filter((entry) =>
        entry.eventType === "flows.engine.run-decision" &&
        typeof entry.payload === "object" && entry.payload !== null &&
        "decision" in entry.payload && entry.payload.decision === "transitioned" &&
        "status" in entry.payload && ["completed", "failed", "cancelled"].includes(String(entry.payload.status))
      ),
      Stream.take(1),
      Stream.runDrain
    )
    return readRun(root, "engine.db", runId)
  })

/** Reads the committed engine decision independently of the launching process. */
const settledEngineRow = (root: string, runId: string, afterSequence?: JournalEvent.Seq): Promise<RunRow | undefined> =>
  Effect.runPromise(
    terminalEngineRow(root, runId, afterSequence).pipe(
      Effect.provide(
        NodeRuntime.storage(join(root, "engine.db"), root).pipe(
          Layer.provide([AtomicFileSystem.layer, NodeCrypto.layer])
        )
      ),
      Effect.scoped,
      Effect.orDie
    )
  )

describe("a run the control plane reported completed", () => {
  it("has a terminal engine row when the launching process is gone, with no interrupt-released decision", async () => {
    const root = makeRoot()

    // One launching process's whole lifetime: launch, wait for the settlement
    // event, exit. That is `runLaunch` in `packages/smithers/src/Command.ts`.
    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        yield* awaitCompletionEvent(id)
        return id
      }).pipe(Effect.provide(host(root, firstOwner, "completed-persist-first")), Effect.scoped, Effect.orDie)
    )

    const engineRow = await settledEngineRow(root, runId)

    expect(readRun(root, "control.db", runId)?.status).toBe("completed")
    expect(engineRow?.status).toBe("completed")
    expect(engineRow?.finished_at_ms).not.toBeNull()
    expect(engineRow?.waiting_reason).toBeNull()
    expect(readDecisions(root, runId)).not.toContain("interrupt-released")
  }, 120_000)

  it("is not claimed, activated, or re-billed by the next process over the same `.flows`", async () => {
    const root = makeRoot()

    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        yield* awaitCompletionEvent(id)
        return id
      }).pipe(Effect.provide(host(root, firstOwner, "completed-persist-first")), Effect.scoped, Effect.orDie)
    )
    await settledEngineRow(root, runId)

    expect(calls).toEqual(["completed-persist-first"])
    const turnsAfterFirst = countTurns(root, runId)
    const decisionsAfterFirst = readDecisions(root, runId)
    let successorSweeps = 0
    const swept = Deferred.makeUnsafe<void>()
    const onSweep = Effect.gen(function*() {
      successorSweeps++
      if (successorSweeps >= 3) yield* Deferred.succeed(swept, undefined)
    })

    await Effect.runPromise(
      Deferred.await(swept).pipe(
        Effect.provide(host(root, secondOwner, "completed-persist-second", onSweep)),
        Effect.scoped,
        Effect.orDie
      )
    )

    // The launching process's own claim is the only one this run ever gets.
    expect(successorSweeps).toBeGreaterThanOrEqual(3)
    expect(decisionsAfterFirst).toEqual(["created", "claimed-and-activated", "resumed", "transitioned"])
    expect(readDecisions(root, runId)).toEqual(decisionsAfterFirst)
    expect(countTurns(root, runId)).toBe(turnsAfterFirst)
    expect(calls).toEqual(["completed-persist-first"])
    expect(notes).toEqual(["completed-persist-first:done"])
  }, 120_000)
})

/**
 * The other half of the finding: what a process that finds one of these rows
 * already on disk must do with it.
 *
 * A launcher killed between `control.run.completed` and the engine's terminal
 * write leaves `suspended`/`released` with no result. That row is reclaimable
 * by design, and the release policy allows one terminal write per run, so
 * the reclaiming process must finish it rather than run the agent turn a
 * second time. In the smoke it ran the turn: ten processes replayed run-1
 * between them.
 */
describe("a released engine row whose control row is already terminal", () => {
  it("is settled by the next process without re-opening the run's turn", async () => {
    const root = makeRoot()

    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        yield* awaitCompletionEvent(id)
        return id
      }).pipe(Effect.provide(host(root, firstOwner, "completed-persist-first")), Effect.scoped, Effect.orDie)
    )
    await settledEngineRow(root, runId)
    const turnsAfterFirst = countTurns(root, runId)

    const beforeCrash = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const entries = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1000 })
        return entries.entries.at(-1)!.seq
      }).pipe(
        Effect.provide(
          NodeRuntime.storage(join(root, "engine.db"), root).pipe(
            Layer.provide([AtomicFileSystem.layer, NodeCrypto.layer])
          )
        ),
        Effect.scoped
      )
    )

    // The crash, written straight onto the row.
    releaseEngineRow(root, runId)
    expect(readRun(root, "engine.db", runId)?.status).toBe("suspended")
    expect(readRun(root, "control.db", runId)?.status).toBe("completed")

    await Effect.runPromise(
      Effect.promise(() => settledEngineRow(root, runId, beforeCrash)).pipe(
        Effect.provide(host(root, secondOwner, "completed-persist-second")),
        Effect.scoped,
        Effect.orDie
      )
    )

    // Reclaimed and finished, never re-executed: no second turn, no second
    // model call, and one more note would mean the cell ran again.
    expect(countTurns(root, runId)).toBe(turnsAfterFirst)
    expect(calls).toEqual(["completed-persist-first"])
    expect(notes).toEqual(["completed-persist-first:done"])
    const row = await settledEngineRow(root, runId)
    expect(row?.status).toBe("completed")
    expect(row?.finished_at_ms).not.toBeNull()
  }, 120_000)
})
