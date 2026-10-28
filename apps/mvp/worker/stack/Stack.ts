import { digestSync } from "@smthrs/crypto"
import { Clock, Context, Effect, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { foldCommit } from "./StackFeed.ts"
import { todoExecutionId } from "../../src/features/pulls/contract.ts"
import {
  STACK_OUTCOMES,
  type StackOutcome,
  type StackVia,
  type TodoFailure,
  type TodoNote,
  type TodoState,
  type TodoStep,
} from "../../src/features/todos/contract.ts"
import {
  apply as applyRules,
  type FinishedState,
  type Result,
  type Row,
  type Stack,
  type Start,
} from "../../src/features/todos/stack.ts"

// The one writer of a repository's stack (decision 0016 §1): the only code that writes `stacks`, `todos`,
// `todo_requests`, `todo_attempts` and `stack_ops`. Each change is one short transaction that locks the repository's
// `stacks` row first and makes no network or model call: it loads the open TODOs, applies the stack's rules
// (src/features/todos/stack.ts), writes back what changed, and keeps a receipt under the change's op id, so a repeated
// op answers the same and another payload under the same id is refused. Concurrent writers queue on the row lock, so
// none loses another's change. Buttons, slash commands, the agent and the API reach it only through the stack route
// (worker/stack/Api.ts); the `todo` run (decision 0016 Track B) calls it in process.

/** A change to a stack, as the route admitted it. A commit's op id is its TODO's id. */
export interface Change {
  readonly opId: string
  readonly repoId: string
  readonly actor: { readonly id: string; readonly login: string }
  readonly via: StackVia
  readonly op:
    | {
      readonly kind: "commit"
      readonly title: string
      readonly prompt: string
      readonly acceptance: ReadonlyArray<string>
      /** The issue in the same repository it was drafted from (`todos.issue_number`). */
      readonly issue?: number
    }
    | { readonly kind: "drop" | "retry"; readonly number: number }
  readonly retryAny?: boolean
}

export class RetryForbidden extends Schema.TaggedError<RetryForbidden>()("@smthrs/mvp/stack/RetryForbidden", {}) {}

/** An attempt the writer recorded: Track B's `todo` run starts under its id, once per attempt. */
export const AttemptStart = Schema.Struct({
  attemptId: Schema.String,
  todoId: Schema.String,
  repoId: Schema.String,
  number: Schema.Number,
  ordinal: Schema.Number,
  revision: Schema.Number,
})
export type AttemptStart = typeof AttemptStart.Type

/** A dropped TODO's attempt that held a lane: its run must stop. */
export const AttemptStop = Schema.Struct({ attemptId: Schema.String, todoId: Schema.String })
export type AttemptStop = typeof AttemptStop.Type

/**
 * What a change did, kept as its receipt (`stack_ops.result`): its outcome, the TODO's number (absent when the stack
 * refused it for being full), the attempts it started, and the attempt it stopped.
 */
export const Receipt = Schema.Struct({
  outcome: Schema.Literals(STACK_OUTCOMES),
  number: Schema.optional(Schema.Number),
  starts: Schema.Array(AttemptStart),
  stopped: Schema.optional(AttemptStop),
})
export type Receipt = typeof Receipt.Type
const decodeReceipt = Schema.decodeUnknownSync(Receipt)

/**
 * How a change went: `applied` in transaction `txid` (Electric's `awaitTxId`), `repeated` (its op id already answered
 * this payload, with its receipt), or `conflict` (its op id answered another payload).
 */
export type Applied =
  | { readonly kind: "applied"; readonly txid: number; readonly version: number; readonly receipt: Receipt }
  | { readonly kind: "repeated"; readonly receipt: Receipt }
  | { readonly kind: "conflict" }
  /** `holds` answered false: the person's role changed after the route read it; nothing was recorded. */
  | { readonly kind: "stale" }

/**
 * Starts and stops the `todo` runs of the attempts the writer records (decision 0016 §1, "Starting runs"): Track B's
 * seam. Both are idempotent by attempt id: a repeated op starts the same run again, which changes nothing. Until a host
 * provides it, nothing runs a TODO, so the writer starts none and every TODO stays Queued.
 */
export class TodoRuns extends Context.Service<
  TodoRuns,
  {
    readonly start: (attempt: AttemptStart) => Effect.Effect<void, RunsUnavailable>
    readonly stop: (attempt: AttemptStop) => Effect.Effect<void, RunsUnavailable>
    readonly isStopped?: (attemptId: string) => Effect.Effect<boolean, RunsUnavailable>
  }
>()("@smthrs/mvp/stack/TodoRuns") {}

/** The run host couldn't take a start or stop: the route answers 503, and the outbox sends the op again. */
export class RunsUnavailable extends Schema.TaggedError<RunsUnavailable>()("@smthrs/mvp/stack/RunsUnavailable", {
  errorCode: Schema.String,
}) {}

/** Changes the writer made, by `op` and `outcome`. */
export const changes = Metric.counter("smithers_stack_ops", {
  description: "Changes to a stack the writer made or refused, by op and outcome",
  incremental: true,
})

/** TODO state changes, by `from` and `to` (`new` for a commit). */
export const transitions = Metric.counter("smithers_todo_transitions", {
  description: "TODO state changes the stack's writer made, by from and to",
  incremental: true,
})

/** A change's payload hash: the repository, who it acts for and the change, never its op id. */
export const payloadHash = (change: Change): string =>
  digestSync(JSON.stringify({ repoId: change.repoId, ...(change.op.kind === "retry" ? { actorId: change.actor.id } : {}), via: change.via, ...change.op }))

/**
 * Records on the TODO the run its new attempt starts, `todo:<attempt id>` (`todos.run_id`, ruling TODO-3), in the
 * transaction that records the attempt: the TODO links to the run that works on it.
 */
const recordRun = (sql: SqlClient.SqlClient, start: AttemptStart) => Effect.gen(function* () {
  // Admission owns its dependency before a delayed execution can reach Begin. This lets cancellation find a
  // Working successor even when it has not made a branch or an engine run yet.
  const below = yield* belowOf(start)
  yield* sql`UPDATE todos SET run_id = ${todoExecutionId(start.attemptId)},
    base_ref = ${Option.isSome(below) ? below.value.branch : null}, base_reset = false WHERE id = ${start.todoId}::uuid`
  yield* Effect.logInfo("todo.run.requested").pipe(Effect.annotateLogs({
    "smithers.execution.id": todoExecutionId(start.attemptId), requestedAtMs: yield* Clock.currentTimeMillis,
  }))
})

/** One loaded TODO row. */
interface Loaded extends Row {
  readonly attemptId: string | null
}

/**
 * Applies `change` to its repository's stack in one transaction; `runs` says whether this host runs TODOs (a
 * `TodoRuns` is provided), and without it no TODO starts. A new op applies only while `holds` answers true in the same
 * transaction: on a repository other than the deployment's own, that the person still has the role the route decided
 * with (`RepoRoles.holds`, decision 0079 §6). Records a span `stack.apply`, a log line and a count of `changes` by op
 * and outcome, with the repository, op id, number and version: never a title or a prompt.
 */
export const apply = <E = never, R = never>(
  change: Change,
  options: { readonly runs: boolean; readonly stoppedAttemptId?: string; readonly holds?: Effect.Effect<boolean, E, R> },
) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const sql = yield* SqlClient.SqlClient
    const hash = payloadHash(change)
    const applied = yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO stacks (repo_id) VALUES (${change.repoId}) ON CONFLICT (repo_id) DO NOTHING`
      const [locked] = yield* sql<{ readonly nextNumber: number; readonly lanes: number; readonly maxOpen: number }>`
        SELECT next_number AS "nextNumber", lanes, max_open AS "maxOpen" FROM stacks
        WHERE repo_id = ${change.repoId} FOR UPDATE`
      const [prior] = yield* sql<{ readonly payloadHash: string; readonly result: unknown }>`
        SELECT payload_hash AS "payloadHash", result FROM stack_ops WHERE id = ${change.opId}::uuid`
      if (prior !== undefined) {
        return prior.payloadHash === hash
          ? ({ kind: "repeated", receipt: decodeReceipt(prior.result) } satisfies Applied)
          : ({ kind: "conflict" } satisfies Applied)
      }
      if (options.holds !== undefined && !(yield* options.holds)) return { kind: "stale" } satisfies Applied
      const named = change.op.kind !== "commit" ? change.op.number : 0
      if (change.op.kind === "retry" && !change.retryAny) {
        const [owner] = yield* sql<{ readonly createdBy: string }>`
          SELECT created_by AS "createdBy" FROM todos WHERE repo_id = ${change.repoId} AND number = ${named}`
        if (owner !== undefined && owner.createdBy !== change.actor.id) {
          return yield* new RetryForbidden({})
        }
      }
      const rows = yield* sql<Loaded>`
        SELECT t.id, t.number, t.state, t.position, t.attempt, t.revision, a.id AS "attemptId",
          (t.failure = 'base_closed' OR i.state = 'closed' AND NOT p.merged) IS TRUE AS "baseClosed", t.base_reset AS "baseReset"
        FROM todos t LEFT JOIN todo_attempts a ON a.todo_id = t.id AND a.ordinal = t.attempt
        LEFT JOIN pulls p ON p.repo_id = t.repo_id AND p.number = t.pr_number
        LEFT JOIN items i ON i.id = p.item_id
        WHERE t.repo_id = ${change.repoId} AND (t.position IS NOT NULL OR t.number = ${named})`
      const before: Stack = {
        nextNumber: locked!.nextNumber,
        lanes: options.runs ? locked!.lanes : 0,
        maxOpen: locked!.maxOpen,
        todos: rows.map(({ attemptId, ...row }) =>
          change.op.kind === "retry" && row.number === change.op.number && attemptId === options.stoppedAttemptId &&
          (row.state === "working" || row.state === "in_review") ? { ...row, state: "failed" as const } : row),
      }
      const { stack: after, result } = applyRules(
        before,
        change.op.kind === "commit" ? { kind: "commit", id: change.opId } : change.op,
      )
      const starts = result.kind === "refused" ? [] : result.starts.map((start): AttemptStart => ({
        attemptId: crypto.randomUUID(),
        todoId: start.todoId,
        repoId: change.repoId,
        number: start.number,
        ordinal: start.ordinal,
        revision: start.revision,
      }))
      // A TODO in a lane always has its attempt's row: this writer records both in one transaction.
      const stop = result.kind === "dropped" ? result.stopped : undefined
      const stopped = stop === undefined
        ? undefined
        : { attemptId: rows.find((row) => row.id === stop.todoId)!.attemptId!, todoId: stop.todoId }
      // The drop and publication serialize on the same stack row. If publish
      // committed first, its successor admissions transfer to this durable
      // receipt before cancellation removes the publishing run's retry owner.
      const inherited = stopped === undefined ? [] : yield* publishedStarts({
        ...stopped, repoId: change.repoId, ordinal: rows.find((row) => row.id === stopped.todoId)!.attempt,
      })
      const receipt: Receipt = {
        // A commit or a drop answers one of the stack's outcomes; only a run's report finishes a TODO or goes stale.
        outcome: (result.kind === "refused" ? result.code : result.kind) as StackOutcome,
        ...(result.kind === "refused" ? {} : { number: result.number }),
        starts: [...starts, ...inherited],
        ...(stopped === undefined ? {} : { stopped }),
      }
      if (change.op.kind === "retry" && result.kind === "retried") {
        // Preserve the dependency identity before replacing the current projection. A published descendant may
        // still await this old branch after the replacement attempt publishes on a different branch.
        yield* sql`UPDATE todo_attempts a SET branch = t.branch, base_ref = t.base_ref, pr_number = t.pr_number
          FROM todos t WHERE a.todo_id = t.id AND a.ordinal = t.attempt
            AND t.branch IS NOT NULL
            AND t.repo_id = ${change.repoId} AND t.number = ${change.op.number}`
        yield* sql`UPDATE todo_attempts SET status = 'failed', settled_at = coalesce(settled_at, now())
          WHERE id = ${options.stoppedAttemptId ?? null}::uuid AND todo_id = ${rows.find((row) => row.number === named)!.id}::uuid`
        yield* sql`UPDATE todos SET failure = NULL, step = NULL, branch = NULL, base_sha = NULL, base_ref = NULL, base_reset = true,
          head_sha = NULL, pr_number = NULL, pr_draft = NULL, note = NULL
          WHERE repo_id = ${change.repoId} AND number = ${change.op.number}`
      }
      if (change.op.kind === "commit" && result.kind === "committed") {
        const created = after.todos.find((todo) => todo.id === change.opId)!
        yield* sql`
          INSERT INTO todos (id, repo_id, number, title, state, position, revision, attempt, created_by, created_login,
            issue_number)
          VALUES (${change.opId}::uuid, ${change.repoId}, ${created.number}, ${change.op.title}, ${created.state},
            ${created.position}, ${created.revision}, ${created.attempt}, ${change.actor.id}, ${change.actor.login},
            ${change.op.issue ?? null})`
        yield* sql`
          INSERT INTO todo_requests (todo_id, revision, repo_id, prompt, acceptance, by_login)
          VALUES (${change.opId}::uuid, 1, ${change.repoId}, ${change.op.prompt},
            ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(change.op.acceptance)}::jsonb)),
            ${change.actor.login})`
        // Commit's result reaches its person's feed in the same transaction (decision 0124).
        yield* foldCommit({ opId: change.opId, repoId: change.repoId, actorId: change.actor.id, number: created.number })
      }
      // Every TODO the change moved, settled or started, in one statement: positions are unique per repository at the
      // statement's end, so closing a gap needs no order.
      const changed = after.todos.filter((todo) => {
        const was = before.todos.find((row) => row.id === todo.id)
        return was !== undefined &&
          (was.state !== todo.state || was.position !== todo.position || was.attempt !== todo.attempt)
      })
      if (changed.length > 0) {
        const values = JSON.stringify(changed.map(({ id, state, position, attempt }) => ({ id, state, position, attempt })))
        yield* sql`
          UPDATE todos AS t
          SET state = v.state, position = v.position, attempt = v.attempt, updated_at = now(),
            failure = CASE WHEN t.state = 'queued' AND v.state = 'failed' THEN 'base_closed' ELSE t.failure END,
            settled_at = CASE WHEN v.state IN ('merged', 'dropped') THEN coalesce(t.settled_at, now()) ELSE NULL END,
            settled_by = CASE WHEN v.state = 'dropped' THEN ${change.actor.id} ELSE t.settled_by END
          FROM jsonb_to_recordset(${values}::jsonb) AS v(id uuid, state text, position integer, attempt integer)
          WHERE t.id = v.id`
      }
      for (const start of starts) {
        yield* sql`
          INSERT INTO todo_attempts (id, todo_id, repo_id, ordinal, revision, status)
          VALUES (${start.attemptId}::uuid, ${start.todoId}::uuid, ${change.repoId}, ${start.ordinal},
            ${start.revision}, 'running')`
        yield* recordRun(sql, start)
      }
      const [stack] = yield* sql<{ readonly version: string; readonly txid: string }>`
        UPDATE stacks SET next_number = ${after.nextNumber}, version = version + 1, updated_at = now()
        WHERE repo_id = ${change.repoId}
        RETURNING version::text AS version, pg_current_xact_id()::xid::text AS txid`
      yield* sql`
        INSERT INTO stack_ops (id, repo_id, actor_id, via, op, payload_hash, outcome, result)
        VALUES (${change.opId}::uuid, ${change.repoId}, ${change.actor.id}, ${change.via}, ${change.op.kind}, ${hash},
          ${receipt.outcome}, ${JSON.stringify(receipt)}::jsonb)`
      const moved = [
        ...(result.kind === "committed" ? [{ from: "new", to: after.todos.find((todo) => todo.id === change.opId)!.state }] : []),
        ...changed.map((todo) => ({ from: before.todos.find((row) => row.id === todo.id)!.state as string, to: todo.state })),
      ].filter(({ from, to }) => from !== to)
      return {
        kind: "applied",
        txid: Number(stack!.txid),
        version: Number(stack!.version),
        receipt,
        moved,
      } as const
    }))
    const outcome = applied.kind === "applied"
      ? applied.receipt.outcome
      : applied.kind === "repeated"
      ? "repeated"
      : applied.kind
    const fields: Record<string, string | number> = {
      repoId: change.repoId,
      opId: change.opId,
      op: change.op.kind,
      via: change.via,
      outcome,
      durationMs: (yield* Clock.currentTimeMillis) - startedAt,
    }
    if ((applied.kind === "applied" || applied.kind === "repeated") && applied.receipt.number !== undefined) {
      fields.number = applied.receipt.number
    }
    if (applied.kind === "applied") {
      fields.version = applied.version
      for (const { from, to } of applied.moved) {
        yield* Metric.update(Metric.withAttributes(transitions, { from, to: to as TodoState }), 1)
      }
    }
    yield* Metric.update(Metric.withAttributes(changes, { op: change.op.kind, outcome }), 1)
    yield* Effect.annotateCurrentSpan(fields)
    yield* Effect.logWithLevel(applied.kind === "conflict" || applied.kind === "stale" ? "Warn" : "Info")("stack.apply").pipe(
      Effect.annotateLogs(fields),
    )
    if (applied.kind === "applied") {
      const { moved: _, ...rest } = applied
      return rest satisfies Applied
    }
    return applied satisfies Applied
  }).pipe(Effect.withSpan("stack.apply"))

/** The outcomes a stack refuses a change with: what the route answers instead of the change. */
export const isRefusal = (outcome: StackOutcome): outcome is "stack_full" | "merged" | "not_found" | "not_retryable" =>
  outcome === "stack_full" || outcome === "merged" || outcome === "not_found" || outcome === "not_retryable"

/** The attempt a `todo` run reports for: every report is fenced by its TODO and ordinal. */
export interface RunAttempt {
  readonly attemptId: string
  readonly todoId: string
  readonly repoId: string
  readonly ordinal: number
}

/**
 * What a `todo` run reports (decision 0016, the factory simplified): the step it is on; the branch it made at its base
 * (`baseRef`: the default branch, or the branch of the TODO in review before it); the pull request it opened at its
 * head, or the new head after it took in the TODO below it (`draft` while it is stacked on another TODO's branch); or how
 * it ended. Each changes the TODO's row; publishing frees its lane for the next TODO, and so does an ending.
 */
export type RunEvent =
  | { readonly kind: "step"; readonly step: TodoStep }
  | { readonly kind: "branch"; readonly branch: string; readonly baseSha: string; readonly baseRef: string }
  | { readonly kind: "published"; readonly headSha: string; readonly prNumber: number; readonly draft: boolean }
  | {
    readonly kind: "finished"
    readonly state: FinishedState
    readonly failure?: TodoFailure | undefined
    readonly note?: TodoNote | undefined
    readonly mergeSha?: string | undefined
  }

/** A terminal report replays its persisted starts; unrelated attempts and conflicting reports remain stale. */
export type Reported =
  | { readonly outcome: "applied" | "repeated"; readonly starts: ReadonlyArray<AttemptStart> }
  | { readonly outcome: "stale" | "base_closed"; readonly starts: ReadonlyArray<AttemptStart> }

/** Reports a `todo` run made, by `kind` and `outcome`. */
export const reports = Metric.counter("smithers_todo_reports", {
  description: "Reports the todo runs made to the stack's writer, by kind and outcome",
  incremental: true,
})

/**
 * Applies `event`, reported by `attempt`'s run, in one transaction that locks the repository's `stacks` row like
 * `apply`. A report from an attempt that is no longer its TODO's live one (a dropped TODO, an earlier attempt) is
 * `stale` and changes nothing, so a dropped TODO's run stops at its next report. Publishing and ending start the next
 * Queued TODO when the host runs TODOs (`runs`). The starts are stored on the attempt in the same transaction, the first
 * `published` report's in `published_report` and the ending's with its exact event in `finished_report`: a retry after
 * commit, including after a process restart, answers that receipt and never starts another. Logs ids only.
 */
export const report = (attempt: RunAttempt, event: RunEvent, options: { readonly runs: boolean }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const reported = yield* sql.withTransaction(Effect.gen(function* () {
      const [locked] = yield* sql<{ readonly nextNumber: number; readonly lanes: number; readonly maxOpen: number }>`
        SELECT next_number AS "nextNumber", lanes, max_open AS "maxOpen" FROM stacks
        WHERE repo_id = ${attempt.repoId} FOR UPDATE`
      const [recorded] = yield* sql<{
        readonly finishedReport: { readonly starts: ReadonlyArray<AttemptStart> } | null
        readonly publishedReport: { readonly starts: ReadonlyArray<AttemptStart> } | null
        readonly matches: boolean
      }>`
        SELECT finished_report AS "finishedReport", published_report AS "publishedReport",
          finished_report->'event' = ${JSON.stringify(event)}::jsonb AS matches
        FROM todo_attempts WHERE id = ${attempt.attemptId}::uuid AND todo_id = ${attempt.todoId}::uuid
          AND repo_id = ${attempt.repoId} AND ordinal = ${attempt.ordinal}`
      if (event.kind === "finished" && recorded?.finishedReport !== null && recorded?.finishedReport !== undefined) {
        return recorded.matches
          ? { outcome: "repeated", starts: Schema.decodeUnknownSync(Schema.Array(AttemptStart))(recorded.finishedReport.starts) } satisfies Reported
          : { outcome: "stale", starts: [] } satisfies Reported
      }
      const rows = yield* sql<Row & { readonly baseRef: string | null }>`
        SELECT t.id, t.number, t.state, t.position, t.attempt, t.revision, t.base_ref AS "baseRef",
          (t.failure = 'base_closed' OR i.state = 'closed' AND NOT p.merged) IS TRUE AS "baseClosed", t.base_reset AS "baseReset"
        FROM todos t LEFT JOIN pulls p ON p.repo_id = t.repo_id AND p.number = t.pr_number
        LEFT JOIN items i ON i.id = p.item_id
        WHERE t.repo_id = ${attempt.repoId} AND (t.position IS NOT NULL OR t.id = ${attempt.todoId}::uuid)`
      const todo = rows.find((row) => row.id === attempt.todoId)
      const holds = recorded !== undefined && locked !== undefined && todo !== undefined && todo.attempt === attempt.ordinal &&
        (todo.state === "working" || todo.state === "in_review")
      if (!holds) return { outcome: "stale", starts: [] } satisfies Reported
      if (event.kind !== "finished") {
        // `holds` established the current TODO and attempt under the stack lock. Read its base
        // from that same row; a second optional prompt lookup cannot change admission.
        const base = event.kind === "branch" ? event.baseRef : todo.baseRef
        if (base !== null && (yield* closedBase(attempt.repoId, base))) return { outcome: "base_closed", starts: [] } satisfies Reported
      }
      if (event.kind === "step") {
        yield* sql`UPDATE todos SET step = ${event.step}, updated_at = now() WHERE id = ${attempt.todoId}::uuid`
        return { outcome: "applied", starts: [] } satisfies Reported
      }
      if (event.kind === "branch") {
        yield* sql`
          UPDATE todos SET branch = ${event.branch}, base_sha = ${event.baseSha}, base_ref = ${event.baseRef},
            updated_at = now()
          WHERE id = ${attempt.todoId}::uuid`
        yield* sql`UPDATE todo_attempts SET base_sha = ${event.baseSha}, branch = ${event.branch}, base_ref = ${event.baseRef}
          WHERE id = ${attempt.attemptId}::uuid`
        return { outcome: "applied", starts: [] } satisfies Reported
      }
      const before: Stack = {
        nextNumber: locked.nextNumber,
        lanes: options.runs ? locked.lanes : 0,
        maxOpen: locked.maxOpen,
        // Admission sees the event's terminal cause in this same pass, before its SQL projection is written.
        todos: event.kind === "finished" && event.state === "failed" && event.failure === "base_closed"
          ? rows.map((row) => row.id === attempt.todoId ? { ...row, baseClosed: true } : row)
          : rows,
      }
      /** Writes back what the rules changed and records the attempts they started, in this transaction. */
      const persist = (after: Stack, starting: ReadonlyArray<Start>) =>
        Effect.gen(function* () {
          const starts = starting.map((start): AttemptStart => ({
            attemptId: crypto.randomUUID(),
            todoId: start.todoId,
            repoId: attempt.repoId,
            number: start.number,
            ordinal: start.ordinal,
            revision: start.revision,
          }))
          const changed = after.todos.filter((row) => {
            const was = before.todos.find((candidate) => candidate.id === row.id)!
            return was.state !== row.state || was.position !== row.position || was.attempt !== row.attempt
          })
          const values = JSON.stringify(changed.map(({ id, state, position, attempt: ordinal }) => ({
            id,
            state,
            position,
            attempt: ordinal,
          })))
          yield* sql`
            UPDATE todos AS t
            SET state = v.state, position = v.position, attempt = v.attempt, updated_at = now(),
              step = CASE WHEN t.id = ${attempt.todoId}::uuid AND v.state <> 'in_review' THEN NULL ELSE t.step END,
              failure = CASE WHEN t.id <> ${attempt.todoId}::uuid AND t.state = 'queued' AND v.state = 'failed' THEN 'base_closed' ELSE t.failure END,
              settled_at = CASE WHEN v.state IN ('merged', 'dropped') THEN coalesce(t.settled_at, now()) ELSE NULL END
            FROM jsonb_to_recordset(${values}::jsonb) AS v(id uuid, state text, position integer, attempt integer)
            WHERE t.id = v.id`
          for (const start of starts) {
            yield* sql`
              INSERT INTO todo_attempts (id, todo_id, repo_id, ordinal, revision, status)
              VALUES (${start.attemptId}::uuid, ${start.todoId}::uuid, ${attempt.repoId}, ${start.ordinal},
                ${start.revision}, 'running')`
            yield* recordRun(sql, start)
          }
          yield* sql`UPDATE stacks SET version = version + 1, updated_at = now() WHERE repo_id = ${attempt.repoId}`
          for (const row of changed) {
            const was = before.todos.find((candidate) => candidate.id === row.id)!.state
            if (was !== row.state) yield* Metric.update(Metric.withAttributes(transitions, { from: was, to: row.state }), 1)
          }
          return starts
        })
      if (event.kind === "published") {
        yield* sql`
          UPDATE todos SET step = 'await', head_sha = ${event.headSha}, pr_number = ${event.prNumber},
            pr_draft = ${event.draft}, updated_at = now()
          WHERE id = ${attempt.todoId}::uuid`
        // Published before (a retried step, or a new head after taking in the TODO below): the same starts again.
        if (recorded.publishedReport !== null) {
          return {
            outcome: "repeated",
            starts: Schema.decodeUnknownSync(Schema.Array(AttemptStart))(recorded.publishedReport.starts),
          } satisfies Reported
        }
        // `holds` checked what `publish` checks, so the rules publish it.
        const { stack: after, result } = applyRules(before, { kind: "publish", id: attempt.todoId, ordinal: attempt.ordinal })
        const starts = yield* persist(after, (result as Extract<Result, { readonly kind: "published" }>).starts)
        yield* sql`
          UPDATE todo_attempts SET status = 'published', pr_number = ${event.prNumber}, published_report = ${JSON.stringify({ starts })}::jsonb
          WHERE id = ${attempt.attemptId}::uuid`
        return { outcome: "applied", starts } satisfies Reported
      }
      const { stack: after, result } = applyRules(before, {
        kind: "finish",
        id: attempt.todoId,
        ordinal: attempt.ordinal,
        state: event.state,
      })
      // `holds` checked what `finish` checks, so the rules finish it.
      const starts = yield* persist(after, (result as Extract<Result, { readonly kind: "finished" }>).starts)
      yield* sql`
        UPDATE todos SET failure = ${event.failure ?? null}, note = ${event.note ?? null},
          merge_sha = ${event.mergeSha ?? null}
        WHERE id = ${attempt.todoId}::uuid`
      yield* sql`
        UPDATE todo_attempts SET status = ${event.state === "failed" ? "failed" : "settled"}, settled_at = now(),
          finished_report = ${JSON.stringify({ event, starts })}::jsonb
        WHERE id = ${attempt.attemptId}::uuid`
      return { outcome: "applied", starts } satisfies Reported
    }))
    yield* Metric.update(Metric.withAttributes(reports, { kind: event.kind, outcome: reported.outcome }), 1)
    yield* Effect.logWithLevel(reported.outcome === "stale" ? "Warn" : "Info")("stack.report").pipe(
      Effect.annotateLogs({
        repoId: attempt.repoId,
        todoId: attempt.todoId,
        attemptId: attempt.attemptId,
        kind: event.kind,
        outcome: reported.outcome,
        ...(event.kind === "step" ? { step: event.step } : {}),
        ...(event.kind === "published" ? { prNumber: event.prNumber } : {}),
        ...(event.kind === "finished" ? { state: event.state, ...(event.failure ? { failure: event.failure } : {}) } : {}),
        starts: reported.starts.length,
      }),
    )
    return reported
  }).pipe(Effect.withSpan("stack.report"))

/** The TODO an attempt works on, as its run reads it: its number, title, prompt, issue and committer. */
export interface AttemptTodo {
  readonly number: number
  readonly title: string
  readonly prompt: string
  readonly acceptance: ReadonlyArray<string>
  readonly issueNumber: number | null
  readonly createdBy: string
  readonly createdLogin: string
  readonly state: TodoState
  readonly attempt: number
  readonly branch: string | null
  readonly baseSha: string | null
  readonly baseRef: string | null
  readonly headSha: string | null
  readonly prNumber: number | null
}

/** Attempt `attempt`'s TODO and the prompt revision it works on, or `None`. Reads only. */
export const attemptTodo = (attempt: RunAttempt) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<AttemptTodo>`
      SELECT t.number, t.title, r.prompt, r.acceptance, t.issue_number AS "issueNumber", t.created_by AS "createdBy",
        t.created_login AS "createdLogin", t.state, t.attempt, t.branch, t.base_sha AS "baseSha",
        t.base_ref AS "baseRef", t.head_sha AS "headSha", t.pr_number AS "prNumber"
      FROM todos t JOIN todo_attempts a ON a.todo_id = t.id
      JOIN todo_requests r ON r.todo_id = t.id AND r.revision = a.revision
      WHERE a.id = ${attempt.attemptId}::uuid AND t.id = ${attempt.todoId}::uuid`
    return Option.fromNullishOr(row)
  })

/**
 * The attempts attempt `attempt`'s first `published` report started, from its receipt; none before it published. Reads
 * only, whatever its TODO's state: a run that finds its TODO dropped still owes those starts.
 */
export const publishedStarts = (attempt: RunAttempt) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const reports = yield* sql<{ readonly starts: ReadonlyArray<AttemptStart> }>`
      SELECT published_report->'starts' AS starts FROM todo_attempts
      WHERE id = ${attempt.attemptId}::uuid AND todo_id = ${attempt.todoId}::uuid AND repo_id = ${attempt.repoId}
        AND published_report IS NOT NULL`
    return reports.flatMap((report) => Schema.decodeUnknownSync(Schema.Array(AttemptStart))(report.starts))
  })

/**
 * How many open TODOs sit above attempt `attempt`'s TODO in its stack and come from the same issue: a pull request below
 * them says "Part of #n", so merging it doesn't close the issue they still work on. Reads only.
 */
export const openAboveFromIssue = (attempt: RunAttempt) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const above = yield* sql<{ readonly number: number }>`
      SELECT a.number FROM todos t JOIN todos a
        ON a.repo_id = t.repo_id AND a.issue_number = t.issue_number AND a.position > t.position
      WHERE t.id = ${attempt.todoId}::uuid AND t.issue_number IS NOT NULL`
    return above.length
  })

/** A TODO in review that another stacks on: its number, branch, head and pull request. */
export interface Below {
  readonly number: number
  readonly branch: string
  readonly headSha: string
  readonly prNumber: number
}

/**
 * The TODO attempt `attempt`'s TODO stacks on: the nearest one before it in the stack that is In review with its pull
 * request open, or `None`, and the TODO starts from the default branch. Reads only.
 */
export const belowOf = (attempt: RunAttempt) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<Below>`
      SELECT b.number, b.branch, b.head_sha AS "headSha", b.pr_number AS "prNumber"
      FROM todos t JOIN todos b ON b.repo_id = t.repo_id AND b.position < t.position
      WHERE t.id = ${attempt.todoId}::uuid AND b.state = 'in_review' AND b.branch IS NOT NULL
        AND b.head_sha IS NOT NULL AND b.pr_number IS NOT NULL
      ORDER BY b.position DESC`
    for (const row of rows) {
      if (!(yield* closedBase(attempt.repoId, row.branch))) return Option.some(row)
    }
    return Option.none<Below>()
  })

/** How the TODO a stacked TODO's branch was made from stands: its state and, once merged, its merge commit. */
export interface BaseTodo {
  readonly prNumber: number | null
  readonly number: number
  readonly state: TodoState
  readonly mergeSha: string | null
}

/** The TODO of repository `repoId` whose branch is `branch`, as a TODO stacked on it reads it; `None` for any other. */
export const baseTodoOf = (repoId: string, branch: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<BaseTodo>`
      WITH bases AS (
        SELECT t.number, t.pr_number, t.state, t.merge_sha, t.attempt AS ordinal
        FROM todos t WHERE t.repo_id = ${repoId} AND t.branch = ${branch}
        UNION ALL
        SELECT t.number, a.pr_number, 'failed' AS state, NULL::text AS merge_sha, a.ordinal
        FROM todo_attempts a JOIN todos t ON t.id = a.todo_id AND t.repo_id = a.repo_id
        WHERE a.repo_id = ${repoId} AND a.branch = ${branch} AND (a.ordinal < t.attempt OR a.branch IS DISTINCT FROM t.branch)
      )
      SELECT b.number, b.pr_number AS "prNumber",
        CASE WHEN p.merged THEN 'merged' WHEN i.state = 'closed' THEN 'dropped' ELSE b.state END AS state,
        coalesce(p.merge_sha, b.merge_sha) AS "mergeSha"
      FROM bases b LEFT JOIN pulls p ON p.repo_id = ${repoId} AND p.number = b.pr_number
      LEFT JOIN items i ON i.id = p.item_id
      ORDER BY b.number DESC, b.ordinal DESC LIMIT 1`
    return Option.fromNullishOr(row)
  })

/** Read the current active attempt before probing its engine; the writer checks this id again under its lock. */
export const retryCandidate = (repoId: string, number: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly attemptId: string }>`
      SELECT a.id AS "attemptId" FROM todos t JOIN todo_attempts a ON a.todo_id = t.id AND a.ordinal = t.attempt
      WHERE t.repo_id = ${repoId} AND t.number = ${number} AND t.state IN ('working', 'in_review')`
    return row?.attemptId
  })


/** A branch's transitive TODO ancestry, including a replaced attempt's archived branch. */
export const closedBase = (repoId: string, branch: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ closed: boolean }>`
    WITH RECURSIVE branches AS (
      SELECT t.branch, t.base_ref, t.state, t.pr_number FROM todos t WHERE t.repo_id = ${repoId}
      UNION
      SELECT a.branch, a.base_ref, 'failed'::text, a.pr_number FROM todo_attempts a
      JOIN todos t ON t.id = a.todo_id WHERE a.repo_id = ${repoId} AND (a.ordinal < t.attempt OR a.branch IS DISTINCT FROM t.branch) AND a.branch IS NOT NULL
    ), ancestry AS (
      SELECT b.* FROM branches b WHERE b.branch = ${branch}
      UNION
      SELECT b.* FROM branches b JOIN ancestry a ON b.branch = a.base_ref
    )
    SELECT EXISTS(SELECT 1 FROM ancestry a
      LEFT JOIN pulls p ON p.repo_id = ${repoId} AND p.number = a.pr_number
      LEFT JOIN items i ON i.id = p.item_id
      WHERE NOT coalesce(p.merged, false) AND (a.state IN ('dropped', 'failed') OR i.state = 'closed')) AS closed`
  return row!.closed
})

/** Snapshot for the durable invalidation flow: read before any cancellation or settlement changes the graph. */
export const descendants = (stop: AttemptStop & { readonly baseClosed?: boolean }) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [root] = yield* sql<{ repoId: string; branch: string | null }>`
    SELECT a.repo_id AS "repoId", coalesce(a.branch, t.branch) AS branch
    FROM todo_attempts a JOIN todos t ON t.id = a.todo_id
    WHERE a.id = ${stop.attemptId}::uuid AND t.id = ${stop.todoId}::uuid`
  if (root === undefined || root.branch === null) return []
  const branch = root.branch
  return yield* sql.withTransaction(Effect.gen(function* () {
  yield* sql`SELECT repo_id FROM stacks WHERE repo_id = ${root.repoId} FOR UPDATE`
  if (stop.baseClosed !== true && !(yield* closedBase(root.repoId, branch))) return []
  const held = yield* sql`UPDATE todos SET state = 'failed', failure = 'base_closed', updated_at = now()
    WHERE repo_id = ${root.repoId} AND state = 'queued' AND NOT base_reset
      AND position > (SELECT t.position FROM todos t JOIN todo_attempts a ON a.todo_id = t.id AND a.ordinal = t.attempt
        WHERE t.id = ${stop.todoId}::uuid AND a.id = ${stop.attemptId}::uuid AND t.state <> 'failed')
    RETURNING id`
  if (held.length > 0) {
    yield* sql`UPDATE stacks SET version = version + 1, updated_at = now() WHERE repo_id = ${root.repoId}`
    yield* Metric.update(Metric.withAttributes(transitions, { from: "queued", to: "failed" }), held.length)
  }
  return yield* sql<AttemptStart & { prNumber: number | null }>`
    WITH RECURSIVE branches AS (
      SELECT t.id, t.branch, t.base_ref FROM todos t WHERE t.repo_id = ${root.repoId}
      UNION
      SELECT a.todo_id, a.branch, a.base_ref FROM todo_attempts a
      WHERE a.repo_id = ${root.repoId} AND a.branch IS NOT NULL
    ), children AS (
      SELECT b.id, b.branch FROM branches b WHERE b.base_ref = ${branch}
      UNION
      SELECT b.id, b.branch FROM branches b JOIN children c ON b.base_ref = c.branch
    )
    SELECT a.id AS "attemptId", t.id AS "todoId", t.repo_id AS "repoId", t.number,
      a.ordinal, a.revision, t.pr_number AS "prNumber"
    FROM children c JOIN todos t ON t.id = c.id
    JOIN todo_attempts a ON a.todo_id = t.id AND a.ordinal = t.attempt
    WHERE t.state IN ('working', 'in_review') AND t.branch IS NOT DISTINCT FROM c.branch ORDER BY t.position DESC`
  }))
})


/** The PR of this exact attempt, even after Retry replaces the TODO's current projection. */
export const attemptPull = (attempt: RunAttempt) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ prNumber: number | null }>`
    SELECT coalesce(a.pr_number, CASE WHEN t.attempt = a.ordinal THEN t.pr_number END) AS "prNumber"
    FROM todo_attempts a JOIN todos t ON t.id = a.todo_id
    WHERE a.id = ${attempt.attemptId}::uuid AND a.todo_id = ${attempt.todoId}::uuid
      AND a.repo_id = ${attempt.repoId} AND a.ordinal = ${attempt.ordinal}`
  return row?.prNumber ?? null
})
