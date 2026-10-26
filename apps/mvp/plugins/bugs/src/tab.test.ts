// The bug plugin's form rules (plugins/bugs/src/tab.ts): what a person's words become, and when a Send counts as Sent.
// The tab itself runs over the real host and a real device in src/features/bugs/device.test.ts; here only a host that
// refuses the Send, injected, which the real host never does for words the form allows.
import { Host } from "@smthrs/plugin"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { MAX_WHAT, type Report, type Sending, settle, tab, whatOf } from "./tab"

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
    const sending: Sending = { status: "sending", id: "b" }
    expect(settle(sending, [report("a")])).toBe(sending)
    expect(settle(sending, [report("a"), report("b")])).toEqual({ status: "sent", report: report("b") })
    for (const other of [{ status: "idle" }, { status: "refused" }, { status: "sent", report: report("a") }] as const) {
      expect(settle(other, [report("a"), report("b")])).toBe(other)
    }
  })
})

/** A host that refuses every dispatch, as it would an event the manifest doesn't declare: the unhappy path. */
const refusing = Layer.succeed(
  Host.PluginHost,
  Host.PluginHost.of({
    query: () => Effect.succeed({ current: () => [], subscribe: () => () => {} }),
    select: () => Effect.void,
    propose: () => Effect.void,
    dispatch: () => Effect.fail(new Host.PluginRefused({ plugin: "bugs", reason: "undeclared_event", detail: "send" })),
    open: () => Effect.void,
    events: () => Stream.empty,
  }),
)

describe("a Send the host refuses", () => {
  test("says Not sent; a listener hears each change until it stops listening", async () => {
    const { heard, last } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const built = yield* tab
          const heard: Array<string> = []
          const stop = built.queries.sending.subscribe(() => heard.push(built.queries.sending.current().status))
          built.actions.send("The page went blank")
          yield* Effect.sleep("20 millis")
          stop()
          built.actions.send("Again")
          yield* Effect.sleep("20 millis")
          return { heard, last: built.queries.sending.current() }
        }),
      ).pipe(Effect.provide(refusing)),
    )
    expect(heard).toEqual(["sending", "refused"])
    expect(last).toEqual({ status: "refused" })
  })
})
