import { Collection } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Logger } from "effect"
import { expect, test } from "vitest"
import { DispatchFailed, FlowDispatch } from "../../flows/dispatch.vibe"
import { hide } from "./actions.vibe"
import { ActRefused } from "./flows"
import { type Entry as EntryRow, Entry, Pending } from "./schema"
import { AttentionStore } from "./store.vibe"

// A Hide that can't land takes back only the pending row it sent. When the person pressed again at a newer version
// first, the newer act stays on the device and its own failure decides it. Real local collections, and a dispatch that
// answers each version when the test releases it.

const subject = "clone:github/octo/hello"

const entry = (version: number): EntryRow => ({
  id: subject,
  kind: "clone",
  state: "working",
  mine: true,
  runId: null,
  conversationId: null,
  actor: null,
  atMs: 1,
  word: null,
  detail: null,
  action: "open",
  href: "/octo/hello",
  version,
  unread: true,
  settled: false,
  stack: true,
  stackHere: false,
  listed: true,
  here: false,
  order: 0,
})

test("a failed act leaves a newer press's pending row, which its own failure takes back", async () => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))
  const program = Effect.gen(function* () {
    const scope = yield* Effect.scope
    const entries = yield* Collection.local<EntryRow, string>({
      id: `attention-entries-${crypto.randomUUID()}`,
      schema: Entry,
      getKey: (row) => row.id,
    })
    const pending = yield* Collection.local<Pending, string>({
      id: `attention-pending-${crypto.randomUUID()}`,
      schema: Pending,
      getKey: (row) => row.id,
    })
    const answers = new Map([[1, yield* Deferred.make<void>()], [2, yield* Deferred.make<void>()]])
    // Version 1's run never starts; version 2's ends refused by ChatApi.
    const dispatch = (_name: string, payload: { readonly version: number }) =>
      Effect.flatMap(Deferred.await(answers.get(payload.version)!), () =>
        payload.version === 1
          ? Effect.fail(new DispatchFailed({ flow: "notification/ack", reason: "unavailable" }))
          : Effect.succeed({ _tag: "Failed" as const, error: new ActRefused({ status: 403 }) }))
    const store = { entries, pending, scope } as unknown as AttentionStore["Service"]
    const press = hide(subject).pipe(
      Effect.provideService(AttentionStore, store),
      Effect.provideService(FlowDispatch, FlowDispatch.of({ dispatch: dispatch as never })),
    )
    yield* entries.insert(entry(1))
    yield* press
    yield* entries.update(subject, (draft) => void (draft.version = 2))
    yield* press
    expect(yield* pending.toArray).toEqual([
      expect.objectContaining({ id: `${subject}:hide`, subject, act: "hide", version: 2 }),
    ])
    yield* Deferred.succeed(answers.get(1)!, undefined)
    yield* Deferred.succeed(answers.get(2)!, undefined)
    yield* Effect.repeat(Effect.yieldNow, { until: () => logs.some((log) => log.message === "notifications.pending") })
    return yield* pending.toArray
  })
  const left = await Effect.runPromise(Effect.scoped(program).pipe(
    Effect.timeout("5 seconds"),
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
  ))
  expect(left).toEqual([])
  expect(logs.filter((log) => log.message === "notifications.pending").map((log) => log.annotations)).toEqual([
    expect.objectContaining({ version: 2, outcome: "dropped", reason: "@smthrs/mvp/attention/ActRefused" }),
  ])
})
