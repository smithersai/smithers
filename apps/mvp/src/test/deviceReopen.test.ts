import { Effect, ManagedRuntime } from "effect"
import { afterEach, expect, test } from "vitest"
import { appLayer, realServices } from "../boot"
import { Chat } from "../features/chat/chat"
import { ChatStore } from "../features/chat/store"
import { nodeDevice } from "./chatApi"

const closing: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of closing.splice(0).reverse()) await runtime.dispose() })

test("late callbacks on a closed SQLite connection cannot block the next device turn", async () => {
  const host = nodeDevice()
  const open = async () => {
    const options = { origin: "http://offline.test", host, fetch: (() => Promise.reject(new TypeError("offline"))) as typeof fetch, reload: () => {} }
    const runtime = ManagedRuntime.make(appLayer(options, realServices(options)))
    closing.push(runtime)
    const chat = await runtime.runPromise(Effect.service(Chat))
    const store = await runtime.runPromise(Effect.service(ChatStore))
    chat.queries.composer.startSyncImmediate()
    await runtime.runPromise(store.drafts.restored)
    await chat.actions.show("branch-draft")
    return { runtime, chat, store }
  }
  const first = await open()
  await first.runtime.runPromise(first.store.drafts.insert({ id: "branch-draft", text: "Kept through three opens" }).pipe(Effect.flatMap(write => write.persisted)))
  await first.runtime.dispose()
  const second = await open()
  await second.runtime.dispose()
  const third = await open()
  expect(third.chat.queries.composer.toArray[0]?.draft).toBe("Kept through three opens")
}, 90_000)
