/**
 * SQL rows are outside the TypeScript boundary. Every JSON column is decoded
 * before it can steer control flow or reach the RPC projection.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Cancellation from "../src/Cancellation.ts"
import { ClaimLost, PersistenceError } from "../src/ControlError.ts"
import { ControlRuntime, type Service } from "../src/ControlRuntime.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import { durable, type DurableStack } from "./DurableStack.ts"

const raw = "RAW-CORRUPT-VALUE"
const principal = { id: "operator", kind: "test", stampedAt: 0 } as const

const run = <A, E>(body: Effect.Effect<A, E, DurableStack>): Promise<A> =>
  Effect.runPromise(
    body.pipe(Effect.provide(durable({ approvalAuthority: delegateApproval(principal) })), Effect.scoped, Effect.orDie)
  )

const plan = (runtime: Service) => runtime.plan({ flowId: "system/test", input: { suite: "decode" } })

const start = (runtime: Service) =>
  Effect.gen(function*() {
    const { card } = yield* plan(runtime)
    const token = yield* runtime.lookupApproval(card.approval.target)
    yield* runtime.installBulkGrant(token, card.envelope, "run")
    yield* runtime.resolveApproval(token, "approved", principal)
    const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
    if (launched._tag !== "Started") return yield* Effect.die("expected a started run")
    return { card, run: launched.run }
  })

const expectPersistence = (error: unknown, operation: string): void => {
  expect(error).toBeInstanceOf(PersistenceError)
  expect((error as PersistenceError).operation).toBe(operation)
  expect((error as PersistenceError).message).toContain("$")
  expect((error as PersistenceError).message).not.toContain(raw)
}

describe("SqlControlRuntime persisted JSON decoding", () => {
  it("reports invalid plan-card JSON through PersistenceError", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      const { card } = yield* plan(runtime)
      yield* sql`UPDATE control_plans SET card_json = ${`{"broken":"${raw}"`} WHERE plan_id = ${card.planId}`
        .pipe(Effect.orDie)
      return yield* Effect.flip(runtime.getPlan(card.planId))
    }))

    expectPersistence(error, "decode control_plans.card_json")
  })

  it("reports invalid decoded-input JSON through PersistenceError", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      const { card } = yield* plan(runtime)
      yield* sql`UPDATE control_plans SET decoded_input_json = ${`{"broken":"${raw}"`} WHERE plan_id = ${card.planId}`
        .pipe(Effect.orDie)
      return yield* Effect.flip(runtime.getPlan(card.planId))
    }))

    expectPersistence(error, "decode control_plans.decoded_input_json")
  })

  it("rejects an unknown stored plan decision", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      const { card } = yield* plan(runtime)
      yield* sql`UPDATE control_plans SET decision = ${raw} WHERE plan_id = ${card.planId}`.pipe(Effect.orDie)
      return yield* Effect.flip(runtime.getPlan(card.planId))
    }))

    expectPersistence(error, "decode control_plans.decision")
  })

  it("rejects a structurally invalid control run summary", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      const { run: summary } = yield* start(runtime)
      yield* sql`UPDATE flows_runs SET state_json = ${
        JSON.stringify({
          ...summary,
          status: raw
        })
      } WHERE run_id = ${summary.runId}`.pipe(Effect.orDie)
      return yield* Effect.flip(runtime.getRun(summary.runId))
    }))

    expectPersistence(error, "decode flows_runs.state_json as RunSummary")
  })

  it("rejects a structurally invalid engine state", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      yield* store.create(
        "engine-corrupt",
        JSON.stringify({ version: 1, flowName: "system/test", payload: {} })
      ).pipe(Effect.orDie)
      yield* sql`UPDATE flows_runs SET state_json = ${JSON.stringify({ flowName: { marker: raw } })}
        WHERE run_id = 'engine-corrupt'`
        .pipe(Effect.orDie)
      return yield* Effect.flip(runtime.getRun("engine-corrupt"))
    }))

    expectPersistence(error, "decode flows_runs.state_json as engine state")
  })

  it("rejects a structurally invalid approval target", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      const { card } = yield* plan(runtime)
      yield* sql`UPDATE control_tokens SET target_json = ${
        JSON.stringify({
          _tag: "Plan",
          planId: card.planId,
          digest: raw,
          envelope: { capabilities: raw, flows: [], budget: {} }
        })
      } WHERE token_id = ${card.planId}`.pipe(Effect.orDie)
      return yield* Effect.flip(runtime.lookupApproval(card.approval.target))
    }))

    expectPersistence(error, "decode control_tokens.target_json")
  })

  it("reads legacy signal history without touching obsolete steering rows", async () => {
    const observed = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      const { run: summary } = yield* start(runtime)
      yield* sql`INSERT INTO control_run_messages (run_id, kind, payload_json)
        VALUES (${summary.runId}, 'steer', 'not json')`
      yield* runtime.deliverSignal(summary.runId, { name: "legacy", payload: null })
      return {
        signals: yield* runtime.deliveredSignals(summary.runId),
        remaining: yield* sql`SELECT kind FROM control_run_messages WHERE run_id = ${summary.runId} ORDER BY seq`
      }
    }))
    expect(observed.signals).toEqual([{ name: "legacy", payload: null }])
    expect(observed.remaining).toEqual([{ kind: "steer" }, { kind: "signal" }])
  })

  it("rejects a structurally invalid signal message", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      const { run: summary } = yield* start(runtime)
      yield* sql`
        INSERT INTO control_run_messages (run_id, kind, payload_json)
        VALUES (${summary.runId}, 'signal', ${JSON.stringify({ marker: raw, payload: null })})
      `.pipe(Effect.orDie)
      return yield* Effect.flip(runtime.deliveredSignals(summary.runId))
    }))

    expectPersistence(error, "decode control_run_messages.payload_json as signal")
  })

  it("rejects a structurally invalid attributed-cancel journal payload", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const journal = yield* Journal.Journal
      const { run: summary } = yield* start(runtime)
      yield* journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(summary.runId),
          sourceId: JournalEvent.SourceId.make("control-test"),
          eventType: Cancellation.requestedEventType,
          payload: { principal: raw }
        })
      ).pipe(Effect.orDie)
      return yield* Effect.flip(runtime.getRun(summary.runId))
    }))

    expectPersistence(error, "decode flows_journal_events.payload_json for control.run.cancel-requested")
  })

  it("rejects a structurally invalid engine-interruption journal payload", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const journal = yield* Journal.Journal
      const { run: summary } = yield* start(runtime)
      yield* journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(summary.runId),
          sourceId: JournalEvent.SourceId.make("engine-test"),
          eventType: Cancellation.interruptedEventType,
          payload: { outcome: "cancelled", interruptedAtMs: raw }
        })
      ).pipe(Effect.orDie)
      return yield* Effect.flip(runtime.getRun(summary.runId))
    }))

    expectPersistence(error, "decode flows_journal_events.payload_json for flows.engine.interrupted")
  })

  it("rejects a structurally invalid mutation receipt", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO control_mutations (mutation_key, fingerprint, receipt_json)
        VALUES ('mutation-corrupt', 'fingerprint', ${JSON.stringify({ _tag: raw })})
      `.pipe(Effect.orDie)
      return yield* Effect.flip(runtime.lookupMutation("mutation-corrupt", "fingerprint"))
    }))

    expectPersistence(error, "decode control_mutations.receipt_json")
  })

  it("rejects a structurally invalid grant", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO control_grants (
          target_tag, run_id, target_id, token_id, envelope_json, scope, installed_at_ms
        )
        VALUES (
          'Node', 'run-corrupt', 'grant-corrupt', 'grant-corrupt',
          ${JSON.stringify({ capabilities: raw, flows: [], budget: {} })}, 'run', 1
        )
      `.pipe(Effect.orDie)
      return yield* Effect.flip(runtime.grants)
    }))

    expectPersistence(error, "decode control_grants.envelope_json")
  })

  it("rejects a structurally invalid fence as a lost claim", async () => {
    const error = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const { run: summary } = yield* start(runtime)
      return yield* Effect.flip(runtime.writeStatus(
        summary.runId,
        JSON.stringify({ hostId: "local", pid: raw, nonce: "fence" }),
        "running"
      ))
    }))

    expect(error).toBeInstanceOf(ClaimLost)
  })
})
