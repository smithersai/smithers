// The bug plugin's form rules (plugins/bugs/src/tab.ts): what a person's words become, and when a Send counts as Sent.
// The tab runs over the real host and a real device in src/features/bugs/device.test.ts; here over an injected host
// whose runs end as a test says (TEST-7), for the endings a real device reaches rarely: refused for good, retried.
import { Host } from "@smthrs/plugin"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { idFor, MAX_WHAT, reasonOf, type Report, type Sending, settle, tab, whatOf } from "./tab"

const report = (id: string): Report => ({
  id,
  reporterLogin: "codeplanesmithers",
  reporterRole: "member",
  actedBy: null,
  what: "x",
  route: null,
  repo: null,
  build: "dev",
  traces: [],
  runs: [],
  failures: [],
  browser: "Test/1.0",
  viewport: "1280x800",
  createdAt: "2026-10-25T20:00:00.000Z",
  github: "https://github.com/smithersai/smithers/issues/new",
})

describe("the form", () => {
  test("sends the words trimmed; only spaces, nothing or too much sends nothing", () => {
    expect(whatOf("  The page went blank \n")).toBe("The page went blank")
    expect(whatOf("   \n ")).toBeUndefined()
    expect(whatOf("")).toBeUndefined()
    expect(whatOf("x".repeat(MAX_WHAT))).toHaveLength(MAX_WHAT)
    expect(whatOf("x".repeat(MAX_WHAT + 1))).toBeUndefined()
  })

  test("a Send is Sent only once its report comes back; nothing else changes", () => {
    const sending: Sending = { status: "sending", id: "b", what: "x" }
    expect(settle(sending, [report("a")])).toBe(sending)
    expect(settle(sending, [report("a"), report("b")])).toEqual({ status: "sent", report: report("b") })
    const others = [
      { status: "idle" },
      { status: "failed", id: "b", what: "x", code: "invalid" },
      { status: "sent", report: report("a") },
    ] as const
    for (const other of others) {
      expect(settle(other, [report("a"), report("b")])).toBe(other)
    }
  })
})

/**
 * A host whose runs end as `outcomes` says, one per dispatch, recording what each dispatch sent in `sent`: the faulty
 * service. `arrive` brings a report's row, as sync does.
 */
const hostWith = (
  outcomes: ReadonlyArray<Host.Settled | "refused">,
  rows: Array<Report> = [],
  sent: Array<unknown> = [],
) => {
  const listeners = new Set<() => void>()
  let index = 0
  const arrive = (row: Report) => {
    rows.push(row)
    for (const listener of listeners) listener()
  }
  const layer = Layer.succeed(
    Host.PluginHost,
    Host.PluginHost.of({
      query: () =>
        Effect.succeed({
          current: () => rows as never,
          subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => void listeners.delete(listener)
          },
        }),
      select: () => Effect.void,
      propose: () => Effect.void,
      dispatch: (_event, fields) => {
        const outcome = outcomes[index++]!
        sent.push(fields)
        return outcome === "refused"
          ? Effect.fail(new Host.PluginRefused({ plugin: "bugs", reason: "undeclared_event", detail: "send" }))
          : Effect.succeed({ runId: `run-${index}`, settled: Effect.succeed(outcome) })
      },
      open: () => Effect.void,
      events: () => Stream.empty,
    }),
  )
  return Object.assign(layer, { arrive })
}

/** Runs `body` against the tab built over `host`, in a scope. */
const withTab = <A>(host: Layer.Layer<Host.PluginHost>, body: (built: Effect.Success<typeof tab>) => Effect.Effect<A>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(tab, body)).pipe(Effect.provide(host)))

const pause = Effect.sleep("20 millis")

describe("a report that isn't sent", () => {
  test("a run ChatApi refused for good says Not sent with its reason, keeps the words, and Retry sends the same report", async () => {
    const sent: Array<{ readonly id: string; readonly what: string }> = []
    const heard = await withTab(
      hostWith([{ _tag: "Failed", code: "authentication" }, { _tag: "Failed", code: "BugUnsent" }], [], sent as never),
      (built) =>
        Effect.gen(function* () {
          const heard: Array<Sending> = []
          built.queries.sending.subscribe(() => heard.push(built.queries.sending.current()))
          built.actions.send("  The page went blank  ")
          yield* pause
          // Retry: the same words file the same report again.
          built.actions.send("The page went blank")
          yield* pause
          return heard
        }),
    )
    const id = sent[0]!.id
    const what = "The page went blank"
    expect(heard).toEqual([
      { status: "sending", id, what },
      { status: "failed", id, what, code: "authentication" },
      { status: "sending", id, what },
      { status: "failed", id, what, code: "BugUnsent" },
    ])
    expect(reasonOf("authentication")).toBe("signed out")
    expect(sent).toEqual([{ id, what }, { id, what }])
  })

  test("a filed run whose row isn't back yet stays Sending; new words after a failure are a new report", async () => {
    const rows: Array<Report> = []
    const sent: Array<{ readonly id: string; readonly what: string }> = []
    const states = await withTab(hostWith([{ _tag: "Failed", code: "invalid" }, { _tag: "Done" }], rows, sent as never), (built) =>
      Effect.gen(function* () {
        built.actions.send("first words")
        yield* pause
        built.actions.send("better words")
        // A second press while it's on its way does nothing.
        built.actions.send("better words")
        yield* pause
        return { filed: built.queries.sending.current(), sentId: sent[1]!.id }
      }))
    expect(sent).toHaveLength(2)
    expect(sent[1]!.id).not.toBe(sent[0]!.id)
    // Filed, its row not here yet: still Sending, never Sent on the press alone.
    expect(states.filed).toMatchObject({ status: "sending", id: states.sentId, what: "better words" })
  })

  test("a filed report is Sent once its row comes back", async () => {
    const sent: Array<{ readonly id: string }> = []
    const host = hostWith([{ _tag: "Done" }], [], sent as never)
    const state = await withTab(host, (built) =>
      Effect.gen(function* () {
        built.actions.send("words")
        yield* pause
        host.arrive(report(sent[0]!.id))
        return built.queries.sending.current()
      }))
    expect(state).toEqual({ status: "sent", report: report(sent[0]!.id) })
  })

  test("a Send the host refuses is Not sent with the refusal; a listener hears each change until it stops", async () => {
    const { heard, last } = await withTab(hostWith(["refused", "refused"]), (built) =>
      Effect.gen(function* () {
        const heard: Array<string> = []
        const stop = built.queries.sending.subscribe(() => heard.push(built.queries.sending.current().status))
        built.actions.send("The page went blank")
        yield* pause
        stop()
        built.actions.send("Again")
        yield* pause
        return { heard, last: built.queries.sending.current() }
      }))
    expect(heard).toEqual(["sending", "failed"])
    expect(last).toMatchObject({ status: "failed", what: "Again", code: "undeclared_event" })
  })

  test("the reasons in a few words, and the id a Send files under", () => {
    expect([reasonOf("authentication"), reasonOf("forbidden"), reasonOf("invalid"), reasonOf("invalid_fields")])
      .toEqual(["signed out", "not allowed", "not accepted", "not accepted"])
    expect([reasonOf("too_large"), reasonOf("BugUnsent"), reasonOf("interrupted")])
      .toEqual(["too long", "couldn't reach Smithers", "interrupted"])
    const fresh = () => "new"
    expect(idFor({ status: "failed", id: "old", what: "a", code: "x" }, "a", fresh)).toBe("old")
    expect(idFor({ status: "failed", id: "old", what: "a", code: "x" }, "b", fresh)).toBe("new")
    expect(idFor({ status: "idle" }, "a", fresh)).toBe("new")
  })
})
