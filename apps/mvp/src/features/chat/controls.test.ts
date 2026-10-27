import { SyncPolicy } from "@smthrs/effect-electric"
import type { Outbox } from "@smthrs/effect-tanstack-db"
import { Effect, Metric, Option, Stream } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { dispatches, FlowDispatch } from "../../flows/dispatch"
import {
  type NodeDevice,
  nodeDevice,
  openFaultyTab,
  openTab,
  openTestApp,
  type TabOptions,
  TestChatApi,
} from "../../test/chatApi"
import { EngineFaults, QuestionFaults } from "../../test/faults"
import { copyableText, setDraft, show, takeBack } from "./actions"
import { Chat } from "./chat"
import { HOME_DRAFT } from "./schema"
import { ChatStore } from "./store"
import { postgresTime, timeOf } from "./view"

// Message controls on the app's own layer (docs/features/chat.md#message-controls), driven as React drives them: Copy
// and Edit through their flows on a device whose engine leads, the saved draft across a reload, and each message's
// time. Real ChatApi, Postgres, Electric and outbox; only the model is scripted, and an unhappy path gets the faulty
// ChatApi client or engine (src/test/faults.ts).

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const quick: TabOptions = {
  unreachableAfter: "300 millis",
  confirmWithin: "1 second",
  retry: SyncPolicy.backoff({ initial: "20 millis", max: "50 millis" }),
}

const until = (assertion: () => void | Promise<void>, timeout = 15_000) =>
  vi.waitFor(assertion, { timeout, interval: 20 })

/** A ChatApi for the test, and a device of its own whose engine runs this device's flows. */
const openApi = async () => {
  const runtime = openTestApp({ answers: false })
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  return { api, device: nodeDevice({ agent: api }) }
}

/** A tab on `device`, faulty when asked, as React reads it. Opening another on the same device is a reload. */
const openOn = async (api: TestChatApi["Service"], device: NodeDevice, faulty = false) => {
  const runtime = faulty ? openFaultyTab(api, { ...quick, host: device }) : openTab(api, { ...quick, host: device })
  runtimes.push(runtime)
  const { queries, actions } = await runtime.runPromise(Effect.service(Chat))
  const store = await runtime.runPromise(Effect.service(ChatStore))
  for (const query of [store.shown, store.queued, store.composerState, store.connectionState, store.historyState]) {
    query.tanstack.startSyncImmediate()
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => runtime.runPromise(effect as never) as Promise<A>
  return {
    queries,
    actions,
    store,
    runtime,
    run,
    shown: () => queries.conversation.toArray.map(({ role, status, text }) => `${role} ${status} ${text}`),
    composer: () => queries.composer.toArray[0],
    /** Dispatches `name` from this tab through `door`, and answers how it ended. */
    dispatch: (name: "chat/copy" | "chat/edit", payload: object, door: "slash" | "button") =>
      runtime.runPromise(
        Effect.gen(function* () {
          return yield* Effect.result((yield* FlowDispatch).dispatch(name, payload as never, { door }))
        }),
      ),
    count: (attributes: Record<string, string>) =>
      runtime.runSync(Metric.value(Metric.withAttributes(dispatches, attributes))).count,
    close: () => runtime.dispose(),
  }
}

type Tab = Awaited<ReturnType<typeof openOn>>

/**
 * A ChatApi and a device whose outbox's network starts offline, behind a switch: the outbox sends nothing while it is
 * off, as a browser's outbox waits for the `online` event. A detector the test controls, in place of the device's
 * always-online one (test.faults-by-injection).
 */
const openOffline = async () => {
  const { api, device } = await openApi()
  const listeners = new Set<() => void>()
  let online = false
  const detector: Outbox.Online = {
    subscribe: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    notifyOnline: () => listeners.forEach((listener) => listener()),
    isOnline: () => online,
    dispose: () => listeners.clear(),
  }
  return {
    api,
    device: { ...device, outbox: { ...device.outbox, online: detector } } as NodeDevice,
    network: {
      online: () => {
        online = true
        detector.notifyOnline()
      },
      offline: () => void (online = false),
    },
  }
}

/** Asks `text` and has the model answer `answer`, settled. */
const answered = async (tab: Tab, api: TestChatApi["Service"], text: string, answer: string) => {
  const result = (await tab.actions.ask(text))
  if (!result.asked) throw new Error(result.reason)
  const reply = await tab.run(api.answerTo(text))
  reply.say(answer)
  reply.done()
  await until(() => expect(tab.shown().slice(-2)).toEqual([`user done ${text}`, `assistant done ${answer}`]), 25_000)
  return result
}

describe("Copy", () => {
  test("Copy on a message puts its text on this tab's clipboard through chat/copy; /copy copies the latest answer", async () => {
    const { api, device } = await openApi()
    const tab = await openOn(api, device)
    const first = await answered(tab, api, "hello", "Hi there")
    await answered(tab, api, "and again", "Hi again")

    await tab.actions.copy(first.answerId)
    await tab.actions.copy(first.questionId)
    expect(device.copied).toEqual(["Hi there", "hello"])
    expect(tab.count({ flow: "chat/copy", door: "button", outcome: "done" })).toBe(2)

    const slash = await tab.dispatch("chat/copy", {}, "slash")
    expect(slash).toMatchObject({ _tag: "Success", success: { _tag: "Done", value: { copied: true } } })
    expect(device.copied.at(-1)).toBe("Hi again")
  }, 60_000)

  test("a message this tab doesn't show is not copied: Copy rejects, and the flow fails MessageNotFound", async () => {
    const { api, device } = await openApi()
    const tab = await openOn(api, device)
    await expect(tab.actions.copy("no-such-message")).rejects.toMatchObject({ _tag: "NotCopied" })
    const latest = await tab.dispatch("chat/copy", {}, "slash")
    expect(latest).toMatchObject({ _tag: "Success", success: { _tag: "Failed", error: { _tag: "@smthrs/mvp/chat/MessageNotFound" } } })
    expect(device.copied).toEqual([])
  })

  test("a clipboard that refuses fails the copy, and Copy rejects", async () => {
    const { api } = await openApi()
    const device = nodeDevice({ agent: api, clipboard: () => Promise.reject(new Error("denied")) })
    const tab = await openOn(api, device)
    const { answerId } = await answered(tab, api, "hello", "Hi")
    await expect(tab.actions.copy(answerId)).rejects.toMatchObject({ _tag: "NotCopied" })
    const copied = await tab.dispatch("chat/copy", { messageId: answerId }, "button")
    expect(copied).toMatchObject({ _tag: "Success", success: { _tag: "Done", value: { copied: false } } })
  })

  test("only finished messages copy: not an answer still streaming, a failed one, or a view", async () => {
    const { api, device } = await openApi()
    const tab = await openOn(api, device)
    const { answerId } = (await tab.actions.ask("hello")) as { readonly answerId: string }
    const reply = await tab.run(api.answerTo("hello"))
    reply.say("Hal")
    await until(() => expect(tab.shown()).toEqual(["user done hello", "assistant streaming Hal"]))
    expect(await tab.run(copyableText(answerId))).toEqual(Option.none())
    expect(await tab.run(copyableText())).toEqual(Option.none())
    expect(await tab.run(copyableText("hello"))).toEqual(Option.none())
    reply.fail()
    await until(() => expect(tab.shown().at(-1)).toMatch(/^assistant failed /))
    expect(await tab.run(copyableText(answerId))).toEqual(Option.none())
  })
})

describe("Edit on a queued question", () => {
  test("takes a question the outbox hasn't sent back to the composer; it is never sent, and the edit is", async () => {
    const { api, device, network } = await openOffline()
    const tab = await openOn(api, device, true)
    const faults = await tab.run(Effect.service(QuestionFaults))
    // Offline, the question waits in the outbox, queued, once this tab leads it.
    const first = (await tab.actions.ask("frist question"))
    if (!first.asked) throw new Error(first.reason)
    await until(() => expect(tab.shown()).toEqual(["user queued frist question"]))

    const edited = await tab.dispatch("chat/edit", { questionId: first.questionId }, "button")
    expect(edited).toMatchObject({ _tag: "Success", success: { _tag: "Done", value: { edited: true } } })
    expect(tab.composer()).toMatchObject({ open: true, draft: "frist question" })
    await until(() => expect(tab.shown()).toEqual([]))
    // The device keeps the edited text as the draft.
    await until(() => expect(device.stored("chat-drafts")).toBe(1))

    // Online, the outbox sends only the edit: the question taken back never reaches Postgres.
    await tab.run(faults.failNext("invalid_response"))
    tab.actions.setDraft("first question")
    const replacement = (await tab.actions.ask("first question"))
    if (!replacement.asked) throw new Error(replacement.reason)
    tab.actions.setDraft("next")
    network.online()
    await until(() => expect(tab.shown().slice(0, 1)).toEqual(["user done first question"]))
    const rows = await tab.run(api.rows)
    expect(rows.map(({ text }) => text).filter((text) => text !== "")).toEqual(["first question"])
    // A lost receipt may redeliver the replacement; every attempt must keep its identity and exclude the withdrawn text.
    await until(async () => expect((await tab.run(faults.asked)).length).toBeGreaterThanOrEqual(2))
    const attempted = await tab.run(faults.asked)
    expect(new Set(attempted.map(({ id }) => id))).toEqual(new Set([replacement.questionId]))
    expect(new Set(attempted.map(({ answerId }) => answerId))).toEqual(new Set([replacement.answerId]))
    expect(new Set(attempted.map(({ text }) => text))).toEqual(new Set(["first question"]))

    // The draft typed after it is the one a reload finds.
    await until(() => expect(tab.composer()).toMatchObject({ draft: "next", saved: true }))
    await tab.close()
    const again = await openOn(api, device, true)
    await until(() => expect(again.composer()).toMatchObject({ draft: "next" }))
  })

  test("Edit from the button, and /edit, take the latest waiting question, queued or unsent", async () => {
    const { api, device, network } = await openOffline()
    network.online()
    const tab = await openOn(api, device, true)
    const faults = await tab.run(Effect.service(QuestionFaults))
    await tab.run(faults.failNext("bad_request"))
    ;(await tab.actions.ask("refused"))
    await until(() => expect(tab.shown()).toEqual(["user unsent refused"]))
    const slash = await tab.dispatch("chat/edit", {}, "slash")
    expect(slash).toMatchObject({ _tag: "Success", success: { _tag: "Done", value: { edited: true } } })
    expect(tab.composer()).toMatchObject({ open: true, draft: "refused" })
    await until(() => expect(tab.shown()).toEqual([]))

    network.offline()
    const queued = (await tab.actions.ask("queued"))
    if (!queued.asked) throw new Error(queued.reason)
    await until(() => expect(tab.shown()).toEqual(["user queued queued"]))
    tab.actions.edit(queued.questionId)
    await until(() => expect(tab.composer()).toMatchObject({ draft: "queued" }))
    await until(() => expect(tab.shown()).toEqual([]))
    expect((await tab.run(faults.asked)).map(({ text }) => text)).toEqual(["refused"])
  })

  test("a question the outbox is sending stays where it is: it is sent, and the composer keeps its draft", async () => {
    const { api, device } = await openApi()
    const tab = await openOn(api, device, true)
    const engine = await tab.run(Effect.service(EngineFaults))
    // ChatApi takes the question, and the send waits for this device's engine to record the run that answers it.
    await tab.run(engine.holdStarts)
    const asked = (await tab.actions.ask("on its way"))
    if (!asked.asked) throw new Error(asked.reason)
    await until(async () => expect((await tab.run(api.rows)).map(({ text }) => text)).toContain("on its way"))
    tab.actions.setDraft("typing")
    expect(await tab.run(takeBack(asked.questionId))).toBe("sent")
    expect(tab.composer()).toMatchObject({ draft: "typing" })
    await tab.run(engine.releaseStarts)
    await until(() => expect(tab.shown()[0]).toBe("user done on its way"))
  })

  test("a question the device can't delete from its outbox stays queued: taking it back fails, and the draft stays", async () => {
    const { api, device } = await openOffline()
    // The outbox's storage refuses deletes, as a browser's IndexedDB can (test.faults-by-injection).
    const storage = { ...device.outbox.storage, delete: () => Promise.reject(new Error("storage refused the delete")) }
    const tab = await openOn(api, { ...device, outbox: { ...device.outbox, storage } } as NodeDevice)
    const asked = (await tab.actions.ask("stuck"))
    if (!asked.asked) throw new Error(asked.reason)
    await until(() => expect(tab.shown()).toEqual(["user queued stuck"]))
    tab.actions.setDraft("typing")

    expect(await tab.run(takeBack(asked.questionId))).toBe("failed")
    expect(tab.composer()).toMatchObject({ draft: "typing" })
    expect(tab.shown()).toEqual(["user queued stuck"])
  })

  test("a tab another tab took the outbox's lead from takes it back to take its question back", async () => {
    const { api, device, network } = await openOffline()
    const leads = async (tab: Tab) => Option.getOrThrow(await tab.run(Stream.runHead(tab.store.outbox.status))).leader
    const first = await openOn(api, device)
    const asked = (await first.actions.ask("asked here"))
    if (!asked.asked) throw new Error(asked.reason)
    await until(() => expect(first.shown()).toEqual(["user queued asked here"]))
    // Another tab on the device takes the lead, as the tab a person moves to does.
    const second = await openOn(api, device)
    await second.run(second.store.lead)
    await until(async () => expect(await leads(first)).toBe(false))

    expect(await first.run(takeBack(asked.questionId))).toBe("edited")
    expect(first.composer()).toMatchObject({ open: true, draft: "asked here" })
    expect(await leads(first)).toBe(true)
    await until(() => expect(first.shown()).toEqual([]))

    // Online, only what is asked next is sent: the question taken back never reaches Postgres.
    network.online()
    const next = (await first.actions.ask("next"))
    if (!next.asked) throw new Error(next.reason)
    await until(async () =>
      expect((await first.run(api.rows)).map(({ text }) => text).filter((text) => text !== "")).toEqual(["next"])
    )
  })

  test("nothing waiting is not_found", async () => {
    const { api, device } = await openApi()
    const tab = await openOn(api, device)
    expect(await tab.run(takeBack())).toBe("not_found")
    expect(await tab.run(takeBack("no-such-question"))).toBe("not_found")
  })
})

describe("the saved draft", () => {
  test("survives a reload, is kept per conversation, and goes once it is sent", async () => {
    const { api, device } = await openApi()
    const first = await openOn(api, device)
    first.actions.setDraft("half a thought")
    first.actions.setDraft("half a thought")
    await until(() => expect(device.stored("chat-drafts")).toBe(1))
    await first.close()

    // A reload: the draft is back in the composer.
    const second = await openOn(api, device)
    await until(() => expect(second.composer()).toMatchObject({ draft: "half a thought" }))
    expect(second.store.drafts.tanstack.get(HOME_DRAFT)).toMatchObject({ text: "half a thought" })

    // Each conversation keeps its own: the composer shows the draft of the conversation shown.
    await second.run(show("branch-a"))
    expect(second.composer()).toMatchObject({ draft: "" })
    // Copy reads the conversation shown: the branch's has no answer yet.
    expect(await second.run(copyableText())).toEqual(Option.none())
    second.actions.setDraft("branch draft")
    await second.run(show(null))
    expect(second.composer()).toMatchObject({ draft: "half a thought" })
    await second.run(show("branch-a"))
    expect(second.composer()).toMatchObject({ draft: "branch draft" })
    await until(() => expect(device.stored("chat-drafts")).toBe(2))

    // Asking sends the draft and forgets it; clearing the draft forgets it too.
    ;(await second.actions.ask("branch draft"))
    expect(second.store.drafts.tanstack.has("branch-a")).toBe(false)
    await second.run(show(null))
    second.actions.setDraft("")
    await until(() => expect(device.stored("chat-drafts")).toBe(0))
  })

  test("the draft the device already keeps, typed again, writes nothing: it stays saved", async () => {
    const { api, device } = await openApi()
    const tab = await openOn(api, device)
    // Nothing kept, and nothing typed: nothing to write.
    await tab.run(setDraft(""))
    expect(tab.composer()).toMatchObject({ draft: "", saved: true })
    await tab.run(setDraft("same"))
    await until(() => expect(tab.composer()).toMatchObject({ draft: "same", saved: true }))

    await tab.run(setDraft("same"))

    expect(tab.composer()).toMatchObject({ draft: "same", saved: true })
    expect(device.stored("chat-drafts")).toBe(1)
  })

  test("a draft typed, changed, sent and typed again is the one a reload finds", async () => {
    const { api, device } = await openApi()
    const first = await openOn(api, device)
    first.actions.setDraft("typo")
    expect(first.composer()).toMatchObject({ draft: "typo", saved: false })
    first.actions.setDraft("fixed")
    ;(await first.actions.ask("fixed"))
    first.actions.setDraft("half a thought")
    // Saved once the device stored the latest draft; an earlier draft's write never marks a later one saved.
    await until(() => expect(first.composer()).toMatchObject({ draft: "half a thought", saved: true }))
    expect(device.stored("chat-drafts")).toBe(1)
    await first.close()
    const second = await openOn(api, device)
    await until(() => expect(second.composer()).toMatchObject({ draft: "half a thought" }))
  })

  test("a reload finds the draft after the person has typed: what they typed stays", async () => {
    const { api, device } = await openApi()
    const first = await openOn(api, device)
    first.actions.setDraft("kept")
    await until(() => expect(device.stored("chat-drafts")).toBe(1))
    await first.close()
    const second = await openOn(api, device)
    second.actions.setDraft("typed first")
    await second.run(Effect.andThen(Effect.service(ChatStore), (store) => store.drafts.restored))
    await new Promise((resolve) => setImmediate(resolve))
    expect(second.composer()).toMatchObject({ draft: "typed first" })
  })
})

describe("times", () => {
  test("Postgres' timestamps read as epoch milliseconds; anything else reads as none", () => {
    expect(postgresTime("2026-10-20 19:01:02.123456+00")).toBe(Date.UTC(2026, 9, 20, 19, 1, 2, 123))
    expect(postgresTime("2026-10-20 19:01:02+05:30")).toBe(Date.UTC(2026, 9, 20, 13, 31, 2))
    expect(postgresTime("2026-10-20T19:01:02.5Z")).toBe(Date.UTC(2026, 9, 20, 19, 1, 2, 500))
    expect(postgresTime("2026-10-20 19:01:02-07")).toBe(Date.UTC(2026, 9, 21, 2, 1, 2))
    expect(postgresTime("2026-13-01 19:01:02+00")).toBeUndefined()
    expect(postgresTime("")).toBeUndefined()
    expect(postgresTime("yesterday")).toBeUndefined()
  })

  test("a synced message shows Postgres' time; a question not sent yet, when it was asked here", async () => {
    const { api, device } = await openApi()
    const tab = await openOn(api, device)
    await answered(tab, api, "hello", "Hi")
    const [question, answer] = tab.queries.conversation.toArray
    const before = Date.now()
    expect(timeOf(question!)).toBeLessThanOrEqual(before)
    expect(timeOf(question!)).toBeGreaterThan(before - 60_000)
    expect(timeOf(answer!)).toBeGreaterThanOrEqual(timeOf(question!)!)
    expect(timeOf({ local: 1, at: 1_000, createdAt: "" })).toBe(1_000)
  })
})
