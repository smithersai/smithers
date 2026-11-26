import { Collection } from "@smthrs/effect-tanstack-db"
import { ask } from "./actions"
import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { boundFetch } from "../../device/identity.vibe"
import { member, nodeDevice, openTab, openTestApi, TestChatApi } from "../../test/chatApi"
import { Chat } from "./chat"
import { QUESTIONS_ROUTE } from "./contract"
import { ChatStore } from "./store"

const runtimes: { dispose(): Promise<void> }[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose() })

test("a missing conversation leaves its question unsent after a single HTTP refusal", async () => {
  const server = openTestApi()
  runtimes.push(server)
  const api = await server.runPromise(Effect.service(TestChatApi))
  const tab = openTab(api, { host: nodeDevice() })
  runtimes.push(tab)
  const chat = await tab.runPromise(Effect.service(Chat))
  const store = await tab.runPromise(Effect.service(ChatStore))
  await chat.actions.show(crypto.randomUUID())
  const asked = await chat.actions.ask("missing conversation")
  if (!asked.asked) throw new Error(asked.reason)
  await vi.waitFor(() => expect(store.unsent.tanstack.get(asked.questionId)).toMatchObject({ reason: "refused" }))
  expect(api.questionStatuses()).toEqual([404])
  expect(store.asking.tanstack.has(asked.questionId)).toBe(false)
})

test("a malformed credential gate is repaired before posting a question", async () => {
  const server = openTestApi()
  runtimes.push(server)
  const api = await server.runPromise(Effect.service(TestChatApi))
  const storage = nodeDevice().outbox.storage
  const person = member.subject.id
  const key = `outbox:credential:${person}`
  await storage.set(key, "{")
  const transport = boundFetch(api.fetch, { origin: api.origin, principal: () => person, credentialStorage: storage })
  const result = await transport(api.origin + QUESTIONS_ROUTE, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "a real question" }),
  })
  expect(result.ok).toBe(true)
  expect(JSON.parse((await storage.get(key))!)).toMatchObject({ until: 0, revision: expect.any(String) })
  expect(api.questionStatuses()).toEqual([result.status])
})

test("a failed unsent restore still admits the question to the offline outbox", async () => {
  const server = openTestApi()
  runtimes.push(server)
  const api = await server.runPromise(Effect.service(TestChatApi))
  const base = nodeDevice()
  const tab = openTab(api, { host: { ...base, outbox: {
    ...base.outbox, online: { ...base.outbox.online, isOnline: () => false },
  } } })
  runtimes.push(tab)
  const store = await tab.runPromise(Effect.service(ChatStore))
  const result = await tab.runPromise(ask("keep this question").pipe(Effect.provideService(ChatStore, {
    ...store, unsent: { ...store.unsent, restored: Effect.fail(new Collection.LoadFailed({ cause: "storage unavailable" })) },
  })))
  expect(result.asked).toBe(true)
  if (result.asked) expect(store.asking.tanstack.get(result.questionId)).toMatchObject({ text: "keep this question" })
})
