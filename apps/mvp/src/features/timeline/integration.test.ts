import { SyncPolicy } from "@smthrs/effect-electric"
import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { OPENAI_ORIGIN } from "../../../worker/personal/test/provider.ts"
import { member, nodeDevice, openTab, openTestApp, TestChatApi } from "../../test/chatApi"
import { Chat } from "../chat/chat"
import { ChatStore } from "../chat/store"
import { PersonalModel } from "../personal-model/personalModel"
import { revisionOf } from "./identity"

// The timeline's summaries on ChatApi's real routes and Postgres, with a person's own model (decision 0099) scripted
// at the network: the production path whose calls drained a person's key on smithers.sh on 2026-10-25, when every tab,
// device and fresh browser summarized the same messages again (docs/features/timeline.md#cost).

const opened: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of opened.reverse().splice(0)) await runtime.dispose() })
const until = (check: () => void | Promise<void>) => vi.waitFor(check, { timeout: 30_000, interval: 25 })
const WITHIN = 120_000

/** What the agent answers: more than a label shows, so each answer needs one model summary. */
const ANSWER = "The release retried twice.\nBoth recorded attempts kept the missing projection entry."
/** The agent's reply: its REPL's one cell, which finishes with the answer. */
const CELL = "```cell\nctx.done(" + JSON.stringify(ANSWER) + ")\n```"
const SUMMARY = "Release retry check completed"
const isSummary = (call: { readonly body: Record<string, unknown> } | undefined) => JSON.stringify(call?.body ?? {}).includes("navigation summary")

test("an idle page and a page receiving N messages cause at most N summary calls in total, across two tabs", async () => {
  let api: TestChatApi["Service"] | undefined
  const root = openTestApp({ answers: false }, {
    actor: member,
    provider: (index) => isSummary(api?.providerCalls[index]) ? { text: SUMMARY } : { text: CELL },
  })
  opened.push(root)
  api = await root.runPromise(Effect.service(TestChatApi))
  const summaryCalls = () => api!.providerCalls.filter(isSummary).length
  /** A tab on its own device, as a second browser or a fresh test context is. */
  const tab = async () => {
    const runtime = openTab(api!, { host: nodeDevice({ agent: api! }), retry: SyncPolicy.backoff({ initial: "20 millis", max: "50 millis" }) })
    opened.push(runtime)
    const chat = await runtime.runPromise(Effect.service(Chat))
    const store = await runtime.runPromise(Effect.service(ChatStore))
    for (const query of [store.shown, store.latest]) query.tanstack.startSyncImmediate()
    const answers = () => chat.queries.conversation.toArray.filter(row => row.role === "assistant")
    return { runtime, chat, answers }
  }

  const a = await tab()
  const model = await a.runtime.runPromise(Effect.service(PersonalModel))
  for (const query of Object.values(model.queries)) query.startSyncImmediate()
  expect(model.actions.save({
    keys: [{ protocol: "openai-chat", baseUrl: `${OPENAI_ORIGIN}/v1/`, key: "sk-test-timeline-summaries" }],
    models: { fast: { protocol: "openai-chat", modelId: "gpt-test" } },
  })).toBe(true)
  await until(() => expect(model.queries.form.toArray[0]).toMatchObject({ state: "done" }))

  const ask = async (text: string) => {
    const asked = (await a.chat.actions.ask(text))
    if (!asked.asked) throw new Error(asked.reason)
    await until(() => expect(["done", "failed"]).toContain(a.answers().find(row => row.id === asked.answerId)?.status))
    // A failed answer says which model calls it made, so a red run explains itself.
    const calls = api!.providerCalls.map(call => JSON.stringify(call.body).slice(0, 160))
    expect(a.answers().find(row => row.id === asked.answerId), JSON.stringify(calls)).toMatchObject({ status: "done", text: ANSWER })
    return asked.answerId
  }
  /** Every answer `of` shows carries its one recorded summary, made from its content. */
  const summarized = (of: Awaited<ReturnType<typeof tab>>, ids: ReadonlyArray<string>) => until(() => {
    const rows = of.answers().filter(row => ids.includes(row.id))
    expect(rows).toHaveLength(ids.length)
    // A missing summary says how far it got: the model calls made and the server's claims and records.
    const claims = api!.spans.filter(span => span.name === "timeline.summary.claim").map(span => Object.fromEntries(span.attributes))
    for (const row of rows) expect(row, JSON.stringify({ calls: summaryCalls(), claims })).toMatchObject({ summary: SUMMARY, summaryRevision: revisionOf(row) })
  })

  // An idle page: one finished exchange, then a second tab on another device opens the conversation and both sit.
  const first = await ask("Did the release retry?")
  await summarized(a, [first])
  const b = await tab()
  await summarized(b, [first])
  await a.runtime.runPromise(Effect.sleep("1500 millis"))
  expect(summaryCalls()).toBe(1)

  // The page receives four more messages (two exchanges), shown in both tabs.
  const more = [await ask("Did the deploy retry?"), await ask("Did the docs build retry?")]
  await summarized(a, [first, ...more])
  await summarized(b, [first, ...more])
  await a.runtime.runPromise(Effect.sleep("1500 millis"))
  // Six messages arrived in all; one call per finished answer, and each question keeps its own words for free.
  expect(summaryCalls()).toBeLessThanOrEqual(6)
  expect(summaryCalls()).toBe(3)
  // Each call went to the person's own key, with no reasoning effort and a one-line budget.
  for (const call of api.providerCalls.filter(isSummary)) {
    expect(call.headers.get("authorization")).toBe("Bearer sk-test-timeline-summaries")
    expect(call.body).not.toHaveProperty("reasoning_effort")
  }
}, WITHIN)
