// `ops/RedactFeed` on the Node host's durable engine over the compose Postgres: only after its barrier, every phase,
// a role restored while a batch waits on its lock, the engine's retry of a failed batch, a resume by the next
// incarnation after a crash, and each alarm's start of each open barrier's pass.
import * as Cloudflare from "@alchemy.run/cloudflare"
import { TestSchemas } from "@smthrs/database"
import { Action, Interpreter } from "@smthrs/flow"
import { Effect, Exit, Fiber, Layer, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, onTestFinished, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as FeedLocks from "../FeedLocks.ts"
import * as Flows from "../Flows.vibe"
import * as RequestBackground from "../RequestBackground.ts"
import { incarnation, runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as RedactFeed from "./RedactFeed.ts"

const runtime = testFile("redact_feed")
const query = (text: string, ...params: ReadonlyArray<unknown>) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.orDie(sql.unsafe<Record<string, unknown>>(text, params)))
  )
const database = () => runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
  // A read that restores her Member role holds her feed lock, as `remember` does, and commits a moment later.
  const restoring = runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(Effect.gen(function*() {
        yield* FeedLocks.lock(sql, [{ repoId: "github/acme/widgets", personId: "restored" }])
        yield* sql`UPDATE github_repo_roles SET role = 'member', checked_at = now() WHERE person_id = 'restored'`
        yield* Effect.sleep(400)
      })))
  )
  await pause(100)
  const db = await database()
  const denied = await Effect.runPromise(
    RedactFeed.observedBatch({ ...RedactFeed.startOf("b3"), phase: "denied" }, db, 10)
  )
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

/** A starter that records each start, as `ExecutionHost` takes one: a start of a held execution is accepted. */
const accepting = () => {
  const started: Array<string> = []
  return {
    started,
    starter: Flows.FlowStarter.of({
      start: (_flow, { executionId }) => Effect.sync(() => void started.push(executionId))
    })
  }
}

test("a confirmed barrier is launched once by the first look, from however many isolates; a look a minute later starts nothing", async () => {
  await barrier("b6")
  await barrier("b7")
  await query(`UPDATE feed_barriers SET completed_at = now() WHERE id = 'b7'`)
  const db = await database()
  const { started, starter } = accepting()
  const registry: Metric.MetricRegistry = new Map()
  const count = (outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(RedactFeed.launches, { outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry)
      )
    ).count
  // Three isolates' first looks at once, as three requests in three isolates make them.
  await Promise.all([1, 2, 3].map(() =>
    Effect.runPromise(
      Effect.flatMap(RedactFeed.launcher, (look) => look).pipe(
        Effect.provideService(Flows.FlowStarter, starter),
        Effect.provide(db),
        Effect.provideService(Metric.MetricRegistry, registry)
      )
    )
  ))
  expect(started).toEqual([RedactFeed.executionIdOf("b6")])
  expect(count("launched")).toBe(1)
  // Later looks find it launched and moving: no start, so a host never wakes a pass that is running.
  await Effect.runPromise(RedactFeed.launch.pipe(Effect.provideService(Flows.FlowStarter, starter), Effect.provide(db)))
  expect(started).toHaveLength(1)
})

test("through ExecutionHost: the launched pass is held; a stalled one is woken, counted as woken, not launched", async () => {
  await barrier("b10")
  const db = await database()
  // The host's engine on a schema of its own, dropped afterwards.
  const url = (await runtime.runPromise(TestDatabase.serverUrl)).toString()
  const engineSchema = TestSchemas.schemaName("flows")
  onTestFinished(() => query(`DROP SCHEMA IF EXISTS "${engineSchema}" CASCADE`).then(() => undefined))
  const intents: Array<string> = []
  const object = new Map<string, unknown>()
  let alarm: number | null = null
  const host = ExecutionHost.make({
    get: <A>(key: string) => Effect.sync(() => structuredClone(object.get(key)) as A | undefined),
    put: (key, value) => Effect.sync(() => void object.set(key, structuredClone(value))),
    delete: (key) => Effect.sync(() => object.delete(key)),
    setAlarm: (at) => Effect.sync(() => void (alarm = at)),
    deleteAlarm: () => Effect.sync(() => void (alarm = null))
  }, {
    hostId: "redact-feed-object",
    database: ExecutionHost.database(url, engineSchema),
    flows: { flows: [RedactFeed.RedactFeed], registration: RedactFeed.registration(db) },
    router: { start: () => Effect.void, wake: () => Effect.void }
  })
  // The production starter: the execution's own object takes the intent, as Executions.starter hands it.
  const starter = Flows.FlowStarter.of({
    start: (flow, { executionId, payload }) =>
      ExecutionHost.intent(flow, { executionId, payload: payload as never }).pipe(
        Effect.flatMap((intent) => host.start(intent)),
        Effect.tap(() => Effect.sync(() => void intents.push(executionId))),
        Effect.orDie
      )
  })
  const registry: Metric.MetricRegistry = new Map()
  const count = (outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(RedactFeed.launches, { outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry)
      )
    ).count
  const look = () =>
    Effect.runPromise(RedactFeed.launch.pipe(
      Effect.provideService(Flows.FlowStarter, starter),
      Effect.provide(db),
      Effect.provideService(Metric.MetricRegistry, registry)
    ))
  await look()
  const armed = alarm
  expect(intents).toEqual([RedactFeed.executionIdOf("b10")])
  expect(armed).not.toBeNull()
  // Its object holds it, parked until its alarm drives it. Another look leaves it be.
  await look()
  expect(intents).toHaveLength(1)
  // No batch for longer than the stall: the next look wakes it, and the host takes the same intent again.
  await query(`UPDATE feed_barriers SET launched_at = now() - interval '1 hour' WHERE id = 'b10'`)
  await look()
  expect(intents).toEqual([RedactFeed.executionIdOf("b10"), RedactFeed.executionIdOf("b10")])
  expect([count("launched"), count("woken")]).toEqual([1, 1])
})

test("a stale pass whose last batch is old is woken once: the claim renews it, from however many isolates", async () => {
  await barrier("b11")
  // Launched and moved once, both long ago.
  await query(
    `UPDATE feed_barriers SET launched_at = now() - interval '2 hours', progressed_at = now() - interval '1 hour' WHERE id = 'b11'`
  )
  const db = await database()
  const { started, starter } = accepting()
  const look = () =>
    Effect.runPromise(RedactFeed.launch.pipe(Effect.provideService(Flows.FlowStarter, starter), Effect.provide(db)))
  await Promise.all([look(), look(), look()])
  expect(started).toEqual([RedactFeed.executionIdOf("b11")])
  // The claim renewed it though its last batch is still an hour old: the next looks leave it be.
  await look()
  await look()
  expect(started).toHaveLength(1)
})

test("a start that fails gives back only its own claim, never a newer claimant's", async () => {
  await barrier("b12")
  const db = await database()
  // While this start fails, another isolate claims the barrier after this claim went stale.
  const failing = Flows.FlowStarter.of({
    start: () =>
      Effect.andThen(
        Effect.promise(() =>
          query(
            `UPDATE feed_barriers SET launched_at = now() + interval '1 minute', launch_token = gen_random_uuid() WHERE id = 'b12'`
          )
        ),
        Effect.fail(new Flows.StartUnavailable({ errorCode: "unreachable" }))
      )
  })
  await Effect.runPromise(RedactFeed.launch.pipe(Effect.provideService(Flows.FlowStarter, failing), Effect.provide(db)))
  const [row] = await query(`SELECT launched_at > now() AS newer FROM feed_barriers WHERE id = 'b12'`)
  expect(row).toEqual({ newer: true })
  // Alone, a failed start gives its claim back, and the next look tries again.
  await barrier("b13")
  const plain = Flows.FlowStarter.of({
    start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "unreachable" }))
  })
  await Effect.runPromise(RedactFeed.launch.pipe(Effect.provideService(Flows.FlowStarter, plain), Effect.provide(db)))
  expect(await query(`SELECT launched_at, launch_token FROM feed_barriers WHERE id = 'b13'`)).toEqual([{
    launched_at: null,
    launch_token: null
  }])
})

test("the request path hands the look to the request's background: a host that never answers delays no request", async () => {
  await barrier("b14")
  const db = await database()
  const attempted: Array<string> = []
  const hung = Flows.FlowStarter.of({
    start: (_flow, { executionId }) => Effect.andThen(Effect.sync(() => void attempted.push(executionId)), Effect.never)
  })
  const background: Array<Promise<unknown>> = []
  // workerd's ctx.waitUntil, as the request's execution context offers it: the effect runs after the response.
  const context = Cloudflare.WorkerExecutionContext.of({
    waitUntil: (effect: Effect.Effect<unknown, unknown>) =>
      Effect.sync(() => void background.push(Effect.runPromise(effect)))
  } as never)
  const look = await Effect.runPromise(RedactFeed.launcher)
  const began = Date.now()
  await Effect.runPromise(
    RequestBackground.inBackground(
      look.pipe(Effect.provideService(Flows.FlowStarter, hung), Effect.provide(db), Effect.ignore)
    ).pipe(
      Effect.provideService(Cloudflare.WorkerExecutionContext, context)
    ) as Effect.Effect<void>
  )
  expect(Date.now() - began).toBeLessThan(200)
  // The look did run, behind the response, and is still waiting on the host.
  await expect.poll(() => attempted, { timeout: 5_000 }).toEqual([RedactFeed.executionIdOf("b14")])
  void background
})

test(
  "through ExecutionHost: a pass stalled after handing off to its next round's object is woken there, and finishes",
  async () => {
    await seed()
    await barrier("b20")
    const db = await database()
    const url = (await runtime.runPromise(TestDatabase.serverUrl)).toString()
    const engineSchema = TestSchemas.schemaName("flows")
    onTestFinished(() => query(`DROP SCHEMA IF EXISTS "${engineSchema}" CASCADE`).then(() => undefined))
    // One Durable Object per execution, as production names them, each with its own storage and alarm.
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
        // The remote host's router, as worker/Executions.ts composes it: a round's handoff starts its own object and is
        // recorded on the barrier.
        router: {
          start: RedactFeed.recordingHandoffs((intent) => objectFor(intent.executionId).host.start(intent), db),
          wake: (executionId) => Effect.asVoid(objectFor(executionId).host.wake())
        }
      })
      objects.set(executionId, object)
      return object
    }
    const woken: Array<string> = []
    const starter = Flows.FlowStarter.of({
      start: (flow, { executionId, payload }) =>
        ExecutionHost.intent(flow, { executionId, payload: payload as never }).pipe(
          Effect.flatMap((intent) => objectFor(executionId).host.start(intent)),
          Effect.tap(() => Effect.sync(() => void woken.push(executionId))),
          Effect.orDie
        ) as Effect.Effect<void>
    })
    const look = () =>
      Effect.runPromise(RedactFeed.launch.pipe(Effect.provideService(Flows.FlowStarter, starter), Effect.provide(db)))
    /** Fires every armed alarm once, but `skip`'s. */
    const fire = async (skip?: string) => {
      for (const [executionId, object] of [...objects]) {
        if (object.alarm === null || executionId === skip) continue
        await Effect.runPromise(object.host.alarm() as Effect.Effect<unknown>)
      }
    }

    await look()
    const first = RedactFeed.executionIdOf("b20")
    // The first round runs on its object and hands the next round to that round's own object.
    await fire()
    const [, successor] = [...objects.keys()]
    expect(successor).toBeDefined()
    expect(successor).not.toBe(first)
    expect(await query(`SELECT current_execution FROM feed_barriers WHERE id = 'b20'`)).toEqual([{
      current_execution: successor
    }])
    // That object never runs: an alarm lost. Long after, a claim finds the pass stalled.
    await query(
      `UPDATE feed_barriers SET launched_at = now() - interval '2 hours', progressed_at = now() - interval '1 hour' WHERE id = 'b20'`
    )
    await look()
    // It woke the round the pass is on, with that round's own intent, not the first round's finished object.
    expect(woken).toEqual([first, successor])
    for (let rounds = 0; rounds < 40; rounds++) {
      const [done] = await query(`SELECT completed_at IS NOT NULL AS done FROM feed_barriers WHERE id = 'b20'`)
      if (done!.done === true) break
      await fire()
    }
    expect(await query(`SELECT completed_at IS NOT NULL AS done FROM feed_barriers WHERE id = 'b20'`)).toEqual([{
      done: true
    }])
    expect(await shown()).toEqual(EXPECTED)
  },
  120_000
)

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
