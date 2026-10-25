import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node, type Planned } from "@smthrs/plan"
import { Effect, Layer, Metric, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ADMIT_WAIT_SECONDS, FAILURES, OPEN_DEADLINE_SECONDS } from "../../src/features/terminal/contract.ts"
import * as Budget from "../branch/Budget.ts"
import { CheckoutFailed, SandboxBranch, Sandboxes, SandboxUnavailable } from "../branch/Sandboxes.ts"
import { codeOf } from "../ErrorCode.ts"

// `terminal/Open { terminalId, branch }` (decision 0013 §2, docs/features/branch-workspace.md#opening-a-terminal):
// opens a person's terminal on a branch's machine. `POST /api/terminals` admits it (sign-in, the Member role, a branch
// that isn't locked) and records its `opening` row, then starts this flow, one execution per terminal
// (`terminal-open:<id>`).
//
//   sandbox/Admit ─▶ sandbox/Wake ─▶ terminal/Session ─▶ terminal/Record (open, with the generation)
//        └ no machine free: the row says `waiting` ("Waiting for a sandbox"); asked again for up to 30 minutes
//        └ failed: no machine free in time, no machine, or no checkout ──▶ terminal/Record (failed)
//
// `sandbox/Admit` holds the branch a machine under the sandbox limits (worker/branch/Budget.ts, decision 0103) before it
// wakes, so a terminal waits for a free machine instead of failing; its open's deadline counts from then.
//
// It runs remotely because it needs a machine (decision 0011 §2). The host injects the machine (`Sandboxes`: on
// Cloudflare, the branch's `SandboxObject` and its container) and Postgres. Opening is durable; the shell's bytes are
// not: they stream over the terminal's socket, outside any journal (decision 0013, decision 6).

/** Postgres couldn't record the outcome. Retried. */
export class RecordUnavailable extends Schema.TaggedError<RecordUnavailable>()(
  "@smthrs/mvp/terminal/RecordUnavailable",
  {},
) {}

/** Terminal opens, by `outcome`: `open`, or the failure (`unavailable`, `checkout`). */
export const opens = Metric.counter("smithers_terminal_opens", {
  description: "Terminals terminal/Open settled, by outcome",
  incremental: true,
})

/** Waking and starting the session: 1 s doubling to 15 s, for at most 2 minutes; a refused checkout isn't retried. */
export const MACHINE_RETRY = RetryPolicy.make({
  initialMs: 1_000,
  factor: 2,
  maxMs: 15_000,
  expirationMs: 2 * 60_000,
  nonRetryable: ["@smthrs/mvp/branch/CheckoutFailed"],
})

/**
 * Waiting for a free machine: 5 s doubling to 30 s, for `ADMIT_WAIT_SECONDS`, while the sandbox limits leave none
 * free or Postgres can't be asked.
 */
export const ADMIT_RETRY = RetryPolicy.make({
  initialMs: 5_000,
  factor: 2,
  maxMs: 30_000,
  expirationMs: ADMIT_WAIT_SECONDS * 1000,
})

/** No machine is free under the sandbox limits: the terminal waits. Retried. */
export class NoSandboxFree extends Schema.TaggedError<NoSandboxFree>()("@smthrs/mvp/terminal/NoSandboxFree", {}) {}

/** Postgres couldn't be asked for a machine, or couldn't record the wait. Retried. */
export class AdmitUnavailable extends Schema.TaggedError<AdmitUnavailable>()("@smthrs/mvp/terminal/AdmitUnavailable", {}) {}

/** Recording: 1 s doubling to a minute, for at most 30 minutes, while Postgres is unreachable. */
export const RECORD_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

const TerminalId = Schema.String.check(Schema.isUUID())

/** What a run is for: the terminal, and the branch whose machine it runs on. */
const payload = { terminalId: TerminalId, ownerId: Schema.String, branch: SandboxBranch }

/** How the open ended: open on a generation of the machine, or failed and why. */
export const Outcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("open"), generation: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("failed"), failure: Schema.Literals(FAILURES) }),
])
export type Outcome = typeof Outcome.Type

/**
 * Holds the branch a machine under the sandbox limits for the terminal's owner, and records on the terminal's row
 * whether it waits for one: `NoSandboxFree` while none is free.
 */
export const Admit = Action.make("sandbox/Admit", {
  payload: { terminalId: TerminalId, ownerId: Schema.String, branch: SandboxBranch },
  success: Schema.Struct({ awake: Schema.Number }),
  error: Schema.Union([NoSandboxFree, AdmitUnavailable]),
  capabilities: ["db:write:sandbox_generations", "db:write:terminal_sessions"],
  retryPolicy: ADMIT_RETRY,
})

/** Wakes the branch's machine, checked out at the branch, and answers its generation. */
export const Wake = Action.make("sandbox/Wake", {
  payload: { branch: SandboxBranch, ownerId: Schema.optional(Schema.String) },
  success: Schema.Struct({ generation: Schema.Number }),
  error: Schema.Union([SandboxUnavailable, CheckoutFailed]),
  capabilities: ["sandbox:wake"],
  retryPolicy: MACHINE_RETRY,
})

/**
 * Starts the terminal's shell session on the machine unless it is there, as its owner's own user, and answers the open
 * outcome on the generation the wake answered.
 */
export const Session = Action.make("terminal/Session", {
  payload: { branchId: Schema.String, terminalId: TerminalId, ownerId: Schema.String, generation: Schema.Number },
  success: Outcome,
  error: SandboxUnavailable,
  capabilities: ["sandbox:exec"],
  retryPolicy: MACHINE_RETRY,
})

/** What a machine's failure means to the terminal: `checkout` when the forge refused the clone, else `unavailable`. */
export const Failed = Action.make("terminal/Failed", {
  payload: { error: Schema.Union([SandboxUnavailable, CheckoutFailed, NoSandboxFree, AdmitUnavailable]) },
  success: Outcome,
  tier: "sealed",
})

/** Records how the open ended on the terminal's row, only while it is `opening`. */
export const Record = Action.make("terminal/Record", {
  payload: { terminalId: TerminalId, outcome: Outcome },
  success: Schema.Struct({ recorded: Schema.Boolean }),
  error: RecordUnavailable,
  capabilities: ["db:write:terminal_sessions"],
  retryPolicy: RECORD_RETRY,
})

/** `terminal/Open`: opens a person's terminal on a branch's machine. */
export const TerminalOpen = Flow.make("terminal/Open", {
  description: "Open a person's terminal on a branch's machine: wake the machine, start the shell session, record it.",
  capabilities: ["sandbox:wake", "sandbox:exec", "db:write:sandbox_generations", "db:write:terminal_sessions"],
  modelInvocable: false,
  payload,
  success: Record.successSchema,
  // The machine's failures are recorded on the row and never escape; the union says what the steps may fail with.
  error: Schema.Union([RecordUnavailable, SandboxUnavailable, CheckoutFailed, NoSandboxFree, AdmitUnavailable]),
  body: Node.capture(
    { admit: Admit.name, wake: Wake.name, session: Session.name, failed: Failed.name, record: Record.name },
    ({ terminalId, ownerId, branch }) =>
      Admit.call({ terminalId, ownerId, branch }).pipe(
        Node.bindPlanned(Node.capture({ wake: Wake.name }, () => Wake.call({ branch, ownerId }))),
        Node.bindPlanned(Node.capture({ session: Session.name }, (woken: Planned.Planned<{ readonly generation: number }>) =>
          Session.call({ branchId: branch.branchId, terminalId, ownerId, generation: woken.generation }))),
        Node.catch({
          onFailure: Node.capture(
            { failed: Failed.name },
            (error: Planned.Planned<SandboxUnavailable | CheckoutFailed | NoSandboxFree | AdmitUnavailable>) =>
              Failed.call({ error }),
          ),
        }),
        Node.bindPlanned(Node.capture({ record: Record.name }, (outcome: Planned.Planned<Outcome>) =>
          Record.call({ terminalId, outcome }))),
      ),
  ),
})

/**
 * Writes `outcome` to terminal `terminalId`'s row while it is `opening`: whether it did. An open that comes past the
 * deadline (`OPEN_DEADLINE_SECONDS` after its machine was admitted, else after the row was made) settles `failed`
 * instead, as the person's next open would.
 */
export const record = (terminalId: string, outcome: Outcome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = outcome.status === "open"
      ? yield* sql`
        UPDATE terminal_sessions SET
          status = CASE WHEN coalesce(admitted_at, created_at) > now() - make_interval(secs => ${OPEN_DEADLINE_SECONDS}) THEN 'open' ELSE 'failed' END,
          generation = ${outcome.generation},
          failure = CASE WHEN coalesce(admitted_at, created_at) > now() - make_interval(secs => ${OPEN_DEADLINE_SECONDS}) THEN NULL ELSE 'unavailable' END,
          ended_at = CASE WHEN coalesce(admitted_at, created_at) > now() - make_interval(secs => ${OPEN_DEADLINE_SECONDS}) THEN NULL ELSE now() END,
          waiting = false,
          updated_at = now()
        WHERE id = ${terminalId} AND status = 'opening'
        RETURNING id`
      : yield* sql`
        UPDATE terminal_sessions SET status = 'failed', failure = ${outcome.failure}, waiting = false, updated_at = now(),
          ended_at = now()
        WHERE id = ${terminalId} AND status = 'opening' RETURNING id`
    return { recorded: rows.length > 0 }
  })

/**
 * Records on terminal `terminalId`'s row, while it is `opening`, whether it waits for a machine: `waiting`, or, once one
 * that waited is admitted, when (`admitted_at`), from which its open's deadline counts. One that never waited keeps
 * its deadline from when it was asked for.
 */
export const markAdmission = (terminalId: string, waiting: boolean) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    waiting
      ? sql`UPDATE terminal_sessions SET waiting = true, updated_at = now() WHERE id = ${terminalId} AND status = 'opening' AND NOT waiting`
      : sql`
        UPDATE terminal_sessions SET waiting = false, admitted_at = now(), updated_at = now()
        WHERE id = ${terminalId} AND status = 'opening' AND waiting`)

/** The steps over the host's `Sandboxes` and `database`, each recording what it did; none records a byte of the shell. */
export const steps = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const admit = ({ terminalId, ownerId, branch }: typeof Admit.payloadSchema.Type) =>
    Effect.gen(function* () {
      const slot = { branchId: branch.branchId, personId: Budget.personOf(ownerId), kind: Budget.kindOf(branch) }
      const admission = yield* Budget.observedAdmit(slot, database)
      yield* markAdmission(terminalId, admission._tag === "Waiting").pipe(Effect.provide(database))
      return admission
    }).pipe(
      Effect.mapError(() => new AdmitUnavailable()),
      Effect.flatMap((admission) =>
        admission._tag === "Waiting" ? Effect.fail(new NoSandboxFree()) : Effect.succeed({ awake: admission.awake })
      ),
      Effect.withSpan("terminal.admit", { attributes: { "smithers.terminal.id": terminalId } }),
    )

  const wake = ({ branch, ownerId }: typeof Wake.payloadSchema.Type) =>
    Effect.flatMap(Sandboxes, (sandboxes) => sandboxes.wake(branch, ownerId)).pipe(
      Effect.tap(({ generation }) =>
        Effect.logInfo("terminal.open.wake").pipe(Effect.annotateLogs({ branchId: branch.branchId, generation }))
      ),
      Effect.tapError((error) =>
        Effect.logWarning("terminal.open.wake").pipe(
          Effect.annotateLogs({ branchId: branch.branchId, errorCode: codeOf(error) }),
        )
      ),
      Effect.withSpan("sandbox.wake", { attributes: { "smithers.branch.id": branch.branchId } }),
    )

  const session = ({ branchId, terminalId, ownerId, generation }: typeof Session.payloadSchema.Type) =>
    Effect.flatMap(Sandboxes, (sandboxes) => sandboxes.session(branchId, terminalId, ownerId)).pipe(
      Effect.as<Outcome>({ status: "open", generation }),
      Effect.withSpan("terminal.session", { attributes: { "smithers.terminal.id": terminalId } }),
    )

  const failed = ({ error }: typeof Failed.payloadSchema.Type) =>
    Effect.succeed<Outcome>({
      status: "failed",
      failure: error._tag === "@smthrs/mvp/branch/CheckoutFailed" ? "checkout" : "unavailable",
    })

  const settle = ({ terminalId, outcome }: typeof Record.payloadSchema.Type) =>
    record(terminalId, outcome).pipe(
      Effect.provide(database),
      Effect.mapError(() => new RecordUnavailable()),
      Effect.tap(({ recorded }) =>
        Effect.andThen(
          recorded
            ? Metric.update(
              Metric.withAttributes(opens, { outcome: outcome.status === "open" ? "open" : outcome.failure }),
              1,
            )
            : Effect.void,
          Effect.logWithLevel(outcome.status === "open" ? "Info" : "Warn")("terminal.open").pipe(
            Effect.annotateLogs({
              terminalId,
              outcome: outcome.status === "open" ? "open" : outcome.failure,
              recorded,
            }),
          ),
        )
      ),
      Effect.withSpan("terminal.open", { attributes: { "smithers.terminal.id": terminalId } }),
    )

  return { admit, wake, session, failed, settle }
}

/** Registers `terminal/Open` with its steps over `database` and the host's `Sandboxes`. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const implementation = steps(database)
  return Interpreter.layerWithImplementations(
    TerminalOpen,
    Layer.mergeAll(
      Admit.toLayer(implementation.admit),
      Wake.toLayer(implementation.wake),
      Session.toLayer(implementation.session),
      Failed.toLayer(implementation.failed),
      Record.toLayer(implementation.settle),
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}
