import { SyncPolicy } from "@smthrs/effect-electric"
import { Model, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { Effect, Stream } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { nodeDevice, openTab, openTestApi, TestChatApi } from "../../test/chatApi"
import { Chat } from "../chat/chat"
import { ChatStore } from "../chat/store"
import { revisionOf } from "./identity"
import { SUMMARY_TOKENS } from "./steps.vibe"

// The timeline followers use a scripted summary seat and ChatApi's real Postgres ledger to deduplicate across devices
// (docs/features/timeline.md#cost). The questions and answers travel through chat admission and a BYOA attachment.

const opened: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of opened.reverse().splice(0)) await runtime.dispose() })
const until = (check: () => void | Promise<void>) => vi.waitFor(check, { timeout: 30_000, interval: 25 })
const WITHIN = 120_000

/** What the agent answers: more than a label shows, so each answer needs one model summary. */
const ANSWER = "The release retried twice.\nBoth recorded attempts kept the missing projection entry."
const SUMMARY = "Release retry check completed"

test("an idle page and a page receiving N messages cause at most one summary call per message in total, across two tabs", async () => {
  const root = openTestApi()
  opened.push(root)
  const api = await root.runPromise(Effect.service(TestChatApi))
  const summaryCalls: Array<ModelRequest.ModelRequest> = []
  const summaryModel = Model.make({
    stream: request => {
      summaryCalls.push(request)
      return Stream.fromIterable<ModelEvent.ModelEvent>([
        { type: "text-delta", id: "summary", text: SUMMARY },
        { type: "settle", stopReason: "stop" },
      ])
    },
  })
  /** A tab on its own device, as a second browser or a fresh test context is. */
  const tab = async () => {
    const runtime = openTab(api, { host: nodeDevice({ agent: api, summaryModel }), retry: SyncPolicy.backoff({ initial: "20 millis", max: "50 millis" }) })
    opened.push(runtime)
    const chat = await runtime.runPromise(Effect.service(Chat))
    const store = await runtime.runPromise(Effect.service(ChatStore))
    for (const query of [store.shown, store.latest]) query.tanstack.startSyncImmediate()
    const answers = () => chat.queries.conversation.toArray.filter(row => row.role === "assistant")
    return { runtime, chat, answers }
  }

  const a = await tab()
  const ask = async (text: string) => {
    const asked = await a.chat.actions.ask(text)
    if (!asked.asked) throw new Error(asked.reason)
    const agent = await root.runPromise(api.attachFor(asked.questionId))
    expect(await agent.respond(ANSWER)).toEqual({ answered: true, answerId: asked.answerId })
    await until(() => expect(a.answers().find(row => row.id === asked.answerId)).toMatchObject({ status: "done", text: ANSWER }))
    return asked.answerId
  }
  /** Every answer `of` shows carries its one recorded summary, made from its content. */
  const summarized = (of: Awaited<ReturnType<typeof tab>>, ids: ReadonlyArray<string>) => until(() => {
    const rows = of.answers().filter(row => ids.includes(row.id))
    expect(rows).toHaveLength(ids.length)
    // A missing summary says how far it got: the model calls made and the server's claims and records.
    const claims = api.spans.filter(span => span.name === "timeline.summary.claim").map(span => Object.fromEntries(span.attributes))
    for (const row of rows) expect(row, JSON.stringify({ calls: summaryCalls.length, claims })).toMatchObject({ summary: SUMMARY, summaryRevision: revisionOf(row) })
  })

  // An idle page: one finished exchange, then a second tab on another device opens the conversation and both sit.
  const first = await ask("Did the release retry?")
  await summarized(a, [first])
  const b = await tab()
  await summarized(b, [first])
  await a.runtime.runPromise(Effect.sleep("1500 millis"))
  expect(summaryCalls.length).toBe(2)

  // The page receives four more messages (two exchanges), shown in both tabs.
  const more = [await ask("Did the deploy retry?"), await ask("Did the docs build retry?")]
  await summarized(a, [first, ...more])
  await summarized(b, [first, ...more])
  await a.runtime.runPromise(Effect.sleep("1500 millis"))
  // Six messages arrived in all; one call each, however many tabs show them.
  expect(summaryCalls.length).toBe(6)
  for (const call of summaryCalls) {
    expect(call.modelId).toBe("summary")
    expect(call.params).toEqual({ maxTokens: SUMMARY_TOKENS })
    expect(call.system.map(part => part.text).join(" ")).toContain("navigation summary")
  }
}, WITHIN)
