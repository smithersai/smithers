// The stack's writer (worker/stack/Stack.ts, decision 0016 §1 and §7) on this file's schema of the compose Postgres
// (`pnpm db:up`): what each change writes, its receipt under the op id, the stack's refusals, the attempts it records
// when the host runs TODOs, and, with writers racing on connections of their own, that no change is lost and the
// stack's rules hold after every race.
import { Arbitrary, Effect, Logger, Metric, Schema, Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { isReady, openOf, type Row, type Stack as Rules, violations } from "../../src/features/todos/stack.ts"
import { testFile, uuid } from "../test/harness.ts"
import * as Stack from "./Stack.ts"
import { foldCommit } from "./StackFeed.vibe"
import { workStatusOf } from "../../src/features/issues/work.ts"

const runtime = testFile("stack_writer")
beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`TRUNCATE stack_ops, todo_attempts, todo_requests, todo_leaves, todos, stacks`))
)

const REPO = "github/octo/hello"
const maya = { id: "person-maya", login: "maya" }

const commit = (fields: Partial<Stack.Change> & { readonly title?: string; readonly prompt?: string } = {}): Stack.Change => ({
  opId: fields.opId ?? uuid(),
  repoId: fields.repoId ?? REPO,
  actor: fields.actor ?? maya,
  via: fields.via ?? "person",
  op: fields.op ?? {
    kind: "commit",
    title: fields.title ?? "Retry webhook delivery",
    prompt: fields.prompt ?? "Retry a failed delivery **three** times.",
    acceptance: [],
  },
})
const configure = (lanes: number, base: "stacked" | "independent", maxOpen = 50): Stack.Change => ({
  opId: uuid(),
  repoId: REPO,
  actor: { id: "person-ada", login: "ada" },
  via: "person",
  op: { kind: "configure", lanes, maxOpen, base },
})
const commitAfter = (after: number | null): Stack.Change =>
  commit({ op: { kind: "commit", title: "Stacked on another", prompt: "Build on it.", acceptance: [], after } })
const drop = (number: number, opId = uuid()): Stack.Change => ({
  opId,
  repoId: REPO,
  actor: maya,
  via: "person",
  op: { kind: "drop", number },
})

/** Every log line, span and metric a writer records, kept for the test. */
const observe = () => {
  const lines: Array<{ readonly message: unknown; readonly annotations: Readonly<Record<string, unknown>> }> = []
  const spans: Array<Tracer.NativeSpan> = []
  const registry: Metric.MetricRegistry = new Map()
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  const logger = Logger.make((options) => {
    const { message, annotations } = Logger.formatStructured.log(options)
    lines.push({ message, annotations })
  })
  return {
    lines,
    spans,
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
    recorded: () => JSON.stringify({ lines, spans: spans.map((span) => [...span.attributes]) }),
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
  }
}

/** Applies `change` on a connection of its own, as one request of ChatApi does. */
const applyOn = (change: Stack.Change, runs = false, observed = observe()) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const { database } = yield* TestDatabase.Scratch
      return yield* observed.provide(Stack.apply(change, { runs })).pipe(Effect.provide(database))
    }),
  )

const sql = <A extends object>(statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe<A>(statement)))

const todos = () =>
  sql<{ id: string; number: number; title: string; state: string; position: number | null; attempt: number; revision: number; settledBy: string | null; settled: boolean }>(`
    SELECT id, number, title, state, position, attempt, revision, settled_by AS "settledBy",
      settled_at IS NOT NULL AS settled
    FROM todos WHERE repo_id = '${REPO}' ORDER BY number`)
const stack = async () =>
  (await sql<{ nextNumber: number; version: number }>(
    `SELECT next_number AS "nextNumber", version::int AS version FROM stacks WHERE repo_id = '${REPO}'`,
  ))[0]

/** The stack as Postgres holds it, in the rules' terms. */
const loaded = async () => {
  const rows = await sql<Row>(`SELECT id, number, state, position, attempt, revision, after::text AS after
    FROM todos WHERE repo_id = '${REPO}' ORDER BY number`)
  const [settings] = await sql<{ nextNumber: number; lanes: number; maxOpen: number; base: Rules["base"] }>(`
    SELECT next_number AS "nextNumber", lanes, max_open AS "maxOpen", base FROM stacks WHERE repo_id = '${REPO}'`)
  return { ...(settings ?? { nextNumber: 1, lanes: 1, maxOpen: 50, base: "stacked" as const }), todos: rows }
}

describe("a commit", () => {
  test("records the writer's request time with the remote execution id and no content", async () => {
    const observed = observe()
    const result = await applyOn(commit({ prompt: "SENTINEL-START-CONTENT" }), true, observed)
    if (result.kind !== "applied") throw new Error("not applied")
    expect(observed.lines.find((line) => line.message === "todo.run.requested")?.annotations).toMatchObject({
      "smithers.execution.id": `todo:${result.receipt.starts[0]!.attemptId}`,
      requestedAtMs: expect.any(Number),
    })
    expect(observed.recorded()).not.toContain("SENTINEL-START-CONTENT")
  })
  test("numbers the TODO, places it last, Queued, keeps its prompt as revision 1, and keeps a receipt", async () => {
    const first = commit()
    const applied = await applyOn(first)
    expect(applied).toMatchObject({ kind: "applied", version: 1, receipt: { outcome: "committed", number: 1, starts: [] } })
    expect(applied.kind === "applied" && applied.txid).toBeGreaterThan(0)
    await applyOn(commit({
      title: "Add rate limit headers",
      op: { kind: "commit", title: "Add rate limit headers", prompt: "Add them.", acceptance: ["429 has Retry-After", "docs"] },
    }))

    expect(await todos()).toEqual([
      expect.objectContaining({ id: first.opId, number: 1, title: "Retry webhook delivery", state: "queued", position: 1, attempt: 0, revision: 1 }),
      expect.objectContaining({ number: 2, title: "Add rate limit headers", state: "queued", position: 2 }),
    ])
    expect(await sql(`SELECT todo_id AS "todoId", revision, prompt, acceptance, by_login AS "byLogin" FROM todo_requests ORDER BY prompt DESC`))
      .toEqual([
        { todoId: first.opId, revision: 1, prompt: "Retry a failed delivery **three** times.", acceptance: [], byLogin: "maya" },
        { todoId: expect.any(String), revision: 1, prompt: "Add them.", acceptance: ["429 has Retry-After", "docs"], byLogin: "maya" },
      ])
    expect(await stack()).toEqual({ nextNumber: 3, version: 2 })
    expect(await sql(`SELECT op, via, outcome, result, actor_id AS "actorId" FROM stack_ops WHERE id = '${first.opId}'`)).toEqual([
      { op: "commit", via: "person", outcome: "committed", result: { outcome: "committed", number: 1, starts: [] }, actorId: "person-maya" },
    ])
  })

  test("a repeated op answers its receipt and changes nothing; another payload under its id is a conflict", async () => {
    const first = commit()
    await applyOn(first)

    expect(await applyOn(first)).toEqual({ kind: "repeated", receipt: { outcome: "committed", number: 1, starts: [] } })
    expect(await applyOn({ ...first, op: { kind: "commit", title: "Something else", prompt: "x", acceptance: [] } }))
      .toEqual({ kind: "conflict" })
    expect(await applyOn({ ...first, via: "agent" })).toEqual({ kind: "conflict" })
    expect(await stack()).toEqual({ nextNumber: 2, version: 1 })
    expect(await todos()).toHaveLength(1)
  })

  test("a full stack refuses it, keeps the refusal as the receipt and spends no number", async () => {
    await applyOn(commit())
    await sql(`UPDATE stacks SET max_open = 1 WHERE repo_id = '${REPO}'`)
    const refused = commit()

    expect(await applyOn(refused)).toMatchObject({ kind: "applied", receipt: { outcome: "stack_full", starts: [] } })
    expect(await applyOn(refused)).toEqual({ kind: "repeated", receipt: { outcome: "stack_full", starts: [] } })
    expect(await stack()).toEqual({ nextNumber: 2, version: 2 })
    expect(await todos()).toHaveLength(1)
  })

  test("its result reaches its person's feed in the same transaction, once; a refusal reaches nothing", async () => {
    const observed = observe()
    const first = commit()
    await applyOn(first, false, observed)
    await applyOn(first)
    const notices = (opId: string) => sql(
      `SELECT recipient, kind, state, mine, quiet, title, href, version, repo_id AS "repoId" FROM notifications WHERE subject = 'write:${opId}'`,
    )
    expect(await notices(first.opId)).toEqual([{
      recipient: "person-maya", kind: "write", state: "done", mine: true, quiet: false, title: "Commit TODO",
      href: "/octo/hello/stack/1", version: 2, repoId: REPO,
    }])
    expect(observed.lines.find((line) => line.message === "stack.commit.notice")?.annotations).toMatchObject({ opId: first.opId, state: "done" })
    await sql(`UPDATE stacks SET max_open = 1 WHERE repo_id = '${REPO}'`)
    const refused = commit()
    expect(await applyOn(refused)).toMatchObject({ receipt: { outcome: "stack_full" } })
    expect(await notices(refused.opId)).toEqual([])
  })

  test("a fold that finds its person's notification already there changes nothing and records nothing", async () => {
    const observed = observe()
    const opId = uuid()
    await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, quiet, repo_id, title, href, version)
      VALUES ('person-maya', 'write:${opId}', 'write', 'done', true, false, '${REPO}', 'Commit TODO', '/octo/hello/stack/9', 2)`)
    const folded = await runtime.runPromise(observed.provide(foldCommit({ opId, repoId: REPO, actorId: "person-maya", number: 1 })))
    expect(folded).toBe(0)
    expect(await sql(`SELECT href FROM notifications WHERE subject = 'write:${opId}'`)).toEqual([{ href: "/octo/hello/stack/9" }])
    expect(observed.lines.filter((line) => line.message === "stack.commit.notice")).toEqual([])
  })

  test("stacks are per repository: each counts its own numbers", async () => {
    await applyOn(commit())
    await applyOn(commit({ repoId: "github/octo/other" }))
    expect(await sql(`SELECT repo_id AS "repoId", number, position FROM todos ORDER BY repo_id`)).toEqual([
      { repoId: "github/octo/hello", number: 1, position: 1 },
      { repoId: "github/octo/other", number: 1, position: 1 },
    ])
  })
})

describe("a drop", () => {
  test("drops the TODO, closes the gap in one statement and records who dropped it", async () => {
    for (let index = 0; index < 4; index++) await applyOn(commit())

    expect(await applyOn(drop(2))).toMatchObject({ kind: "applied", receipt: { outcome: "dropped", number: 2, starts: [] } })
    expect((await todos()).map(({ number, state, position, settledBy, settled }) => [number, state, position, settledBy, settled]))
      .toEqual([
        [1, "queued", 1, null, false],
        [2, "dropped", null, "person-maya", true],
        [3, "queued", 2, null, false],
        [4, "queued", 3, null, false],
      ])
  })

  test("is idempotent: dropping a dropped TODO answers dropped and moves nothing", async () => {
    await applyOn(commit())
    await applyOn(commit())
    await applyOn(drop(1))
    const before = await todos()

    expect(await applyOn(drop(1))).toMatchObject({ kind: "applied", receipt: { outcome: "dropped", number: 1 } })
    expect(await todos()).toEqual(before)
  })

  test("refuses a merged TODO and a number the stack never had", async () => {
    await applyOn(commit())
    // What Track B's Settle will write: merged, out of the stack.
    await sql(`UPDATE todos SET state = 'merged', position = NULL, settled_at = now() WHERE number = 1`)

    expect(await applyOn(drop(1))).toMatchObject({ kind: "applied", receipt: { outcome: "merged" } })
    expect(await applyOn(drop(7))).toMatchObject({ kind: "applied", receipt: { outcome: "not_found" } })
    expect((await todos())[0]).toMatchObject({ state: "merged" })
  })
})

describe("on a host that runs TODOs", () => {
  test("a commit with a free lane starts its first attempt; a drop stops it and starts the next", async () => {
    const first = await applyOn(commit(), true)
    const started = first.kind === "applied" ? first.receipt.starts : []
    expect(started).toEqual([
      { attemptId: expect.any(String), todoId: expect.any(String), repoId: REPO, number: 1, ordinal: 1, revision: 1 },
    ])
    await applyOn(commit(), true)
    expect((await todos()).map(({ state, attempt }) => [state, attempt])).toEqual([["working", 1], ["queued", 0]])
    expect(await sql(`SELECT id, ordinal, status FROM todo_attempts`)).toEqual([
      { id: started[0]!.attemptId, ordinal: 1, status: "running" },
    ])

    const dropped = await applyOn(drop(1), true)
    expect(dropped).toMatchObject({
      kind: "applied",
      receipt: {
        outcome: "dropped",
        stopped: { attemptId: started[0]!.attemptId, todoId: started[0]!.todoId },
        starts: [{ number: 2, ordinal: 1 }],
      },
    })
    expect((await todos()).map(({ state, position }) => [state, position])).toEqual([["dropped", null], ["working", 1]])
  })

  test("each attempt's start records its run on the TODO, todo:<attempt id>, and a dropped TODO keeps its last", async () => {
    const first = await applyOn(commit(), true)
    await applyOn(commit(), true)
    const attemptOf = (applied: Stack.Applied) => (applied.kind === "applied" ? applied.receipt.starts[0]!.attemptId : "")
    const runs = () => sql<{ number: number; runId: string | null }>(`SELECT number, run_id AS "runId" FROM todos ORDER BY number`)
    expect(await runs()).toEqual([{ number: 1, runId: `todo:${attemptOf(first)}` }, { number: 2, runId: null }])
    const dropped = await applyOn(drop(1), true)
    expect(await runs()).toEqual([
      { number: 1, runId: `todo:${attemptOf(first)}` },
      { number: 2, runId: `todo:${attemptOf(dropped)}` },
    ])
  })

  test("without runs, nothing starts: every TODO stays Queued", async () => {
    await applyOn(commit(), false)
    expect((await todos())[0]).toMatchObject({ state: "queued", attempt: 0 })
    expect(await sql(`SELECT id FROM todo_attempts`)).toEqual([])
    expect(await sql(`SELECT run_id AS "runId" FROM todos`)).toEqual([{ runId: null }])
  })
})

describe("a run's reports", () => {
  /** Commits TODOs on a host that runs them, and answers the first one's attempt. */
  const started = async (count = 1) => {
    const receipts = []
    for (let index = 0; index < count; index++) receipts.push(await applyOn(commit(), true))
    const first = receipts[0]!
    if (first.kind !== "applied") throw new Error("not applied")
    const start = first.receipt.starts[0]!
    return { attemptId: start.attemptId, todoId: start.todoId, repoId: REPO, ordinal: start.ordinal }
  }
  const reportOn = (attempt: Stack.RunAttempt, event: Stack.RunEvent, runs = true, observed = observe()) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const { database } = yield* TestDatabase.Scratch
        return yield* observed.provide(Stack.report(attempt, event, { runs })).pipe(Effect.provide(database))
      }),
    )
  const row = async () =>
    (await sql<{
      state: string
      step: string | null
      branch: string | null
      baseSha: string | null
      headSha: string | null
      prNumber: number | null
      failure: string | null
      note: string | null
      mergeSha: string | null
      position: number | null
      settled: boolean
    }>(`
      SELECT state, step, branch, base_sha AS "baseSha", head_sha AS "headSha", pr_number AS "prNumber", failure, note,
        merge_sha AS "mergeSha", position, settled_at IS NOT NULL AS settled
      FROM todos WHERE repo_id = '${REPO}' ORDER BY number LIMIT 1`))[0]!
  const BASE = "a".repeat(40)
  const HEAD = "b".repeat(40)
  const MERGE = "c".repeat(40)

  test("step, branch and published change the row; published frees the lane for the next, and merged settles it", async () => {
    const attempt = await started(2)
    expect(await reportOn(attempt, { kind: "step", step: "implement" })).toEqual({ outcome: "applied", starts: [] })
    expect(await reportOn(attempt, { kind: "branch", branch: "smithers/t1-retry", baseSha: BASE, baseRef: "main" }))
      .toEqual({ outcome: "applied", starts: [] })
    expect(await row()).toMatchObject({ state: "working", step: "implement", branch: "smithers/t1-retry", baseSha: BASE })
    expect(await sql(`SELECT base_ref AS "baseRef" FROM todos WHERE number = 1`)).toEqual([{ baseRef: "main" }])
    const observed = observe()
    const published = await reportOn(attempt, { kind: "published", headSha: HEAD, prNumber: 7, draft: false }, true, observed)
    // In review frees the lane: the next TODO starts now, to stack on this one's branch.
    expect(published).toMatchObject({ outcome: "applied", starts: [{ number: 2, ordinal: 1, repoId: REPO }] })
    expect(await row()).toMatchObject({ state: "in_review", step: "await", headSha: HEAD, prNumber: 7 })
    expect((await todos()).map(({ state }) => state)).toEqual(["in_review", "working"])
    expect(observed.count(Stack.transitions, { from: "working", to: "in_review" })).toBe(1)
    expect(observed.count(Stack.transitions, { from: "queued", to: "working" })).toBe(1)
    // Published again, as a retried step does: the same starts from the receipt, and nothing counts twice.
    const again = observe()
    expect(await reportOn(attempt, { kind: "published", headSha: HEAD, prNumber: 7, draft: false }, true, again))
      .toEqual({ outcome: "repeated", starts: published.starts })
    expect(again.count(Stack.transitions, { from: "working", to: "in_review" })).toBe(0)
    expect(await sql(`SELECT id FROM todo_attempts`)).toHaveLength(2)
    // A new head, as after taking in the TODO below: the row takes it.
    await reportOn(attempt, { kind: "published", headSha: MERGE, prNumber: 7, draft: false })
    expect(await row()).toMatchObject({ state: "in_review", headSha: MERGE })
    const merged = await reportOn(attempt, { kind: "finished", state: "merged", note: "merged_on_github", mergeSha: MERGE })
    expect(merged).toEqual({ outcome: "applied", starts: [] })
    // The next TODO's start records its run; the merged one keeps the run that took it to its merge.
    expect(await sql(`SELECT number, run_id AS "runId" FROM todos ORDER BY number`)).toEqual([
      { number: 1, runId: `todo:${attempt.attemptId}` },
      { number: 2, runId: `todo:${published.starts[0]!.attemptId}` },
    ])
    expect(await row()).toMatchObject({
      state: "merged",
      step: null,
      position: null,
      settled: true,
      note: "merged_on_github",
      mergeSha: MERGE,
    })
    expect((await todos()).map(({ state, position }) => [state, position])).toEqual([["merged", null], ["working", 1]])
    expect(await sql(`SELECT status, settled_at IS NOT NULL AS settled FROM todo_attempts ORDER BY created_at`))
      .toEqual([{ status: "settled", settled: true }, { status: "running", settled: false }])
  })

  test("an implement failure holds successors until a person drops the failed base", async () => {
    const attempt = await started(2)
    await reportOn(attempt, { kind: "step", step: "implement" })
    expect(await reportOn(attempt, { kind: "finished", state: "failed", failure: "implement" }))
      .toEqual({ outcome: "applied", starts: [] })
    expect((await todos()).map(({ state }) => state)).toEqual(["failed", "queued"])
    await applyOn(commit(), true)
    expect(await sql(`SELECT id FROM todo_attempts`)).toHaveLength(1)
    const dropped = await applyOn(drop(1), true)
    expect(dropped).toMatchObject({ receipt: { starts: [{ number: 2 }] } })
  })

  test("a retried failed predecessor publishes before the held successor starts on its branch", async () => {
    const attempt = await started(2)
    await reportOn(attempt, { kind: "step", step: "implement" })
    expect((await reportOn(attempt, { kind: "finished", state: "failed", failure: "implement" })).starts).toEqual([])
    const retriedResult = await applyOn({ ...drop(1), op: { kind: "retry", number: 1 } }, true)
    if (retriedResult.kind !== "applied") throw new Error("retry refused")
    const retried = retriedResult.receipt.starts[0]!
    expect((await todos()).map(({ state }) => state)).toEqual(["working", "queued"])
    expect(await reportOn(attempt, { kind: "published", headSha: HEAD, prNumber: 7, draft: false }))
      .toEqual({ outcome: "stale", starts: [] })
    await reportOn(retried, { kind: "branch", branch: "smithers/retried", baseSha: BASE, baseRef: "main" })
    const published = await reportOn(retried, { kind: "published", headSha: HEAD, prNumber: 7, draft: false })
    expect(published.starts).toHaveLength(1)
    const next = published.starts[0]!
    expect(next.number).toBe(2)
    expect(await runtime.runPromise(Stack.belowOf({ ...next, ordinal: next.ordinal }))).toMatchObject({
      value: { branch: "smithers/retried", headSha: HEAD, prNumber: 7 },
    })
  })

  test("closing a predecessor preserves an already-failed successor's original reason", async () => {
    const first = await started(2)
    const published = await reportOn(first, { kind: "published", headSha: HEAD, prNumber: 7, draft: false })
    const second = published.starts[0]!
    await reportOn(second, { kind: "finished", state: "failed", failure: "implement" })
    await reportOn(first, { kind: "finished", state: "dropped", note: "closed_on_github" })
    expect(await sql(`SELECT state, failure FROM todos WHERE number = 2`)).toEqual([{ state: "failed", failure: "implement" }])
  })

  test("a base closed unmerged fails queued dependents without admitting them on main", async () => {
    const attempt = await started(2)
    expect(await reportOn(attempt, { kind: "finished", state: "dropped", note: "closed_on_github" }))
      .toEqual({ outcome: "applied", starts: [] })
    expect((await todos()).map(({ state }) => state)).toEqual(["dropped", "failed"])
    expect(await sql(`SELECT failure FROM todos WHERE number = 2`)).toEqual([{ failure: "base_closed" }])
    expect(await sql(`SELECT id FROM todo_attempts`)).toHaveLength(1)
  })

  test("failed keeps the TODO's place with its code; a stale report changes nothing and is logged", async () => {
    const attempt = await started()
    await reportOn(attempt, { kind: "finished", state: "failed", failure: "implement" })
    expect(await row()).toMatchObject({ state: "failed", failure: "implement", position: 1, settled: false })
    expect(await sql(`SELECT status FROM todo_attempts`)).toEqual([{ status: "failed" }])
    const observed = observe()
    expect(await reportOn(attempt, { kind: "step", step: "publish" }, true, observed)).toEqual({
      outcome: "stale",
      starts: [],
    })
    expect(observed.count(Stack.reports, { kind: "step", outcome: "stale" })).toBe(1)
    expect(observed.lines.at(-1)).toMatchObject({ message: "stack.report", annotations: { outcome: "stale" } })
    expect(await reportOn({ ...attempt, ordinal: 9 }, { kind: "step", step: "publish" })).toMatchObject({ outcome: "stale" })
    expect(await reportOn({ ...attempt, repoId: "github/no/where" }, { kind: "step", step: "publish" }))
      .toMatchObject({ outcome: "stale" })
  })

  test.each(["merged"] as const)("a %s report replays exactly its committed successor receipt", async (state) => {
    const attempt = await started(3)
    const event: Stack.RunEvent = { kind: "finished", state }
    const first = await reportOn(attempt, event)
    const before = await todos()
    const version = await stack()
    const observed = observe()
    // Connections are fresh per report; replay depends only on the persisted receipt.
    const repeated = await reportOn(attempt, event, true, observed)
    expect(first.outcome).toBe("applied")
    expect(repeated).toEqual({ outcome: "repeated", starts: first.starts })
    expect(first.starts).toHaveLength(1)
    expect(await todos()).toEqual(before)
    expect(await stack()).toEqual(version)
    expect(await sql(`SELECT id FROM todo_attempts`)).toHaveLength(2)
    expect(observed.count(Stack.reports, { kind: "finished", outcome: "repeated" })).toBe(1)
    expect(observed.lines.at(-1)).toMatchObject({ message: "stack.report", annotations: { outcome: "repeated", starts: 1 } })
    for (const unrelated of [
      { ...attempt, attemptId: uuid() },
      { ...attempt, ordinal: 2 },
      { ...attempt, repoId: "github/another/repo" },
      { ...attempt, todoId: first.starts[0]!.todoId },
    ]) expect(await reportOn(unrelated, event)).toEqual({ outcome: "stale", starts: [] })
    expect(await reportOn(attempt, { ...event, mergeSha: MERGE })).toEqual({ outcome: "stale", starts: [] })
    expect(await todos()).toEqual(before)
  })

  test("a different attempt id cannot report for a TODO that still owns its lane", async () => {
    const attempt = await started(2)
    const before = await todos()
    expect(await reportOn({ ...attempt, attemptId: uuid() }, { kind: "finished", state: "merged" }))
      .toEqual({ outcome: "stale", starts: [] })
    expect(await todos()).toEqual(before)
  })

  test("racing terminal reports allocate one successor and replay its receipt", async () => {
    const attempt = await started(3)
    const event: Stack.RunEvent = { kind: "finished", state: "merged", mergeSha: MERGE }
    const receipts = await Promise.all([reportOn(attempt, event), reportOn(attempt, event)])
    expect(receipts.map((receipt) => receipt.outcome).sort()).toEqual(["applied", "repeated"])
    expect(receipts[0]!.starts).toEqual(receipts[1]!.starts)
    expect(receipts[0]!.starts).toHaveLength(1)
    expect(await sql(`SELECT id FROM todo_attempts`)).toHaveLength(2)
    expect(await stack()).toMatchObject({ version: 4 })
  })

  test("a terminal report with no successor still replays its empty receipt", async () => {
    const attempt = await started()
    const event: Stack.RunEvent = { kind: "finished", state: "failed", failure: "implement" }
    expect(await reportOn(attempt, event)).toEqual({ outcome: "applied", starts: [] })
    expect(await reportOn(attempt, event)).toEqual({ outcome: "repeated", starts: [] })
    expect(await sql(`SELECT id FROM todo_attempts`)).toHaveLength(1)
  })

  test("an ending moves only what it must: failed leaves the rest in place, merged closes the gap behind it", async () => {
    const attempt = await started(4)
    const failed = await reportOn(attempt, { kind: "finished", state: "failed", failure: "implement" })
    const places = async () => (await todos()).map(({ state, position }) => [state, position])
    expect(failed.starts).toEqual([])
    expect(await places()).toEqual([["failed", 1], ["queued", 2], ["queued", 3], ["queued", 4]])
    await applyOn(drop(1), true)
    expect(await places()).toEqual([["dropped", null], ["working", 1], ["queued", 2], ["queued", 3]])
  })

  test("a PR closed on GitHub drops the TODO; a dropped TODO's run is stale; with no runs nothing starts", async () => {
    const attempt = await started(2)
    await applyOn(drop(1), true)
    expect(await reportOn(attempt, { kind: "finished", state: "merged" })).toMatchObject({ outcome: "stale" })
    const second = (await sql<{ id: string; todoId: string }>(
      `SELECT id, todo_id AS "todoId" FROM todo_attempts WHERE id <> '${attempt.attemptId}'`,
    ))[0]!
    const next = { attemptId: second.id, todoId: second.todoId, repoId: REPO, ordinal: 1 }
    expect(await reportOn(next, { kind: "finished", state: "dropped", note: "closed_on_github" }, false)).toEqual({
      outcome: "applied",
      starts: [],
    })
    expect((await todos()).map(({ state }) => state)).toEqual(["dropped", "dropped"])
  })

  test("attemptTodo reads the attempt's TODO and the prompt revision it works on", async () => {
    const attempt = await started()
    const read = await runtime.runPromise(
      Effect.gen(function* () {
        const { database } = yield* TestDatabase.Scratch
        return yield* Stack.attemptTodo(attempt).pipe(Effect.provide(database))
      }),
    )
    expect(read._tag === "Some" && read.value).toMatchObject({
      number: 1,
      title: "Retry webhook delivery",
      prompt: "Retry a failed delivery **three** times.",
      acceptance: [],
      issueNumber: null,
      createdBy: "person-maya",
      createdLogin: "maya",
      state: "working",
      attempt: 1,
    })
    const none = await runtime.runPromise(
      Effect.gen(function* () {
        const { database } = yield* TestDatabase.Scratch
        return yield* Stack.attemptTodo({ ...attempt, attemptId: uuid() }).pipe(Effect.provide(database))
      }),
    )
    expect(none._tag).toBe("None")
  })
})

describe("observability", () => {
  test("each change is a span, a log line and a count, with ids and numbers only: never a title or a prompt", async () => {
    const observed = observe()
    const title = `title-${uuid()}`
    const prompt = `prompt-${uuid()}`
    const change = commit({ title, prompt })
    await applyOn(change, false, observed)
    await applyOn(change, false, observed)
    await applyOn({ ...change, op: { kind: "drop", number: 1 } }, false, observed)

    expect(observed.lines.map((line) => [line.message, line.annotations.outcome, line.annotations.op])).toEqual([
      // The commit's result reaches its person's feed inside its transaction (decision 0124).
      ["stack.commit.notice", undefined, undefined],
      ["stack.apply", "committed", "commit"],
      ["stack.apply", "repeated", "commit"],
      ["stack.apply", "conflict", "drop"],
    ])
    expect(observed.lines[1]!.annotations).toMatchObject({ repoId: REPO, opId: change.opId, number: 1, version: 1, via: "person" })
    // Each holds its transaction's spans; the SQL client's spans carry no parameter, so no title or prompt.
    expect(observed.spans.filter((span) => span.name === "stack.apply")).toHaveLength(3)
    expect(observed.count(Stack.changes, { op: "commit", outcome: "committed" })).toBe(1)
    expect(observed.count(Stack.changes, { op: "commit", outcome: "repeated" })).toBe(1)
    expect(observed.count(Stack.transitions, { from: "new", to: "queued" })).toBe(1)
    expect(observed.recorded()).not.toContain(title)
    expect(observed.recorded()).not.toContain(prompt)
  })

  test("a drop counts its transition", async () => {
    const observed = observe()
    await applyOn(commit(), false, observed)
    await applyOn(drop(1), false, observed)
    expect(observed.count(Stack.transitions, { from: "queued", to: "dropped" })).toBe(1)
  })
})

describe("concurrent writers", () => {
  test("twelve writers commit at once: twelve numbers, positions 1 to 12, no change lost", async () => {
    const changes = Array.from({ length: 12 }, () => commit())
    const applied = await Promise.all(changes.map((change) => applyOn(change, true)))

    const numbers = applied.map((result) => (result.kind === "applied" ? result.receipt.number : 0))
    expect([...numbers].sort((a, b) => a! - b!)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
    const after = await loaded()
    expect(violations(after)).toEqual([])
    expect(openOf(after).map((todo) => todo.id).sort()).toEqual(changes.map((change) => change.opId).sort())
    expect(after.todos.filter((todo) => todo.state === "working")).toHaveLength(1)
    expect(await stack()).toEqual({ nextNumber: 13, version: 12 })
  })

  test("random races of commits and drops: every committed TODO is there, every drop held, and the rules hold", async () => {
    const Round = Schema.Array(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("commit") }),
        Schema.Struct({ kind: Schema.Literal("after"), number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })) }),
        Schema.Struct({ kind: Schema.Literal("drop"), number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })) }),
        Schema.Struct({ kind: Schema.Literal("configure"), lanes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })), independent: Schema.Boolean }),
      ]),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(6))
    const rounds = Arbitrary.array(Arbitrary.schema(Round), { minLength: 1, maxLength: 4 })
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(
        rounds,
        (history) =>
          Effect.promise(async () => {
            await sql(`TRUNCATE stack_ops, todo_attempts, todo_requests, todo_leaves, todos, stacks`)
            const committed = new Set<string>()
            const dropped = new Set<number>()
            for (const round of history) {
              const changes = round.map((step) =>
                step.kind === "commit"
                  ? commit()
                  : step.kind === "after"
                  ? commit({ op: { kind: "commit", title: "T", prompt: "P", acceptance: [], after: step.number } })
                  : step.kind === "configure"
                  ? configure(step.lanes, step.independent ? "independent" : "stacked")
                  : drop(step.number)
              )
              const applied = await Promise.all(changes.map((change) => applyOn(change, true)))
              applied.forEach((result, index) => {
                if (result.kind !== "applied") return
                const change = changes[index]!
                if (result.receipt.outcome === "committed") committed.add(change.opId)
                if (result.receipt.outcome === "dropped" && change.op.kind === "drop") dropped.add(change.op.number)
              })
            }
            const after = await loaded()
            const byNumber = new Map(after.todos.map((todo) => [todo.number, todo]))
            // With every op settled, no lane idles while a ready TODO waits.
            const idle = after.todos.filter((todo) => todo.state === "working").length < after.lanes &&
              openOf(after).some((todo) => isReady(after.todos, todo))
            return violations(after).length === 0 && !idle &&
              after.todos.length === committed.size &&
              after.todos.every((todo) => committed.has(todo.id)) &&
              [...dropped].every((number) => byNumber.get(number)?.state === "dropped") &&
              after.nextNumber === committed.size + 1
          }),
        { runs: 12, size: 30, seed: 20261020 },
      ),
    )
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
  }, 120_000)
})

describe("the seam's errors", () => {
  test("RunsUnavailable carries the host's code", () => {
    expect(new Stack.RunsUnavailable({ errorCode: "no_host" })).toMatchObject({ _tag: "@smthrs/mvp/stack/RunsUnavailable", errorCode: "no_host" })
  })

  test("isRefusal names the outcomes the route refuses", () => {
    expect(["committed", "dropped", "configured", "stack_full", "merged", "not_found", "not_retryable", "after_not_open"]
      .map((outcome) => Stack.isRefusal(outcome as never))).toEqual([false, false, false, true, true, true, true, true])
  })
})


test("drop retains published successor admissions after its old run is cancelled", async () => {
  const first = await applyOn(commit(), true)
  await applyOn(commit(), true)
  if (first.kind !== "applied") throw new Error("not applied")
  const attempt = first.receipt.starts[0]!
  const published = await runtime.runPromise(Stack.report(attempt, { kind: "published", headSha: "a".repeat(40), prNumber: 1, draft: false }, { runs: true }))
  const dropping = drop(1)
  const receipt = await applyOn(dropping, true)
  expect((receipt.kind === "applied" || receipt.kind === "repeated") && receipt.receipt.starts).toEqual(published.starts)
  const replay = await applyOn(dropping, true)
  expect((replay.kind === "applied" || replay.kind === "repeated") && replay.receipt.starts).toEqual(published.starts)
  expect(await sql("SELECT id FROM todo_attempts")).toHaveLength(2)
})

test.each(["working", "in_review"] as const)("only an engine-confirmed cancelled current attempt can be reset while %s", async (state) => {
  const made = await runtime.runPromise(Stack.apply(commit(), { runs: true }))
  if (made.kind !== "applied") throw new Error("commit refused")
  const first = made.receipt.starts[0]!
  if (state === "in_review") await runtime.runPromise(Stack.report(first, { kind: "published", headSha: "b".repeat(40), prNumber: 1, draft: false }, { runs: true }))
  const retry: Stack.Change = { ...drop(1), op: { kind: "retry", number: 1 } }
  const running = await runtime.runPromise(Stack.apply(retry, { runs: true }))
  expect(running).toMatchObject({ kind: "applied", receipt: { outcome: "not_retryable" } })
  const stopped = await runtime.runPromise(Stack.apply({ ...retry, opId: uuid() }, { runs: true, stoppedAttemptId: first.attemptId }))
  expect(stopped).toMatchObject({ kind: "applied", receipt: { starts: [expect.objectContaining({ ordinal: 2, todoId: first.todoId })] } })
  const stale = await runtime.runPromise(Stack.report(first, { kind: "finished", state: "failed", failure: "implement" }, { runs: true }))
  expect(stale.outcome).toBe("stale")
})

test("a queued successor is admitted exactly when the retried TODO publishes", async () => {
  const first = await runtime.runPromise(Stack.apply(commit(), { runs: true }))
  if (first.kind !== "applied") throw new Error("commit refused")
  const attempt = first.receipt.starts[0]!
  await runtime.runPromise(Stack.report(attempt, { kind: "finished", state: "failed", failure: "implement" }, { runs: true }))
  // The failed predecessor holds the successor until retry publishes.
  await runtime.runPromise(Stack.apply(commit(), { runs: true }))
  const retry = await runtime.runPromise(Stack.apply({ ...drop(1), op: { kind: "retry", number: 1 } }, { runs: true }))
  if (retry.kind !== "applied") throw new Error("retry refused")
  expect(retry.receipt.starts).toHaveLength(1)
  const next = retry.receipt.starts[0]!
  expect(next).toMatchObject({ number: 1, ordinal: 2 })
  const published = await runtime.runPromise(Stack.report(next, {
    kind: "published", headSha: "a".repeat(40), prNumber: 12, draft: false,
  }, { runs: true }))
  expect(published.starts).toMatchObject([{ number: 2, ordinal: 1 }])
  expect(await runtime.runPromise(Stack.report(next, {
    kind: "published", headSha: "a".repeat(40), prNumber: 12, draft: false,
  }, { runs: true }))).toEqual({ outcome: "repeated", starts: published.starts })
})


test("repeated retry before admission cannot erase the old attempt's base identity", async () => {
  const first = await applyOn(commit(), true)
  if (first.kind !== "applied") throw new Error("commit refused")
  const a = first.receipt.starts[0]!
  await applyOn(commit(), true)
  const published = await runtime.runPromise(Stack.report(a, {
    kind: "published", headSha: "a".repeat(40), prNumber: 1, draft: false,
  }, { runs: true }))
  const b = published.starts[0]!
  await runtime.runPromise(Stack.report(b, {
    kind: "branch", branch: "smithers/old-base", baseSha: "a".repeat(40), baseRef: "smithers/first",
  }, { runs: true }))
  await runtime.runPromise(Stack.report(b, {
    kind: "published", headSha: "b".repeat(40), prNumber: 2, draft: true,
  }, { runs: true }))
  const retry = () => ({ ...drop(2), op: { kind: "retry" as const, number: 2 } })
  const queued = await runtime.runPromise(Stack.apply(retry(), { runs: false, stoppedAttemptId: b.attemptId }))
  expect(queued).toMatchObject({ receipt: { outcome: "retried", starts: [] } })
  await runtime.runPromise(Stack.report(a, {
    kind: "finished", state: "dropped", note: "closed_on_github",
  }, { runs: false }))
  // The TODO it waited on closed unmerged: the retried TODO fails base_closed again, and a person decides again. The
  // repeated press answers its first receipt; a new one stacks it on what the closed one stacked on (the default branch).
  expect(await sql("SELECT state, failure, after FROM todos WHERE number = 2")).toEqual([{ state: "failed", failure: "base_closed", after: null }])
  const again = await runtime.runPromise(Stack.apply(retry(), { runs: false }))
  expect(again).toMatchObject({ receipt: { outcome: "retried", starts: [] } })
  expect(await runtime.runPromise(Stack.baseTodoOf(REPO, "smithers/old-base"))).toMatchObject({
    value: { number: 2, prNumber: 2, state: "failed" },
  })
})


test("dropping an in-review base holds its queued successors until Retry", async () => {
  const made = await applyOn(commit(), true)
  if (made.kind !== "applied") throw new Error("commit refused")
  const first = made.receipt.starts[0]!
  await runtime.runPromise(Stack.report(first, { kind: "branch", branch: "base", baseRef: "main", baseSha: "a".repeat(40) }, { runs: true }))
  await runtime.runPromise(Stack.report(first, { kind: "published", headSha: "b".repeat(40), prNumber: 1, draft: false }, { runs: true }))
  await applyOn(commit(), false)
  const dropped = await applyOn(drop(1), true)
  expect(dropped).toMatchObject({ receipt: { starts: [] } })
  expect(await sql("SELECT state, failure FROM todos WHERE number = 2")).toEqual([{ state: "failed", failure: "base_closed" }])
  const retry = await applyOn({ ...drop(2), op: { kind: "retry", number: 2 } }, true)
  expect(retry).toMatchObject({ receipt: { starts: [{ number: 2, ordinal: 1 }] } })
  if (retry.kind !== "applied") throw new Error("retry refused")
  expect((await runtime.runPromise(Stack.belowOf(retry.receipt.starts[0]!)))._tag).toBe("None")
})


test("a delayed invalidation follows the archived branch of a retried intermediate descendant", async () => {
  const first = await applyOn(commit(), true)
  if (first.kind !== "applied") throw new Error("commit refused")
  const a = first.receipt.starts[0]!
  await applyOn(commit(), true)
  await applyOn(commit(), true)
  const branch = (attempt: Stack.AttemptStart, name: string, baseRef: string) => runtime.runPromise(Stack.report(attempt,
    { kind: "branch", branch: name, baseRef, baseSha: "a".repeat(40) }, { runs: true }))
  const publish = (attempt: Stack.AttemptStart, prNumber: number) => runtime.runPromise(Stack.report(attempt,
    { kind: "published", headSha: "a".repeat(40), prNumber, draft: true }, { runs: true }))
  await branch(a, "a", "main")
  const b = (await publish(a, 1)).starts[0]!
  await branch(b, "b", "a")
  const c = (await publish(b, 2)).starts[0]!
  await branch(c, "c", "b")
  await runtime.runPromise(Stack.report(b, { kind: "finished", state: "failed", failure: "implement" }, { runs: true }))
  await applyOn({ ...drop(2), op: { kind: "retry", number: 2 } }, true)
  await applyOn(drop(1), true)
  expect(await runtime.runPromise(Stack.descendants(a))).toMatchObject([{ attemptId: c.attemptId }])
})

test("admission records the base before Begin, so drop discovers a delayed execution", async () => {
  const first = await applyOn(commit(), true)
  if (first.kind !== "applied") throw new Error("commit refused")
  const a = first.receipt.starts[0]!
  await applyOn(commit(), true)
  await runtime.runPromise(Stack.report(a, { kind: "branch", branch: "base", baseRef: "main", baseSha: "a".repeat(40) }, { runs: true }))
  const b = (await runtime.runPromise(Stack.report(a, { kind: "published", headSha: "a".repeat(40), prNumber: 1, draft: false }, { runs: true }))).starts[0]!
  expect(await sql("SELECT branch, base_ref FROM todos WHERE number = 2")).toEqual([{ branch: null, base_ref: "base" }])
  await applyOn(drop(1), true)
  expect(await runtime.runPromise(Stack.descendants(a))).toMatchObject([{ attemptId: b.attemptId, prNumber: null }])
})

test("a Retry waiting for a lane fails base_closed again when the TODO it stacks on closes; Retry once more starts it on main", async () => {
  const made = await applyOn(commit(), true)
  if (made.kind !== "applied") throw new Error("commit refused")
  const a = made.receipt.starts[0]!
  await applyOn(commit(), true)
  await runtime.runPromise(Stack.report(a, { kind: "branch", branch: "base", baseRef: "main", baseSha: "a".repeat(40) }, { runs: true }))
  const b = (await runtime.runPromise(Stack.report(a, { kind: "published", headSha: "a".repeat(40), prNumber: 1, draft: false }, { runs: true }))).starts[0]!
  await applyOn(configure(2, "stacked"), true)
  // An independent TODO takes the second lane.
  const other = await applyOn(commitAfter(null), true)
  if (other.kind !== "applied") throw new Error("commit refused")
  const c = other.receipt.starts[0]!
  await runtime.runPromise(Stack.report(b, { kind: "finished", state: "failed", failure: "base_closed" }, { runs: true }))
  await applyOn(configure(1, "stacked"), true)
  // C holds the only lane: the retried TODO waits, still stacked on A, which is In review.
  const retry = await applyOn({ ...drop(2), op: { kind: "retry", number: 2 } }, true)
  expect(retry).toMatchObject({ receipt: { outcome: "retried", starts: [] } })
  expect(await sql(`SELECT state, after::text AS after FROM todos WHERE number = 2`)).toEqual([{ state: "queued", after: a.todoId }])
  await runtime.runPromise(Stack.report(a, { kind: "finished", state: "dropped", note: "closed_on_github" }, { runs: true }))
  expect(await sql("SELECT state, failure, after FROM todos WHERE number = 2")).toEqual([{ state: "failed", failure: "base_closed", after: null }])
  const again = await applyOn({ ...drop(2), op: { kind: "retry", number: 2 } }, true)
  expect(again).toMatchObject({ receipt: { outcome: "retried", starts: [] } })
  const admitted = await runtime.runPromise(Stack.report(c, { kind: "finished", state: "failed", failure: "implement" }, { runs: true }))
  expect(admitted.starts).toMatchObject([{ todoId: b.todoId, ordinal: 2 }])
  expect((await runtime.runPromise(Stack.belowOf(admitted.starts[0]!)))._tag).toBe("None")
})


test("Retry of a grandchild skips ancestors failed by the same closed base", async () => {
  const made = await applyOn(commit(), true)
  if (made.kind !== "applied") throw new Error("commit refused")
  const a = made.receipt.starts[0]!
  await applyOn(commit(), true)
  await applyOn(commit(), true)
  const branch = (attempt: Stack.AttemptStart, name: string, baseRef: string) => runtime.runPromise(Stack.report(attempt,
    { kind: "branch", branch: name, baseRef, baseSha: "a".repeat(40) }, { runs: true }))
  const publish = (attempt: Stack.AttemptStart, prNumber: number) => runtime.runPromise(Stack.report(attempt,
    { kind: "published", headSha: "a".repeat(40), prNumber, draft: true }, { runs: true }))
  await branch(a, "a", "main")
  const b = (await publish(a, 1)).starts[0]!
  await branch(b, "b", "a")
  const c = (await publish(b, 2)).starts[0]!
  await branch(c, "c", "b")
  await applyOn(drop(1), true)
  for (const attempt of [c, b]) await runtime.runPromise(Stack.report(attempt,
    { kind: "finished", state: "failed", failure: "base_closed" }, { runs: true }))
  const retry = await applyOn({ ...drop(3), op: { kind: "retry", number: 3 } }, true)
  if (retry.kind !== "applied") throw new Error("retry refused")
  expect(retry.receipt.starts).toMatchObject([{ todoId: c.todoId, ordinal: 2 }])
  expect((await runtime.runPromise(Stack.belowOf(retry.receipt.starts[0]!)))._tag).toBe("None")
})


test("a TODO queued on a working one waits through its base's close; dropping the failed one starts it on main", async () => {
  const made = await applyOn(commit(), true)
  if (made.kind !== "applied") throw new Error("commit refused")
  const a = made.receipt.starts[0]!
  await applyOn(commit(), true)
  await runtime.runPromise(Stack.report(a, { kind: "branch", branch: "base", baseRef: "main", baseSha: "a".repeat(40) }, { runs: true }))
  const b = (await runtime.runPromise(Stack.report(a, { kind: "published", headSha: "a".repeat(40), prNumber: 1, draft: false }, { runs: true }))).starts[0]!
  await applyOn(commit(), true)
  // T1 closes under T2 (Working): T2 now stacks on nothing, and T3 still waits for T2.
  await applyOn(drop(1), true)
  expect(await sql(`SELECT number, state, after::text AS after FROM todos WHERE number > 1 ORDER BY number`)).toEqual([
    { number: 2, state: "working", after: null },
    { number: 3, state: "queued", after: b.todoId },
  ])
  expect(await applyOn({ ...drop(3), op: { kind: "retry", number: 3 } }, true)).toMatchObject({ receipt: { outcome: "not_retryable" } })
  const settled = await runtime.runPromise(Stack.report(b, { kind: "finished", state: "failed", failure: "base_closed" }, { runs: true }))
  expect(settled.starts).toEqual([])
  const dropped = await applyOn(drop(2), true)
  if (dropped.kind !== "applied") throw new Error("drop refused")
  expect(dropped.receipt.starts).toMatchObject([{ number: 3, ordinal: 1 }])
  expect((await runtime.runPromise(Stack.belowOf(dropped.receipt.starts[0]!)))._tag).toBe("None")
})

test("descendant discovery ignores absent attempts, branchless work and a base that is still open", async () => {
  const made = await applyOn(commit(), true)
  if (made.kind !== "applied") throw new Error("commit refused")
  const first = made.receipt.starts[0]!
  expect(await runtime.runPromise(Stack.descendants({ ...first, attemptId: uuid() }))).toEqual([])
  expect(await runtime.runPromise(Stack.descendants(first))).toEqual([])
  await runtime.runPromise(Stack.report(first, { kind: "branch", branch: "open-base", baseRef: "main", baseSha: "a".repeat(40) }, { runs: true }))
  expect(await runtime.runPromise(Stack.descendants(first))).toEqual([])
  expect(await sql("SELECT state, failure FROM todos")).toEqual([{ state: "working", failure: null }])
})

describe("independent lanes (decision 0135)", () => {
  const publish = (attempt: Stack.AttemptStart, prNumber: number, branch = `smithers/t${attempt.number}`) =>
    runtime.runPromise(Effect.gen(function* () {
      yield* Stack.report(attempt, { kind: "branch", branch, baseRef: "main", baseSha: "a".repeat(40) }, { runs: true })
      return yield* Stack.report(attempt, { kind: "published", headSha: "b".repeat(40), prNumber, draft: false }, { runs: true })
    }))
  const states = async () => (await sql<{ state: string }>(`SELECT state FROM todos WHERE repo_id = '${REPO}' ORDER BY number`)).map((row) => row.state)

  test("ten lanes: ten Working at once, one fails, nine publish, and a TODO after another waits for it, then stacks on it", async () => {
    expect(await applyOn(configure(10, "independent"), true)).toMatchObject({ kind: "applied", receipt: { outcome: "configured", starts: [] } })
    const starts: Array<Stack.AttemptStart> = []
    for (let index = 0; index < 10; index++) {
      const applied = await applyOn(commit(), true)
      if (applied.kind !== "applied") throw new Error("commit refused")
      starts.push(...applied.receipt.starts)
    }
    expect(starts.map((start) => start.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(await states()).toEqual(Array(10).fill("working"))
    // T11 stacks on T3 by choice: it waits though no lane is free and, later, while one is.
    expect(await applyOn(commitAfter(3), true)).toMatchObject({ receipt: { outcome: "committed", number: 11, starts: [] } })
    expect(await sql(`SELECT after::text AS after FROM todos WHERE number = 11`)).toEqual([{ after: starts[2]!.todoId }])
    const failed = await runtime.runPromise(Stack.report(starts[6]!, { kind: "finished", state: "failed", failure: "implement" }, { runs: true }))
    expect(failed.starts).toEqual([])
    for (const start of starts.filter((_, index) => index !== 6 && index !== 2)) expect((await publish(start, start.number)).starts).toEqual([])
    expect(await states()).toEqual(["in_review", "in_review", "working", "in_review", "in_review", "in_review", "failed", "in_review", "in_review", "in_review", "queued"])
    // T3 publishes: T11 starts on T3's branch.
    const third = await publish(starts[2]!, 3, "smithers/t3-base")
    expect(third.starts).toMatchObject([{ number: 11, ordinal: 1 }])
    expect(await sql(`SELECT base_ref AS "baseRef" FROM todos WHERE number = 11`)).toEqual([{ baseRef: "smithers/t3-base" }])
    expect(await runtime.runPromise(Stack.belowOf(third.starts[0]!))).toMatchObject({ value: { number: 3, branch: "smithers/t3-base", prNumber: 3 } })
    expect(await sql(`SELECT count(*)::int AS n FROM todos WHERE state = 'in_review'`)).toEqual([{ n: 9 }])
    expect(violations(await loaded())).toEqual([])
  })

  test("a stacked repository's commit stacks on the last open TODO; an independent one's on nothing; a commit may choose", async () => {
    await applyOn(commit())
    await applyOn(commit())
    await applyOn(configure(1, "independent"))
    await applyOn(commit())
    await applyOn(commitAfter(1))
    await applyOn(configure(1, "stacked"))
    await applyOn(commitAfter(null))
    await applyOn(commit())
    const ids = await sql<{ id: string }>(`SELECT id FROM todos ORDER BY number`)
    expect((await sql<{ after: string | null }>(`SELECT after::text AS after FROM todos ORDER BY number`)).map((row) => row.after))
      .toEqual([null, ids[0]!.id, null, ids[0]!.id, null, ids[4]!.id])
  })

  test("a commit after a TODO that isn't open is refused, keeps its receipt and spends no number", async () => {
    await applyOn(commit())
    await applyOn(drop(1))
    for (const after of [1, 99]) {
      const refused = commitAfter(after)
      expect(await applyOn(refused)).toMatchObject({ kind: "applied", receipt: { outcome: "after_not_open", starts: [] } })
      expect(await applyOn(refused)).toEqual({ kind: "repeated", receipt: { outcome: "after_not_open", starts: [] } })
    }
    expect(await stack()).toMatchObject({ nextNumber: 2 })
  })

  test("configure writes the stack's settings, starts what a raise frees, keeps a receipt, and starts nothing with no runs", async () => {
    for (let index = 0; index < 3; index++) await applyOn(commitAfter(null), false)
    const quiet = await applyOn(configure(3, "independent", 200), false)
    expect(quiet).toMatchObject({ kind: "applied", receipt: { outcome: "configured", starts: [] } })
    expect(await sql(`SELECT lanes, max_open AS "maxOpen", base FROM stacks`)).toEqual([{ lanes: 3, maxOpen: 200, base: "independent" }])
    expect(await states()).toEqual(["queued", "queued", "queued"])
    const change = configure(2, "independent", 200)
    const raised = await applyOn(change, true)
    expect(raised).toMatchObject({ receipt: { outcome: "configured", starts: [{ number: 1 }, { number: 2 }] } })
    expect(await applyOn(change, true)).toMatchObject({ kind: "repeated" })
    expect(await states()).toEqual(["working", "working", "queued"])
    expect(await sql(`SELECT op, outcome, actor_id AS "actorId" FROM stack_ops WHERE id = '${change.opId}'`))
      .toEqual([{ op: "configure", outcome: "configured", actorId: "person-ada" }])
    expect(await applyOn(configure(1, "independent", 1), true)).toMatchObject({ receipt: { starts: [] } })
    expect(await applyOn(commit(), true)).toMatchObject({ receipt: { outcome: "stack_full" } })
  })

  test("a raise starts the oldest ready TODOs first, whatever order Postgres reads the stack's rows in", async () => {
    for (let index = 0; index < 3; index++) await applyOn(commitAfter(null), false)
    // A new version of T1's row lands after T3's on the heap, and a plan that scans the heap reads T2, T3, T1: the
    // order a sequential scan, a hash join or a stats change can hand the writer, whose read has no ORDER BY.
    await sql(`UPDATE todos SET title = title WHERE number = 1`)
    const raised = await runtime.runPromise(Effect.gen(function* () {
      const { database } = yield* TestDatabase.Scratch
      return yield* Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient
        for (const setting of ["enable_indexscan", "enable_bitmapscan", "enable_indexonlyscan", "enable_hashjoin", "enable_mergejoin"]) {
          yield* client.unsafe(`SET ${setting} = off`)
        }
        const read = yield* client.unsafe<{ number: number }>(`SELECT number FROM todos WHERE repo_id = '${REPO}'`)
        expect(read.map((row) => row.number)).toEqual([2, 3, 1])
        return yield* Stack.apply(configure(2, "independent"), { runs: true })
      }).pipe(Effect.provide(database))
    }))
    expect(raised).toMatchObject({ receipt: { outcome: "configured", starts: [{ number: 1 }, { number: 2 }] } })
    expect(await states()).toEqual(["working", "working", "queued"])
  })

  test("a Working TODO waits for a runner until its run says one claimed it; any other state is stale and clears it", async () => {
    const made = await applyOn(commit(), true)
    if (made.kind !== "applied") throw new Error("commit refused")
    const attempt = made.receipt.starts[0]!
    const waiting = () => sql<{ waiting: string | null }>(`SELECT waiting FROM todos WHERE number = 1`)
    const observed = observe()
    expect(await runtime.runPromise(observed.provide(Stack.report(attempt, { kind: "waiting", waiting: "runner" }, { runs: true }))))
      .toEqual({ outcome: "applied", starts: [] })
    expect(await waiting()).toEqual([{ waiting: "runner" }])
    expect(observed.lines.at(-1)).toMatchObject({ message: "stack.report", annotations: { kind: "waiting", waiting: "runner" } })
    await runtime.runPromise(Stack.report(attempt, { kind: "waiting", waiting: null }, { runs: true }))
    expect(await waiting()).toEqual([{ waiting: null }])
    await runtime.runPromise(Stack.report(attempt, { kind: "waiting", waiting: "runner" }, { runs: true }))
    await publish(attempt, 1)
    expect(await waiting()).toEqual([{ waiting: null }])
    expect(await runtime.runPromise(Stack.report(attempt, { kind: "waiting", waiting: "runner" }, { runs: true }))).toEqual({ outcome: "stale", starts: [] })
  })

  test("a closed base fails only the Queued TODOs stacked on it; independent ones and those further up wait", async () => {
    await applyOn(configure(1, "independent"), true)
    const made = await applyOn(commit(), true)
    if (made.kind !== "applied") throw new Error("commit refused")
    const first = made.receipt.starts[0]!
    await applyOn(commit(), true)
    await applyOn(commitAfter(1), true)
    await applyOn(commitAfter(3), true)
    await applyOn(commit(), true)
    // T1 publishes: T2, the oldest ready, takes the lane; T3, stacked on T1, is ready and waits for one.
    await publish(first, 1, "smithers/t1")
    expect(await states()).toEqual(["in_review", "working", "queued", "queued", "queued"])
    expect(await runtime.runPromise(Stack.descendants({ ...first, baseClosed: true }))).toEqual([])
    expect(await sql(`SELECT number, state, failure FROM todos ORDER BY number`)).toEqual([
      { number: 1, state: "in_review", failure: null },
      { number: 2, state: "working", failure: null },
      { number: 3, state: "failed", failure: "base_closed" },
      { number: 4, state: "queued", failure: null },
      { number: 5, state: "queued", failure: null },
    ])
  })

  test("Fixes #n waits for every other open TODO from the issue, except those it stacks on", async () => {
    await applyOn(configure(4, "independent"), true)
    const issued = (after?: number | null) => commit({ op: { kind: "commit", title: "T", prompt: "P", acceptance: [], issue: 12, ...(after === undefined ? {} : { after }) } })
    const starts: Array<Stack.AttemptStart> = []
    for (const after of [undefined, undefined, 1]) {
      const applied = await applyOn(issued(after), true)
      if (applied.kind === "applied") starts.push(...applied.receipt.starts)
    }
    const above = (attempt: Stack.AttemptStart) => runtime.runPromise(Stack.openAboveFromIssue(attempt))
    // T1 and T2 are independent, from one issue: each waits for the other. T3 stacks on T1: T1 doesn't count for it.
    expect(await above(starts[0]!)).toBe(2)
    expect(await above(starts[1]!)).toBe(2)
    const third = (await publish(starts[0]!, 1)).starts[0]!
    expect(await above(third)).toBe(1)
    await applyOn(drop(2), true)
    expect(await above(third)).toBe(0)
  })

  test("each change logs its lanes: how many there are, Working, ready for a lane, and held by a TODO they stack on", async () => {
    const observed = observe()
    await applyOn(commit(), true, observed)
    await applyOn(commit(), true, observed)
    await applyOn(commitAfter(null), true, observed)
    expect(observed.lines.filter((line) => line.message === "stack.apply").at(-1)!.annotations)
      .toMatchObject({ lanes: 1, working: 1, ready: 1, held: 1 })
    expect(observed.count(Stack.admissions, { base: "default" })).toBe(1)
    expect(observed.lines.find((line) => line.message === "todo.run.requested")!.annotations).toMatchObject({ base: "default" })
  })
})

// Issue-tracking proof (e), production 2026-11-02: a TODO made from an issue reached a merged pull request that closed
// the issue, and the issue's work showed nothing. The stack's writer links the work to the issue it came from
// (decision 0147): the TODO, its pull request and its merge, each as its state changes, so the issue's status follows.
describe("a TODO made from an issue links its work to the issue", () => {
  const links = () =>
    sql<{ kind: string; ref: string; state: string | null; url: string | null; source: string }>(`
      SELECT kind, ref, state, url, source FROM work_links WHERE repo_id = '${REPO}' AND number = 12 ORDER BY kind`)
  const status = async () => workStatusOf((await links()).map((link) => ({ ...link, updated_at: "" })) as never)
  const reportAs = (attempt: Stack.RunAttempt, event: Stack.RunEvent) =>
    runtime.runPromise(Effect.gen(function* () {
      const { database } = yield* TestDatabase.Scratch
      return yield* Stack.report(attempt, event, { runs: true }).pipe(Effect.provide(database))
    }))

  test("working, in review with its pull request, merged with its merge: each on the issue, its status following", async () => {
    await sql(`TRUNCATE work_links`)
    const committed = await applyOn(commit({ op: { kind: "commit", title: "T", prompt: "P", acceptance: [], issue: 12 } }), true)
    if (committed.kind !== "applied") throw new Error("not applied")
    const start = committed.receipt.starts[0]!
    const attempt = { attemptId: start.attemptId, todoId: start.todoId, repoId: REPO, ordinal: start.ordinal }
    expect(await links()).toEqual([{ kind: "session", ref: "TODO #1", state: "working", url: null, source: "todo:1" }])
    expect(await status()).toBe("working")
    await reportAs(attempt, { kind: "published", headSha: "b".repeat(40), prNumber: 7, draft: false })
    expect(await links()).toEqual([
      { kind: "pr", ref: "#7", state: "open", url: "https://github.com/octo/hello/pull/7", source: "todo:1" },
      { kind: "session", ref: "TODO #1", state: null, url: null, source: "todo:1" },
    ])
    expect(await status()).toBe("in_review")
    await reportAs(attempt, { kind: "finished", state: "merged", note: "merged_on_github", mergeSha: "c".repeat(40) })
    expect(await links()).toEqual([
      { kind: "merge", ref: "c".repeat(12), state: "merged", url: `https://github.com/octo/hello/commit/${"c".repeat(40)}`, source: "todo:1" },
      { kind: "pr", ref: "#7", state: "merged", url: "https://github.com/octo/hello/pull/7", source: "todo:1" },
      { kind: "session", ref: "TODO #1", state: "done", url: null, source: "todo:1" },
    ])
    expect(await status()).toBe("merged")
  })

  test("a dropped TODO's link says closed; a TODO made from no issue links nothing", async () => {
    await sql(`TRUNCATE work_links`)
    await applyOn(commit({ op: { kind: "commit", title: "T", prompt: "P", acceptance: [], issue: 12 } }))
    expect(await links()).toEqual([{ kind: "session", ref: "TODO #1", state: null, url: null, source: "todo:1" }])
    await applyOn(drop(1))
    expect(await links()).toEqual([{ kind: "session", ref: "TODO #1", state: "closed", url: null, source: "todo:1" }])
    await applyOn(commit())
    expect(await sql(`SELECT count(*)::int AS n FROM work_links`)).toEqual([{ n: 1 }])
  })
})

// Decision 0153: a TODO is a leaf under one issue, and everyone who may read the issue reads the leaf's state, never its
// title. A deferred trigger keeps `todo_leaves` in the transaction of every change to a TODO with an issue. Validation is
// `no_criteria` or `pending` until proof exists: nothing here claims a TODO passed.
describe("the readable leaf projection (todo_leaves)", () => {
  const leaves = () =>
    sql<{ number: number; issue: number; state: string; validation: string; pr: number | null }>(`
      SELECT l.number, l.issue_number AS issue, l.state, l.validation, l.pr_number AS pr
      FROM todo_leaves l WHERE l.repo_id = '${REPO}' ORDER BY l.number`)
  const fromIssue = (acceptance: ReadonlyArray<string> = [], after?: number | null) =>
    commit({ op: { kind: "commit", title: "Secret title", prompt: "Secret prompt", acceptance, issue: 12, ...(after === undefined ? {} : { after }) } })
  const reportAs = (attempt: Stack.RunAttempt, event: Stack.RunEvent) =>
    runtime.runPromise(Effect.gen(function* () {
      const { database } = yield* TestDatabase.Scratch
      return yield* Stack.report(attempt, event, { runs: true }).pipe(Effect.provide(database))
    }))

  test("a commit from an issue writes its leaf; criteria make it pending, none make it no_criteria; no issue, no leaf", async () => {
    await applyOn(fromIssue())
    await applyOn(fromIssue(["429 has Retry-After"]))
    await applyOn(commit())
    expect(await leaves()).toEqual([
      { number: 1, issue: 12, state: "queued", validation: "no_criteria", pr: null },
      { number: 2, issue: 12, state: "queued", validation: "pending", pr: null },
    ])
    // A leaf changes in the transaction that changed its TODO, and says when.
    expect(await sql(`SELECT count(*)::int AS n FROM todo_leaves l JOIN todos t ON t.id = l.todo_id
      WHERE l.updated_at <> t.updated_at`)).toEqual([{ n: 0 }])
  })

  test("the leaf follows each report: working, in review with its pull request, merged; never passed", async () => {
    const committed = await applyOn(fromIssue(["criterion"]), true)
    if (committed.kind !== "applied") throw new Error("not applied")
    const start = committed.receipt.starts[0]!
    const attempt = { attemptId: start.attemptId, todoId: start.todoId, repoId: REPO, ordinal: start.ordinal }
    expect(await leaves()).toEqual([{ number: 1, issue: 12, state: "working", validation: "pending", pr: null }])
    await reportAs(attempt, { kind: "published", headSha: "b".repeat(40), prNumber: 7, draft: false })
    expect(await leaves()).toEqual([{ number: 1, issue: 12, state: "in_review", validation: "pending", pr: 7 }])
    await reportAs(attempt, { kind: "finished", state: "merged", note: "merged_on_github", mergeSha: "c".repeat(40) })
    expect(await leaves()).toEqual([{ number: 1, issue: 12, state: "merged", validation: "pending", pr: 7 }])
  })

  test("a drop and a closed base each reach the leaf", async () => {
    await sql(`TRUNCATE work_links`)
    await applyOn(configure(1, "independent"), true)
    const made = await applyOn(fromIssue(), true)
    if (made.kind !== "applied") throw new Error("commit refused")
    const first = made.receipt.starts[0]!
    await applyOn(fromIssue([], 1), true)
    await applyOn(fromIssue(), true)
    await runtime.runPromise(Stack.report(first, { kind: "branch", branch: "smithers/t1", baseRef: "main", baseSha: "a".repeat(40) }, { runs: true }))
    // T1 is Working on its branch, T2 is stacked on it and Queued. T1's base closes: T2 fails base_closed.
    expect(await runtime.runPromise(Stack.descendants({ ...first, baseClosed: true }))).toEqual([])
    await applyOn(drop(3))
    expect(await leaves()).toEqual([
      { number: 1, issue: 12, state: "working", validation: "no_criteria", pr: null },
      { number: 2, issue: 12, state: "failed", validation: "no_criteria", pr: null },
      { number: 3, issue: 12, state: "dropped", validation: "no_criteria", pr: null },
    ])
    // The closed base's failure reaches the issue's work links too, as every other ending does.
    expect(await sql(`SELECT state FROM work_links WHERE repo_id = '${REPO}' AND number = 12 AND ref = 'TODO #2'`))
      .toEqual([{ state: "failed" }])
  })

  test("a repeated op changes no leaf", async () => {
    const op = fromIssue()
    await applyOn(op)
    const [before] = await sql<{ at: string }>(`SELECT updated_at::text AS at FROM todo_leaves`)
    expect(await applyOn(op)).toMatchObject({ kind: "repeated" })
    expect(await sql(`SELECT updated_at::text AS at FROM todo_leaves`)).toEqual([before])
  })
})

// Decision 0153, step 6a: `attach` sets the issue of a TODO whose issue is null or names a deleted issue. Its order is
// fixed: the op id's receipt replays first, then the issue is checked live in the projection (an issue of the same
// repository, not deleted), then the TODO's eligibility. The leaf and the work links follow in the same transaction.
describe("attach", () => {
  const issueRow = (number: number, fields: { kind?: string; deleted?: boolean } = {}) =>
    sql(`INSERT INTO items (id, repo_id, number, kind, github_id, title, state, created_at, updated_at, source_updated_at,
        fetched_at, deleted_at)
      VALUES ('${REPO}#${number}', '${REPO}', ${number}, '${fields.kind ?? "issue"}', ${number}, 'Issue ${number}', 'open',
        now(), now(), now(), now(), ${fields.deleted === true ? "now()" : "NULL"})`)
  const attach = (number: number, issue: number, opId = uuid()): Stack.Change => ({
    opId, repoId: REPO, actor: maya, via: "person", op: { kind: "attach", number, issue },
  })
  const issueOf = async (number: number) =>
    (await sql<{ issue: number | null }>(`SELECT issue_number AS issue FROM todos WHERE repo_id = '${REPO}' AND number = ${number}`))[0]!.issue
  const leafOf = (number: number) =>
    sql(`SELECT issue_number AS issue, state, validation FROM todo_leaves WHERE repo_id = '${REPO}' AND number = ${number}`)
  beforeEach(() => sql(`DELETE FROM items WHERE repo_id = '${REPO}'`).then(() => sql(`TRUNCATE work_links`)))

  test("a TODO with no issue takes a live issue: its leaf and its work link follow in the same change", async () => {
    await issueRow(12)
    await applyOn(commit())
    const op = attach(1, 12)
    expect(await applyOn(op)).toMatchObject({ kind: "applied", receipt: { outcome: "issue_set", number: 1, starts: [] } })
    expect(await issueOf(1)).toBe(12)
    expect(await leafOf(1)).toEqual([{ issue: 12, state: "queued", validation: "no_criteria" }])
    expect(await sql(`SELECT number, ref FROM work_links WHERE repo_id = '${REPO}'`)).toEqual([{ number: 12, ref: "TODO #1" }])
    expect(await sql(`SELECT op, outcome FROM stack_ops WHERE id = '${op.opId}'`)).toEqual([{ op: "attach", outcome: "issue_set" }])
  })

  test("the op id's receipt replays before anything is checked again, even after the issue was deleted", async () => {
    await issueRow(12)
    await applyOn(commit())
    const op = attach(1, 12)
    await applyOn(op)
    await sql(`UPDATE items SET deleted_at = now() WHERE repo_id = '${REPO}' AND number = 12`)
    expect(await applyOn(op)).toMatchObject({ kind: "repeated", receipt: { outcome: "issue_set", number: 1 } })
    // Another payload under the same op id is a conflict, as for every op.
    expect(await applyOn({ ...op, op: { kind: "attach", number: 1, issue: 13 } })).toEqual({ kind: "conflict" })
  })

  test("a deleted issue, a missing one, a pull request and another repository's issue are refused issue_not_found", async () => {
    await issueRow(12, { deleted: true })
    await issueRow(14, { kind: "pull" })
    await sql(`INSERT INTO items (id, repo_id, number, kind, github_id, title, state, created_at, updated_at, source_updated_at, fetched_at)
      VALUES ('github/octo/other#15', 'github/octo/other', 15, 'issue', 9915, 'Elsewhere', 'open', now(), now(), now(), now())`)
    await applyOn(commit())
    for (const issue of [12, 13, 14, 15]) {
      expect([issue, await applyOn(attach(1, issue))]).toMatchObject([issue, { kind: "applied", receipt: { outcome: "issue_not_found" } }])
    }
    expect(await issueOf(1)).toBe(null)
    expect(await sql(`SELECT count(*)::int AS n FROM todo_leaves`)).toEqual([{ n: 0 }])
    await sql(`DELETE FROM items WHERE repo_id = 'github/octo/other'`)
  })

  test("a TODO whose issue is live is refused attached; one whose issue was deleted takes another", async () => {
    await issueRow(12)
    await issueRow(13)
    await applyOn(commit({ op: { kind: "commit", title: "T", prompt: "P", acceptance: [], issue: 12 } }))
    expect(await applyOn(attach(1, 13))).toMatchObject({ kind: "applied", receipt: { outcome: "attached" } })
    expect(await issueOf(1)).toBe(12)
    await sql(`UPDATE items SET deleted_at = now() WHERE repo_id = '${REPO}' AND number = 12`)
    expect(await applyOn(attach(1, 13))).toMatchObject({ kind: "applied", receipt: { outcome: "issue_set", number: 1 } })
    expect(await issueOf(1)).toBe(13)
    expect(await leafOf(1)).toEqual([{ issue: 13, state: "queued", validation: "no_criteria" }])
  })

  test("a TODO the stack never had is not_found; the stack's order and lanes don't move", async () => {
    await issueRow(12)
    await applyOn(commit())
    const before = await loaded()
    expect(await applyOn(attach(9, 12))).toMatchObject({ kind: "applied", receipt: { outcome: "not_found" } })
    await applyOn(attach(1, 12))
    const after = await loaded()
    expect(after.todos.map(({ state, position, attempt }) => [state, position, attempt]))
      .toEqual(before.todos.map(({ state, position, attempt }) => [state, position, attempt]))
  })
})
