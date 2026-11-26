// `ops/RedactFeed` on the Node host's durable engine over the compose Postgres: only after its barrier, every phase,
// a role restored while a batch waits on its lock, the engine's retry of a failed batch, a resume by the next
// incarnation after a crash, and the durable start: a confirmation starts the pass and its host finishes it with no
// unrelated request. Repeating the command recovers an interrupted start.
import { TestSchemas } from "@smthrs/database"
import { Action, Interpreter } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Exit, Fiber, Layer, Logger, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, onTestFinished, test } from "vitest"
import * as Command from "../../ops/feed-barrier/confirm.ts"
import { CONFIRM_ROUTE } from "../../ops/feed-barrier/Route.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as FeedLocks from "../FeedLocks.vibe"
import * as Flows from "../Flows.ts"
import { incarnation, runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as RedactFeed from "./RedactFeed.vibe"

const runtime = testFile("redact_feed")
const query = (text: string, ...params: ReadonlyArray<unknown>) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.orDie(sql.unsafe<Record<string, unknown>>(text, params)))
  )
const database = () => runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))

beforeEach(() => query(`TRUNCATE notifications, fleet_alerts, github_repo_roles, feed_barriers`))

/** Old rows of every phase: fleet titles, a push's message and pusher, a watcher's quoted question, a denied person's. */
const seed = async () => {
  await query(`INSERT INTO fleet_alerts (id, kind, repo_id, subject, title, href)
    SELECT 'a' || i, 'stalled', 'github/acme/widgets', 's' || i, 'T' || i || ' secret · Stalled', '/acme/widgets' FROM generate_series(1, 5) i`)
  await query(`INSERT INTO notifications (recipient, subject, kind, state, repo_id, title, href)
    SELECT 'p' || i, 'fleet:a' || i, 'fleet', 'update', 'github/acme/widgets', 'T' || i || ' secret · Stalled', '/acme/widgets'
    FROM generate_series(1, 5) i`)
  await query(`INSERT INTO notifications (recipient, subject, kind, state, repo_id, actor, title, ref, href) VALUES
    ('p1', 'main:github/acme/widgets', 'main', 'update', 'github/acme/widgets', 'dana', 'secret commit', 'abc', '/acme/widgets')`)
  await query(
    `INSERT INTO notifications (recipient, subject, kind, state, mine, quiet, run_id, title, actor, href) VALUES
    ('p2', 'run:${crypto.randomUUID()}', 'run', 'working', false, true, gen_random_uuid(), 'secret question', 'lena', '/app')`
  )
  await query(`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at) VALUES
    ('github/acme/widgets', 'p5', NULL, now()), ('github/acme/widgets', 'p4', NULL, '-infinity')`)
}

const EXPECTED = [
  { recipient: "p1", subject: "fleet:a1", title: "Agent run stalled · acme/widgets", actor: null },
  { recipient: "p1", subject: "main:github/acme/widgets", title: "acme/widgets", actor: null },
  { recipient: "p2", subject: "fleet:a2", title: "Agent run stalled · acme/widgets", actor: null },
  { recipient: "p2", subject: expect.stringMatching(/^run:/), title: "Agent run", actor: null },
  { recipient: "p3", subject: "fleet:a3", title: "Agent run stalled · acme/widgets", actor: null },
  // p4's read never heard from GitHub: no denial, the row stays. p5 was denied: theirs goes.
  { recipient: "p4", subject: "fleet:a4", title: "Agent run stalled · acme/widgets", actor: null }
]

const feed = async () => (await query(
  `SELECT recipient, subject, title, actor, updated_at FROM notifications ORDER BY recipient, subject`
))
const shown = async () =>
  (await feed()).map(({ recipient, subject, title, actor }) => ({ recipient, subject, title, actor }))
const barrier = (id: string) =>
  query(`INSERT INTO feed_barriers (id, release, confirmed_by) VALUES ($1, 'abc123', 'test')`, id)

test(
  "without its barrier the pass touches nothing; with it, every phase, to done, recorded; a second pass changes nothing",
  async () => {
    await seed()
    const db = await database()
    const before = await feed()
    const refused = await runFlow(RedactFeed.RedactFeed, RedactFeed.startOf("b1"), RedactFeed.registration(db, 2))
    expect(Exit.isSuccess(refused.exit) && refused.exit.value).toMatchObject({ outcome: "no_barrier" })
    expect(await feed()).toEqual(before)

    await barrier("b1")
    const ran = await runFlow(RedactFeed.RedactFeed, RedactFeed.startOf("b1"), RedactFeed.registration(db, 2), {
      executionId: RedactFeed.executionIdOf("b1")
    })
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toMatchObject({ phase: "denied", outcome: "done" })
    expect(await shown()).toEqual(EXPECTED)
    expect(await query(`SELECT completed_at IS NOT NULL AS done FROM feed_barriers WHERE id = 'b1'`)).toEqual([{
      done: true
    }])

    const after = await feed()
    await barrier("b2")
    await runFlow(RedactFeed.RedactFeed, RedactFeed.startOf("b2"), RedactFeed.registration(db, 2))
    expect(await feed()).toEqual(after)
  },
  60_000
)

test("a role restored while the denied batch waits on its lock keeps the person's rows", async () => {
  await query(`INSERT INTO notifications (recipient, subject, kind, state, repo_id, title, href) VALUES
    ('restored', 'main:github/acme/widgets', 'main', 'update', 'github/acme/widgets', 'acme/widgets', '/acme/widgets')`)
  await query(
    `INSERT INTO github_repo_roles (repo_id, person_id, role) VALUES ('github/acme/widgets', 'restored', NULL)`
  )
  await barrier("b3")
  // A read that restores her Member role holds her feed lock, as `remember` does, and commits once the batch waits.
  let onLocked!: () => void
  const locked = new Promise<void>((resolve) => { onLocked = resolve })
  let commit!: () => void
  const waited = new Promise<void>((resolve) => { commit = resolve })
  const restoring = runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(Effect.gen(function*() {
        yield* FeedLocks.lock(sql, [{ repoId: "github/acme/widgets", personId: "restored" }])
        yield* sql`UPDATE github_repo_roles SET role = 'member', checked_at = now() WHERE person_id = 'restored'`
        onLocked()
        yield* Effect.promise(() => waited)
      })))
  )
  await Promise.race([locked, restoring])
  const db = await database()
  const batching = Effect.runPromise(
    RedactFeed.observedBatch({ ...RedactFeed.startOf("b3"), phase: "denied" }, db, 10)
  )
  // The batch is queued behind her lock before the read commits.
  await expect.poll(
    async () =>
      ((await query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`))[0]!
        .n as number) > 0,
    { timeout: 20_000 }
  ).toBe(true)
  commit()
  const denied = await batching
  await restoring
  expect(denied).toMatchObject({ phase: "denied", recipient: "restored" })
  expect(await query(`SELECT recipient FROM notifications`)).toEqual([{ recipient: "restored" }])
})

/** The pass's registration over `db`, two rows a batch, its step wrapped by `around`. */
const wrapped = (
  db: Awaited<ReturnType<typeof database>>,
  around: (
    round: RedactFeed.Round,
    step: Effect.Effect<RedactFeed.Round, RedactFeed.RedactUnavailable>
  ) => Effect.Effect<RedactFeed.Round, RedactFeed.RedactUnavailable>
) =>
  Interpreter.layerWithImplementations(
    RedactFeed.RedactFeed,
    RedactFeed.Batch.toLayer((round) => around(round, RedactFeed.observedBatch(round, db, 2)))
  ).pipe(Layer.provideMerge(Action.layerImplementations))

test(
  "a batch that fails is retried by the engine from the same round, and the pass ends as one that never failed",
  async () => {
    await seed()
    await barrier("b4")
    const db = await database()
    let calls = 0
    const registration = wrapped(
      db,
      (_round, step) =>
        Effect.suspend(() =>
          (calls += 1) === 3 ? Effect.fail(new RedactFeed.RedactUnavailable({ reason: "database" })) : step
        )
    )
    const ran = await runFlow(RedactFeed.RedactFeed, RedactFeed.startOf("b4"), registration, {
      executionId: RedactFeed.executionIdOf("b4")
    })
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toMatchObject({ outcome: "done" })
    expect(await shown()).toEqual(EXPECTED)
  },
  60_000
)

test("a failed SQL batch reports a database error and can retry the same rows", async () => {
  await seed()
  const round = RedactFeed.startOf("retry-batch")
  await barrier(round.barrier)
  const db = await database()
  const before = await feed()
  const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const logger = Logger.make((options) => void logs.push(StructuredLogger.formatStructured.log(options)))
  const batch = RedactFeed.observedBatch(round, db, 2).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
  )
  await query(`CREATE FUNCTION reject_batch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test-only SQL error details'; END $$`)
  await query(`CREATE TRIGGER reject_batch BEFORE UPDATE OF title ON notifications
    FOR EACH ROW EXECUTE FUNCTION reject_batch()`)
  try {
    expect(await Effect.runPromise(Effect.flip(batch))).toEqual(new RedactFeed.RedactUnavailable({ reason: "database" }))
    expect(await feed()).toEqual(before)
    expect(await query("SELECT progressed_at FROM feed_barriers WHERE id = $1", round.barrier))
      .toEqual([{ progressed_at: null }])
    expect(logs.map((log) => log.annotations)).toEqual([
      expect.objectContaining({ barrier: round.barrier, phase: "fleet", errorCode: expect.stringMatching(/^sql:/) }),
    ])
    expect(JSON.stringify(logs)).not.toContain("test-only SQL error details")
  } finally {
    await query("DROP TRIGGER reject_batch ON notifications")
    await query("DROP FUNCTION reject_batch()")
  }
  expect(await Effect.runPromise(batch)).toMatchObject({ phase: "fleet", recipient: "p2", subject: "fleet:a2" })
  expect(await query("SELECT progressed_at IS NOT NULL AS progressed FROM feed_barriers WHERE id = $1", round.barrier))
    .toEqual([{ progressed: true }])
})

test(
  "a pass whose incarnation crashed mid-way is resumed by the next from its journal, redoing no committed batch",
  async () => {
    await seed()
    await barrier("b5")
    const db = await database()
    const seen: Array<string> = []
    let stall: (() => void) | undefined
    const stalled = new Promise<void>((resolve) => (stall = resolve))
    // The first incarnation stops answering at its third round, as an alarm cut off mid-step.
    const first = await incarnation(wrapped(db, (round, step) =>
      Effect.suspend(() => {
        seen.push(`${round.phase}:${round.recipient}`)
        return seen.length === 3 ? Effect.andThen(Effect.sync(() => stall!()), Effect.never) : step
      })))
    const running = Effect.runFork(
      first.execute(RedactFeed.RedactFeed, RedactFeed.executionIdOf("b5"), RedactFeed.startOf("b5"))
    )
    await stalled
    const committed = await query(
      `SELECT recipient FROM notifications WHERE kind = 'fleet' AND title NOT LIKE '%secret%' ORDER BY recipient`
    )
    // Two batches of two rows committed before it was cut off.
    expect(committed.map((row) => row.recipient)).toEqual(["p1", "p2", "p3", "p4"])
    await first.crash()

    const resumedRounds: Array<string> = []
    const second = await incarnation(
      wrapped(db, (round, step) =>
        Effect.andThen(
          Effect.sync(() => void resumedRounds.push(`${round.phase}:${round.recipient}`)),
          step
        )),
      first.engine.schema
    )
    const resumed = await Effect.runPromise(
      second.execute(RedactFeed.RedactFeed, RedactFeed.executionIdOf("b5"), RedactFeed.startOf("b5"))
    )
    await Effect.runPromise(Fiber.interrupt(running))
    await second.close()
    await first.close()

    expect(Exit.isSuccess(resumed) && resumed.value).toMatchObject({ outcome: "done" })
    // It starts again at the round that never finished, never at the beginning.
    expect(resumedRounds[0]).toBe("fleet:p4")
    expect(await shown()).toEqual(EXPECTED)
  },
  120_000
)

/** A pass that runs every round's real step, but stops answering right after round `cutAt` committed. */
const cutAfterCommit = async (db: Awaited<ReturnType<typeof database>>, cutAt: number) => {
  const seen: Array<string> = []
  let stall: (() => void) | undefined
  const stalled = new Promise<void>((resolve) => (stall = resolve))
  const first = await incarnation(wrapped(db, (round, step) =>
    Effect.suspend(() => {
      seen.push(`${round.phase}:${round.recipient}`)
      // The round's change commits; its receipt never reaches the journal.
      return seen.length === cutAt
        ? Effect.andThen(step, Effect.andThen(Effect.sync(() => stall!()), Effect.never))
        : step
    })))
  return { first, seen, stalled }
}

test(
  "a round whose change committed but whose receipt was lost is run again by the next incarnation, to the same end",
  async () => {
    await seed()
    await barrier("b8")
    const db = await database()
    const { first, seen, stalled } = await cutAfterCommit(db, 2)
    const running = Effect.runFork(
      first.execute(RedactFeed.RedactFeed, RedactFeed.executionIdOf("b8"), RedactFeed.startOf("b8"))
    )
    await stalled
    // Round 2's rows committed: four fleet rows rewritten.
    expect(
      (await query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'fleet' AND title NOT LIKE '%secret%'`))[
        0
      ]
    )
      .toEqual({ n: 4 })
    await first.crash()
    const again: Array<string> = []
    const second = await incarnation(
      wrapped(
        db,
        (round, step) => Effect.andThen(Effect.sync(() => void again.push(`${round.phase}:${round.recipient}`)), step)
      ),
      first.engine.schema
    )
    const resumed = await Effect.runPromise(
      second.execute(RedactFeed.RedactFeed, RedactFeed.executionIdOf("b8"), RedactFeed.startOf("b8"))
    )
    await Effect.runPromise(Fiber.interrupt(running))
    await second.close()
    await first.close()
    // Round 2 runs again, finds its rows already in line, and the pass goes on to the same end.
    expect(again[0]).toBe(seen[1])
    expect(Exit.isSuccess(resumed) && resumed.value).toMatchObject({ outcome: "done" })
    expect(await shown()).toEqual(EXPECTED)
  },
  120_000
)

test("a last round whose completion committed but whose receipt was lost ends the same when run again", async () => {
  await barrier("b9")
  const db = await database()
  // No rows: rounds 1 to 3 move on from a phase each, the fourth records completion and is cut off.
  const { first, stalled } = await cutAfterCommit(db, 4)
  const running = Effect.runFork(
    first.execute(RedactFeed.RedactFeed, RedactFeed.executionIdOf("b9"), RedactFeed.startOf("b9"))
  )
  await stalled
  const [completed] = await query(`SELECT completed_at FROM feed_barriers WHERE id = 'b9'`)
  expect(completed!.completed_at).not.toBeNull()
  await first.crash()
  const second = await incarnation(wrapped(db, (_round, step) => step), first.engine.schema)
  const resumed = await Effect.runPromise(
    second.execute(RedactFeed.RedactFeed, RedactFeed.executionIdOf("b9"), RedactFeed.startOf("b9"))
  )
  await Effect.runPromise(Fiber.interrupt(running))
  await second.close()
  await first.close()
  expect(Exit.isSuccess(resumed) && resumed.value).toMatchObject({ outcome: "done" })
  // The completion stands as first recorded.
  expect(await query(`SELECT completed_at FROM feed_barriers WHERE id = 'b9'`)).toEqual([completed])
}, 120_000)

/**
 * Production's execution hosts over the compose Postgres: one Durable Object per execution, each with its own storage
 * and alarm, the router worker/Executions.ts composes, and the starter Executions.starter hands ChatApi. `fire` is the
 * platform firing every armed alarm once; nothing else drives a pass.
 */
const hosts = async (db: Awaited<ReturnType<typeof database>>) => {
  const url = (await runtime.runPromise(TestDatabase.serverUrl)).toString()
  const engineSchema = TestSchemas.schemaName("flows")
  onTestFinished(() => query(`DROP SCHEMA IF EXISTS "${engineSchema}" CASCADE`).then(() => undefined))
  const objects = new Map<string, { readonly host: ReturnType<typeof ExecutionHost.make>; alarm: number | null }>()
  const objectFor = (executionId: string) => {
    const existing = objects.get(executionId)
    if (existing !== undefined) return existing
    const values = new Map<string, unknown>()
    const object: { host: ReturnType<typeof ExecutionHost.make>; alarm: number | null } = {
      host: undefined as never,
      alarm: null
    }
    object.host = ExecutionHost.make({
      get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
      put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
      delete: (key) => Effect.sync(() => values.delete(key)),
      setAlarm: (at) => Effect.sync(() => void (object.alarm = at)),
      deleteAlarm: () => Effect.sync(() => void (object.alarm = null))
    }, {
      hostId: `object-${executionId}`,
      database: ExecutionHost.database(url, engineSchema),
      flows: { flows: [RedactFeed.RedactFeed], registration: RedactFeed.registration(db, 2) },
      router: {
        start: RedactFeed.recordingHandoffs((intent) => objectFor(intent.executionId).host.start(intent), db),
        wake: (executionId) => Effect.asVoid(objectFor(executionId).host.wake())
      }
    })
    objects.set(executionId, object)
    return object
  }
  const starts: Array<string> = []
  const starter = Flows.FlowStarter.of({
    start: (flow, { executionId, payload }) =>
      ExecutionHost.intent(flow, { executionId, payload: payload as never }).pipe(
        Effect.flatMap((intent) => objectFor(executionId).host.start(intent)),
        Effect.tap(() => Effect.sync(() => void starts.push(executionId))),
        Effect.orDie
      ) as Effect.Effect<void>
  })
  const registry: Metric.MetricRegistry = new Map()
  const count = (outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(RedactFeed.launches, { outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry)
      )
    ).count
  const run = <A, E>(
    effect: Effect.Effect<A, E, SqlClient.SqlClient | Flows.FlowStarter>,
    using: typeof starter = starter
  ) =>
    Effect.runPromiseExit(effect.pipe(
      Effect.provideService(Flows.FlowStarter, using),
      Effect.provide(db),
      Effect.provideService(Metric.MetricRegistry, registry)
    ))
  const fire = async () => {
    for (const object of [...objects.values()]) {
      if (object.alarm !== null) await Effect.runPromise(object.host.alarm() as Effect.Effect<unknown>)
    }
  }
  const completed = async (id: string) =>
    (await query(`SELECT completed_at IS NOT NULL AS done FROM feed_barriers WHERE id = $1`, id))[0]!.done === true
  /** The hosts' own alarms, and nothing else, until barrier `id`'s pass records its end. */
  const drive = async (id: string) => {
    for (let rounds = 0; rounds < 40 && !(await completed(id)); rounds++) await fire()
    return completed(id)
  }
  return { starts, starter, count, run, drive, objects }
}

/** The command's actual argument parsing, database connection and HTTP request targeting the production handler. */
const commandFor = async (host: Awaited<ReturnType<typeof hosts>>, id: string) => {
  const url = await runtime.runPromise(TestDatabase.serverUrl)
  const schema = await runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.name))
  url.searchParams.set("options", `-c search_path=${schema}`)
  return async (using = host.starter, loseResponse = false) => {
    const output: string[] = []
    const code = await Command.run(["--by", "test", "--id", id, "--release", "abc123"],
      { APP_DOMAIN: "app.example", DATABASE_URL: url.toString() },
      { out: (line) => output.push(line), err: (line) => output.push(line) },
      async (input, init) => {
        const request = new Request(input, init)
        expect(new URL(request.url).pathname).toBe(CONFIRM_ROUTE + id)
        const result = await host.run(RedactFeed.confirm(request.method, new URL(request.url).pathname,
          request.headers.get("authorization") ?? undefined), using)
        if (loseResponse) throw new Error("lost acknowledgement")
        return new Response(null, { status: Exit.isSuccess(result) ? result.value : 503 })
      })
    return { code, output }
  }
}

test("the production confirmation command starts one pass and its own host alarms finish it", async () => {
  await seed()
  const host = await hosts(await database())
  const command = await commandFor(host, "b20")
  const first = await command()
  expect(first.code).toBe(0)
  expect(JSON.parse(first.output[0]!)).toMatchObject({ outcome: "written", id: "b20", confirmedBy: "test" })
  expect(host.starts).toEqual([RedactFeed.executionIdOf("b20")])
  expect(await host.drive("b20")).toBe(true)
  expect(await shown()).toEqual(EXPECTED)
  const repeated = await command()
  expect(repeated.code).toBe(0)
  expect(JSON.parse(repeated.output[0]!)).toMatchObject({ outcome: "existing", id: "b20" })
  expect(host.starts).toEqual([RedactFeed.executionIdOf("b20")])
}, 120_000)

test("only the confirmed barrier can start and retrying the command recovers a failed start or lost response", async () => {
  await seed()
  const host = await hosts(await database())
  const command = await commandFor(host, "b21")
  const unreachable = Flows.FlowStarter.of({
    start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "unreachable" }))
  })
  expect((await command(unreachable)).code).toBe(1)
  expect(host.count("not_started")).toBe(1)
  const [open] = await query(`SELECT launch_token, launched_at FROM feed_barriers WHERE id = 'b21'`)
  expect(open!.launched_at).toBeNull()
  const token = `Bearer ${String(open!.launch_token)}`
  for (const [method, id, credential, expected] of [
    ["GET", "b21", token, 405], ["POST", "b21", undefined, 403], ["POST", "b21", `Bearer ${crypto.randomUUID()}`, 403],
    ["POST", "another-barrier", token, 403], ["POST", "../b21", token, 403],
  ] as const) {
    const refused = await host.run(RedactFeed.confirm(method, CONFIRM_ROUTE + id, credential))
    expect(Exit.isSuccess(refused) && refused.value).toBe(expected)
  }
  const wrongPath = await host.run(RedactFeed.confirm("POST", "/other/" + CONFIRM_ROUTE + "b21", token))
  expect(wrongPath).toEqual(Exit.succeed(403))
  expect(host.starts).toEqual([])
  expect((await command(host.starter, true)).code).toBe(1)
  expect(host.starts).toEqual([RedactFeed.executionIdOf("b21")])
  expect((await command()).code).toBe(0)
  const alreadyHeld = await host.run(RedactFeed.confirm("POST", CONFIRM_ROUTE + "b21", token))
  expect(alreadyHeld).toEqual(Exit.succeed(204))
  expect(host.starts).toEqual([RedactFeed.executionIdOf("b21")])
  expect(await host.drive("b21")).toBe(true)
  expect(await shown()).toEqual(EXPECTED)
}, 120_000)

test("retry after the host accepted the start but its database receipt failed reuses the same execution", async () => {
  const host = await hosts(await database())
  const command = await commandFor(host, "b22")
  await query(`CREATE FUNCTION refuse_launch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'launch receipt unavailable'; END $$`)
  await query(`CREATE TRIGGER refuse_launch BEFORE UPDATE OF launched_at ON feed_barriers
    FOR EACH ROW EXECUTE FUNCTION refuse_launch()`)
  try {
    expect((await command()).code).toBe(1)
    expect(await query("SELECT launched_at FROM feed_barriers WHERE id = 'b22'")).toEqual([{ launched_at: null }])
  } finally {
    await query("DROP TRIGGER refuse_launch ON feed_barriers")
    await query("DROP FUNCTION refuse_launch()")
  }
  expect((await command()).code).toBe(0)
  const id = RedactFeed.executionIdOf("b22")
  expect(host.starts).toEqual([id, id])
  expect([...host.objects.keys()]).toEqual([id])
  expect(await host.drive("b22")).toBe(true)
}, 120_000)

test("a handoff requires a valid redaction round and cannot replace a completed barrier's receipt", async () => {
  const id = "receipt"
  await barrier(id)
  const round = RedactFeed.startOf(id)
  const intent = { flow: RedactFeed.RedactFeed._tag, executionId: "next-round", payload: round }
  const receipt = () => query("SELECT current_execution, current_round FROM feed_barriers WHERE id = $1", id)
  await runtime.runPromise(RedactFeed.recordHandoff({ ...intent, flow: "ops/Other" }))
  await runtime.runPromise(RedactFeed.recordHandoff({ ...intent, payload: { ...round, phase: "unknown" } }))
  expect(await receipt()).toEqual([{ current_execution: null, current_round: null }])

  await runtime.runPromise(RedactFeed.recordHandoff(intent))
  expect(await receipt()).toEqual([{ current_execution: intent.executionId, current_round: round }])
  await query("UPDATE feed_barriers SET completed_at = now() WHERE id = $1", id)
  await runtime.runPromise(RedactFeed.recordHandoff({
    ...intent, executionId: "late-round", payload: { ...round, phase: "denied" },
  }))
  expect(await receipt()).toEqual([{ current_execution: intent.executionId, current_round: round }])
})

test("a failed successor receipt keeps the predecessor retryable before it settles", async () => {
  await barrier("handoff-fault")
  const db = await database()
  const url = (await runtime.runPromise(TestDatabase.serverUrl)).toString()
  const engineSchema = TestSchemas.schemaName("flows")
  onTestFinished(() => query(`DROP SCHEMA IF EXISTS "${engineSchema}" CASCADE`).then(() => undefined))
  await query(`CREATE FUNCTION refuse_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'handoff receipt unavailable'; END $$`)
  await query(`CREATE TRIGGER refuse_handoff BEFORE UPDATE OF current_execution ON feed_barriers
    FOR EACH ROW EXECUTE FUNCTION refuse_handoff()`)
  onTestFinished(async () => {
    await query(`DROP TRIGGER IF EXISTS refuse_handoff ON feed_barriers`)
    await query(`DROP FUNCTION IF EXISTS refuse_handoff()`)
  })
  type ObjectHost = ReturnType<typeof ExecutionHost.make<never, never, never, unknown, never, unknown, never>>
  const objects = new Map<string, ObjectHost>()
  const settled: Array<string> = []
  const starts: Array<string> = []
  const objectFor = (id: string): ObjectHost => {
    const existing = objects.get(id)
    if (existing) return existing
    const values = new Map<string, unknown>()
    const host = ExecutionHost.make({
      get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
      put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
      delete: (key) => Effect.sync(() => values.delete(key)),
      setAlarm: () => Effect.void,
      deleteAlarm: () => Effect.void
    }, {
      hostId: `handoff-${id}`,
      database: ExecutionHost.database(url, engineSchema),
      flows: { flows: [RedactFeed.RedactFeed], registration: RedactFeed.registration(db, 2) },
      router: {
        start: RedactFeed.recordingHandoffs((intent) =>
          objectFor(intent.executionId).start(intent).pipe(
            Effect.tap(() => Effect.sync(() => void starts.push(intent.executionId)))
          ), db),
        wake: (executionId) => Effect.asVoid(objectFor(executionId).wake())
      },
      settled: (executionId) => Effect.sync(() => void settled.push(executionId))
    })
    objects.set(id, host)
    return host
  }
  const first = RedactFeed.executionIdOf("handoff-fault")
  const predecessor = objectFor(first)
  await Effect.runPromise(
    ExecutionHost.intent(RedactFeed.RedactFeed, {
      executionId: first,
      payload: RedactFeed.startOf("handoff-fault")
    }).pipe(Effect.flatMap(predecessor.start))
  )
  expect(await Effect.runPromise(predecessor.alarm())).toMatchObject({ _tag: "Retrying" })
  expect(settled).toEqual([])
  expect(starts).toHaveLength(1)
  const successor = starts[0]!
  expect(await query(`SELECT current_execution FROM feed_barriers WHERE id = 'handoff-fault'`)).toEqual([{
    current_execution: null
  }])
  // Repair the dependency, then fire the durable alarm directly; no wall-clock wait.
  await query(`DROP TRIGGER refuse_handoff ON feed_barriers`)
  expect(await Effect.runPromise(predecessor.alarm())).toMatchObject({ _tag: "Settled" })
  expect(starts).toEqual([successor, successor])
  expect(await query(`SELECT current_execution FROM feed_barriers WHERE id = 'handoff-fault'`)).toEqual([{
    current_execution: successor
  }])
  expect(settled).toEqual([first])
})
