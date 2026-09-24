/*
 * Records the run-events fixture the live run graph is folded against.
 *
 *   cd apps/app && pnpm exec tsx scripts/flow-graph-record-journal.ts
 *
 * It writes `src/mainview/cards/fixtures/GraphRunJournal.json`: the plan the
 * control plane answered with, and every `run-events` row one completed
 * `gateway/GraphFixture` run produced, verbatim.
 *
 * The composition is the one `scripts/flow-graph-e2e-gateway.mts` holds open
 * for the browser — `packages/smithers/test/BridgedEngineRun.ts`: a real
 * control plane, a real engine over two SQLite files, and the
 * `EngineJournalSupervisor` bridge a deployed host wires. The relay in front
 * of it is HTTP framing and changes no journal row, so this command drives
 * the stack directly and needs no browser, no credential and no SPA build.
 *
 * Nothing in the file may be edited by hand. `FlowGraphStatus.test.ts` decodes
 * it with the same strict schemas the app decodes a live run with, so an
 * invented field fails there rather than becoming a fact the UI believes.
 */
import { Control } from "@smthrs/control/Control"
import type { ApprovalPayload, PlanCard } from "@smthrs/control/ControlSchema"
import { Projections } from "@smthrs/gateway/Projections"
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { bridgeSettledKind, Engine, flowId, relayPrincipal, stack } from "../../../packages/smithers/test/BridgedEngineRun.ts"
/*
 * The app's own reduction, imported rather than copied: the fixture carries
 * exactly what a launch writes onto a run card, so a change to one cannot
 * leave the other recording a shape the app never holds.
 */
import { planCardNode } from "../src/mainview/cards/PlanNodes.ts"

/** The label the fixture run is planned on; the plan keys off it. */
const LABEL = "recorded"

const DESTINATION = fileURLToPath(new URL("../src/mainview/cards/fixtures/GraphRunJournal.json", import.meta.url))

const approvalOf = (card: PlanCard): ApprovalPayload => ({
  target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

/**
 * The run's events once the bridge has drained the engine's journal.
 *
 * The control plane settles a run from its own observation, and the copy runs
 * on a fiber afterwards, so a snapshot taken on the run's status would record
 * a half-copied history. The bridge's own settled marker is what says the
 * copy is finished.
 */
const drained = (runId: string, attempts = 4_000): Effect.Effect<ReadonlyArray<unknown>, never, Projections> =>
  Effect.gen(function*() {
    const projections = yield* Projections
    const rows = (yield* Effect.orDie(projections.snapshot({ _tag: "run-events", runId }))).rows
    if (rows.some((row) => row.kind === bridgeSettledKind)) return rows
    if (attempts <= 0) return yield* Effect.die(`the bridge never drained ${runId}`)
    yield* Effect.sleep("5 millis")
    return yield* drained(runId, attempts - 1)
  })

const program = Effect.gen(function*() {
  const control = yield* Control
  const engine = yield* Engine
  const card = yield* control.plan({ flowId, input: { label: LABEL } })
  // As the relay submits it: a browser holds no gateway credential, so a
  // card's decision arrives stamped with the gateway's own identity.
  yield* control.approve({ ...approvalOf(card), principal: relayPrincipal })
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("the fixture plan was not accepted")
  const runId = receipt.runId
  // The gate is three `.child()` boundaries down, held by an execution the
  // control plane's database has never heard of. Answering it before it parks
  // would be answering nothing.
  yield* engine.parkedBelow(runId)
  yield* control.signal({ runId, signal: { name: "graph-gate", payload: "merged" }, idempotencyKey: `gate:${runId}` })
  const status = yield* engine.settled(runId)
  if (status !== "completed") return yield* Effect.die(`the fixture run settled ${status}, not completed`)
  const rows = yield* drained(runId)
  const recorded = {
    flow: flowId,
    input: { label: LABEL },
    runId,
    plan: { planId: card.planId, digest: card.digest, nodes: card.nodes.map(planCardNode) },
    rows
  }
  yield* Effect.sync(() => {
    // One row per line. A journal row is a hundred lines pretty-printed, and a
    // re-recording would then read as a whole-file rewrite rather than as the
    // rows that changed.
    const head = JSON.stringify({ flow: recorded.flow, input: recorded.input, runId, plan: recorded.plan })
    writeFileSync(DESTINATION, `${head.slice(0, -1)},\n"rows": [\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]}\n`)
    console.log(`[flow-graph] recorded ${rows.length} rows of ${runId} into ${DESTINATION}`)
  })
}).pipe(Effect.provide(stack), Effect.scoped)

Effect.runPromise(program as Effect.Effect<void, unknown, never>).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
