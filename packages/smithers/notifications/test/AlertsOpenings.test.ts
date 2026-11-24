/**
 * What tells one alert from another, and what an alert operation refuses,
 * over a real journal on the test clock.
 *
 * A condition that clears and re-opens inside one millisecond is two alerts,
 * a record written before ids carried the opening's journal sequence still
 * counts, a page the sink refused for good is not sent again, and an id the
 * journal cannot store is a typed refusal instead of a defect.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Alerts from "../src/Alerts.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const runId = "lane-site"
const hour = 3_600_000

const policy: Alerts.Policy = Alerts.probes({ deploy: { afterMs: 0, severity: "critical" } })
const repeating: Alerts.Policy = Alerts.probes({ deploy: { afterMs: 0, repeatMs: hour, severity: "critical" } })

const key = Alerts.coalescingKey(runId, "deploy")
/** The id a page carried before ids held the opening's journal sequence. */
const legacyId = (since: number) => Alerts.alertId({ coalescingKey: key, since })
const deployId = (since: number, opening: number) => Alerts.alertId({ coalescingKey: key, since, opening })

/** A sink that keeps the id of every page it was handed. */
const keeping = () => {
  const sent: Array<string> = []
  return {
    sent,
    layer: Layer.succeed(Alerts.Sink)({ deliver: (alert) => Effect.sync(() => void sent.push(Alerts.alertId(alert))) })
  }
}

/** A sink that refuses every page with `error`, and counts how often it was asked. */
const refusing = (error: () => Alerts.AlertError) => {
  const asked: Array<string> = []
  return {
    asked,
    layer: Layer.succeed(Alerts.Sink)({
      deliver: (alert) =>
        Effect.suspend(() => {
          asked.push(Alerts.alertId(alert))
          return Effect.fail(error())
        })
    })
  }
}

type Services = Alerts.AlertRuntime | Journal.Journal | NotificationQueue.NotificationQueue

/** The storage one test's runtimes share. */
const storage = Layer.mergeAll(NotificationQueue.layer).pipe(
  Layer.provideMerge(TestJournal.layer()),
  Layer.provideMerge(TestClock.layer())
)

/** A new alert runtime over the storage in context, as a second process would build. */
const runtime = (sink: Layer.Layer<Alerts.Sink>, rules: Alerts.Policy = policy) =>
  Alerts.layer(rules).pipe(Layer.provide(sink))

const run = <A>(
  sink: Layer.Layer<Alerts.Sink>,
  program: Effect.Effect<A, unknown, Services>,
  rules: Alerts.Policy = policy
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(runtime(sink, rules).pipe(Layer.provideMerge(storage))),
      Effect.scoped,
      Effect.orDie
    )
  )

const alerts = Alerts.AlertRuntime
const tick = Effect.flatMap(alerts, (service) => service.tick(runId))
const standing = Effect.flatMap(alerts, (service) => service.standing(runId))
const acknowledge = (id: string, by: string) => Effect.flatMap(alerts, (service) => service.acknowledge(runId, id, by))
const report = (state: "failing" | "ok") => Alerts.report({ runId, probe: "deploy", state })
const states = (list: ReadonlyArray<Alerts.Standing>) =>
  list.map((item) => [item.alertId, item.state, item.acknowledgedBy])

/** Journals a record under the alerter's own source, as an earlier version of this package wrote it. */
const recorded = (eventType: string, id: string, outcome: string, payload: Record<string, unknown>) =>
  Effect.flatMap(Journal.Journal, (journal) =>
    journal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        sourceId: JournalEvent.SourceId.make(`/notifications/alerts/${id}/${outcome}`),
        sourceSeq: JournalEvent.SourceSeq.make(0),
        dedupe: "identity",
        eventType,
        payload: { runId, alertId: id, ...payload }
      })
    ))

const failures = Effect.flatMap(Journal.Journal, (journal) =>
  Effect.map(
    journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 }),
    (page) => page.entries.filter((entry) => entry.eventType === Alerts.failedEventType).map((entry) => entry.payload)
  ))

describe("two openings of one condition in one millisecond", () => {
  it("are two alerts: each is paged, and acknowledging the first leaves the second open", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        // The clock never moves, so every entry below carries the same time.
        yield* report("failing")
        const first = yield* tick
        const taken = yield* acknowledge(deployId(0, 0), "will")
        yield* report("ok")
        yield* report("failing")
        const second = yield* tick
        const now = yield* standing
        // The acknowledged alert is gone, so its id names nothing open.
        const stale = yield* acknowledge(deployId(0, 0), "ana")
        const replayed = yield* Effect.all({ tick, standing }).pipe(Effect.provide(runtime(sink.layer)))
        return { first, taken, second, now, stale, replayed }
      })
    )

    // Entry 0 is the first report, 1 and 2 its admission and delivery record,
    // 3 the acknowledgement, 4 the ok report, and 5 the report that re-opened.
    const [firstId, secondId] = [deployId(0, 0), deployId(0, 5)]
    expect(observed.first.delivered.map(Alerts.alertId)).toEqual([firstId])
    expect(observed.taken).toBe(true)
    // A receiver that dedupes on the id would drop a second page under the first one's id.
    expect(observed.second.delivered.map(Alerts.alertId)).toEqual([secondId])
    expect(sink.sent).toEqual([firstId, secondId])
    expect(states(observed.now)).toEqual([[secondId, "delivered", undefined]])
    expect(observed.stale).toBe(false)
    // A process that folds the whole journal again reads the same two alerts.
    expect(observed.replayed.tick.suppressed.map(Alerts.alertId)).toEqual([secondId])
    expect(states(observed.replayed.standing)).toEqual([[secondId, "delivered", undefined]])
  })

  it("carries the opening on the alert, the page, the inbox entry and the records", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* report("failing")
        const ticked = yield* tick
        const queue = yield* NotificationQueue.NotificationQueue
        const journal = yield* Journal.Journal
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 8 })
        return {
          ticked,
          pending: yield* queue.pending(runId),
          delivered: page.entries.filter((entry) => entry.eventType === Alerts.deliveredEventType)
        }
      })
    )

    expect(observed.ticked.delivered.map((alert) => alert.opening)).toEqual([0])
    expect(observed.pending.map((notification) => notification.id)).toEqual([deployId(0, 0)])
    expect(observed.delivered.map((entry) => [entry.sourceId, entry.payload])).toEqual([[
      `/notifications/alerts/${deployId(0, 0)}/delivered`,
      { runId, condition: "deploy", since: 0, severity: "critical", alertId: deployId(0, 0), opening: 0 }
    ]])
  })
})

describe("a record written before ids carried the opening", () => {
  it("still counts as this opening's delivery, and not as a later opening's", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* report("failing")
        // What an earlier version journaled after it paged about this opening.
        yield* recorded(Alerts.deliveredEventType, legacyId(0), "delivered", {
          condition: "deploy",
          since: 0,
          severity: "critical"
        })
        const upgraded = yield* tick
        const listed = yield* standing
        yield* report("ok")
        yield* report("failing")
        const reopened = yield* tick
        return { upgraded, listed, reopened }
      })
    )

    // The page went out before the upgrade; the upgrade does not send it again.
    expect(observed.upgraded.suppressed.map(Alerts.alertId)).toEqual([deployId(0, 0)])
    expect(observed.upgraded.delivered).toEqual([])
    expect(states(observed.listed)).toEqual([[deployId(0, 0), "delivered", undefined]])
    // The old record named a time, and the condition re-opened at that same
    // time. It was written about the earlier opening, so this one is paged.
    expect(observed.reopened.delivered.map(Alerts.alertId)).toEqual([deployId(0, 3)])
    expect(sink.sent).toEqual([deployId(0, 3)])
  })

  it("counts an old repeat's delivery and an old acknowledgement for the opening they were written under", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* report("failing")
        yield* TestClock.adjust("1 hour")
        yield* recorded(Alerts.deliveredEventType, `${legacyId(0)}:r1`, "delivered", {
          condition: "deploy",
          since: 0,
          severity: "critical",
          reminder: 1
        })
        const repeated = yield* tick
        const paged = yield* standing
        yield* recorded(Alerts.acknowledgedEventType, legacyId(0), "acknowledged", { by: "will" })
        return { repeated, paged, taken: yield* Effect.provide(standing, runtime(sink.layer, repeating)) }
      }),
      repeating
    )

    expect(observed.repeated.suppressed.map(Alerts.alertId)).toEqual([`${deployId(0, 0)}:r1`])
    expect(states(observed.paged)).toEqual([[deployId(0, 0), "delivered", undefined]])
    expect(states(observed.taken)).toEqual([[deployId(0, 0), "acknowledged", "will"]])
    expect(sink.sent).toEqual([])
  })

  it("lets a person acknowledge by the id an old page printed", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* report("failing")
        yield* tick
        const taken = yield* acknowledge(legacyId(0), "will")
        yield* TestClock.adjust("1 hour")
        return { taken, here: yield* standing, replayed: yield* Effect.provide(standing, runtime(sink.layer)) }
      })
    )

    expect(observed.taken).toBe(true)
    expect(states(observed.here)).toEqual([[deployId(0, 0), "acknowledged", "will"]])
    expect(states(observed.replayed)).toEqual([[deployId(0, 0), "acknowledged", "will"]])
  })
})

describe("a page the sink will not take", () => {
  it("is sent once when the sink refuses it for good, in this process and the next", async () => {
    const sink = refusing(() => new Alerts.AlertError({ message: "key revoked", status: 401, retryable: false }))
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* report("failing")
        const first = yield* tick
        const second = yield* tick
        const third = yield* tick
        const restarted = yield* Effect.provide(tick, runtime(sink.layer))
        return { ticks: [first, second, third, restarted], listed: yield* standing, failures: yield* failures }
      })
    )

    expect(sink.asked).toEqual([deployId(0, 0)])
    // Every tick still reports the page as one that did not go out.
    expect(observed.ticks.map((result) => result.failed.map(Alerts.alertId))).toEqual(
      Array.from({ length: 4 }, () => [deployId(0, 0)])
    )
    expect(states(observed.listed)).toEqual([[deployId(0, 0), "raised", undefined]])
    expect(observed.failures).toEqual([{
      runId,
      condition: "deploy",
      since: 0,
      severity: "critical",
      alertId: deployId(0, 0),
      opening: 0,
      code: "sink_rejected",
      status: 401,
      retryable: false
    }])
  })

  it("tries a repeat of the page, and a re-opened condition, once each", async () => {
    const sink = refusing(() => new Alerts.AlertError({ message: "key revoked", retryable: false }))
    await run(
      sink.layer,
      Effect.gen(function*() {
        yield* report("failing")
        yield* tick
        yield* tick
        yield* TestClock.adjust("1 hour")
        yield* tick
        yield* tick
        yield* report("ok")
        yield* report("failing")
        yield* tick
        yield* tick
      }),
      repeating
    )

    // Entry 0 opened the condition. Each of the two refused pages left an
    // admission and a failure record, 5 is the ok report, and 6 the re-opening.
    expect(sink.asked).toEqual([deployId(0, 0), `${deployId(0, 0)}:r1`, deployId(hour, 6)])
  })

  it("waits out the time a sink named, and records a refusal for good that follows a plain failure", async () => {
    let error = new Alerts.AlertError({ message: "unavailable", status: 503 })
    const sink = refusing(() => error)
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* report("failing")
        // A plain failure holds nothing: the next tick asks again.
        yield* tick
        error = new Alerts.AlertError({ message: "slow down", status: 429, retryAfterMillis: 60_000 })
        yield* tick
        const asked = sink.asked.length
        yield* TestClock.adjust("59 seconds")
        // A new process reads the wait off the journal.
        yield* Effect.provide(tick, runtime(sink.layer))
        const whileWaiting = sink.asked.length
        yield* TestClock.adjust("1 second")
        // The same code as the 503 and the 429, and still recorded: it holds the page for good.
        error = new Alerts.AlertError({ message: "key revoked", status: 401, retryable: false, retryAfterMillis: 5 })
        yield* tick
        yield* TestClock.adjust("1 hour")
        yield* tick
        return { asked, whileWaiting, failures: yield* failures }
      })
    )

    expect([observed.asked, observed.whileWaiting, sink.asked.length]).toEqual([2, 2, 3])
    expect(
      observed.failures.map((payload) => {
        const { retryAtMs, retryable, status } = payload as Record<string, unknown>
        return { status, retryable, retryAtMs }
      })
    ).toEqual([
      { status: 503, retryable: undefined, retryAtMs: undefined },
      { status: 429, retryable: undefined, retryAtMs: 60_000 },
      { status: 401, retryable: false, retryAtMs: undefined }
    ])
  })

  it("holds nothing on a failure record another producer journals, or one that names no instant", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* report("failing")
        const id = deployId(0, 0)
        const journal = yield* Journal.Journal
        // A step in the run can name the alert. Only the alerter's source holds a page back.
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("/flow/step"),
            eventType: Alerts.failedEventType,
            payload: { runId, alertId: id, code: "sink_rejected", retryable: false }
          })
        )
        yield* recorded(Alerts.failedEventType, id, "failed/sink_rejected/wait", { code: "sink_rejected" })
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("/flow/step"),
            eventType: Alerts.failedEventType,
            payload: { runId, code: "sink_rejected" }
          })
        )
        return yield* tick
      })
    )

    expect(observed.delivered.map(Alerts.alertId)).toEqual([deployId(0, 0)])
  })
})

describe("an operation given something the journal cannot store", () => {
  const refusal = <A>(
    program: Effect.Effect<A, unknown, Services>,
    rules: Alerts.Policy = policy
  ) =>
    run(
      keeping().layer,
      Effect.map(Effect.flip(program), (error) => {
        const { _tag, code, path } = error as NotificationQueue.NotificationError
        return [_tag, code, path]
      }),
      rules
    )
  const invalid = (path: string) => ["/notifications/NotificationError", "notification_invalid", path]
  const on = (id: string) => ({
    acknowledge: Effect.flatMap(alerts, (service) => service.acknowledge(id, deployId(0, 0), "will")),
    standing: Effect.flatMap(alerts, (service) => service.standing(id)),
    tick: Effect.flatMap(alerts, (service) => service.tick(id))
  })

  it.each(["", "run\u0000id", "\uD800", "r".repeat(1_025)])(
    "refuses the run id %j on every operation",
    async (id) => {
      expect(await refusal(on(id).acknowledge)).toEqual(invalid("runId"))
      expect(await refusal(on(id).standing)).toEqual(invalid("runId"))
      expect(await refusal(on(id).tick)).toEqual(invalid("runId"))
    }
  )

  it("refuses a policy whose condition is malformed UTF-16 on every operation", async () => {
    // Keying the alert percent-encodes the condition, which throws on a lone surrogate.
    const malformed: Alerts.Policy = { rules: { "\uD800": { afterMs: 0 } } }

    expect(await refusal(on(runId).acknowledge, malformed)).toEqual(invalid("condition"))
    expect(await refusal(on(runId).standing, malformed)).toEqual(invalid("condition"))
    expect(await refusal(on(runId).tick, malformed)).toEqual(invalid("condition"))
  })

  it.each(["\u0000", "\uDC00", `alert:${"a".repeat(1_024)}`])(
    "refuses to acknowledge the alert id %j, and writes nothing",
    async (id) => {
      const observed = await run(
        keeping().layer,
        Effect.gen(function*() {
          yield* report("failing")
          const error = (yield* Effect.flip(acknowledge(id, "will"))) as NotificationQueue.NotificationError
          const journal = yield* Journal.Journal
          const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 8 })
          return { error, written: page.entries.map((entry) => entry.eventType) }
        })
      )

      expect([observed.error._tag, observed.error.code, observed.error.path]).toEqual(invalid("alertId"))
      expect(observed.written).toEqual([Alerts.probeEventType("deploy")])
    }
  )

  it("keeps who acknowledged to 200 units without ending on half a character", async () => {
    const taken = (by: string) =>
      run(
        keeping().layer,
        Effect.gen(function*() {
          yield* report("failing")
          yield* acknowledge(deployId(0, 0), by)
          return (yield* standing).map((item) => item.acknowledgedBy)
        })
      )

    // The 200th unit is the first half of an emoji: keeping it would journal a lone surrogate.
    expect(await taken(`${"w".repeat(199)}😀tail`)).toEqual(["w".repeat(199)])
    // The emoji ends exactly at the bound, so all of it is kept.
    expect(await taken(`${"w".repeat(198)}😀tail`)).toEqual([`${"w".repeat(198)}😀`])
  })
})

describe("Alerts.decide and Alerts.alertId over a caller's own conditions", () => {
  it("carry an opening the caller read off a journal, and leave it out when there is none", () => {
    const [bare, sequenced] = Alerts.decide(policy, [
      { runId, condition: "deploy", since: 5 },
      { runId, condition: "deploy", since: 5, opening: 12 }
    ], 5)

    expect(bare).toEqual({ runId, condition: "deploy", since: 5, firedAt: 5, severity: "critical", coalescingKey: key })
    expect(sequenced).toEqual({ ...bare, opening: 12 })
    expect([Alerts.alertId(bare!), Alerts.alertId(sequenced!)]).toEqual([legacyId(5), `${legacyId(5)}:s12`])
    expect(Alerts.alertId({ ...sequenced!, reminder: 2 })).toBe(`${legacyId(5)}:s12:r2`)
  })
})
