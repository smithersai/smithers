import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { initialGuide } from "./AppState"
import { memoryStorage } from "./TestFixtures"
test("accepted messages keep Chat open; empty or busy submissions preserve the open draft", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), conversationOpen: true } }).isPersisted.promise
  await store.dispatch({ type: "palette.toggled", actor: "user", open: true }).isPersisted.promise
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "hello" }).isPersisted.promise
  await store.dispatch({ type: "message.submitted", actor: "user", turnId: "blank", text: " " }).isPersisted.promise
  expect(store.session().guide?.conversationOpen).toBe(true)
  expect(store.session().draft).toBe("hello")
  await store.dispatch({ type: "message.submitted", actor: "user", turnId: "first", text: "hello" }).isPersisted.promise
  expect(store.session().guide?.conversationOpen).toBe(true)
  expect(store.session().draft).toBe("")
  expect(store.session().paletteOpen).toBe(false)
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...store.session().guide!, conversationOpen: true } }).isPersisted.promise
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "later" }).isPersisted.promise
  await store.dispatch({ type: "message.submitted", actor: "user", turnId: "busy", text: "later" }).isPersisted.promise
  expect(store.session().guide?.conversationOpen).toBe(true)
  expect(store.session().draft).toBe("later")
  await store.dispatch({ type: "message.steered", actor: "user", turnId: "first", text: "later" }).isPersisted.promise
  expect(store.session().guide?.conversationOpen).toBe(true)
})

test("tutorial chat placement survives a concurrent guide update and reload", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "guide.visibility.changed", actor: "system", visible: true }).isPersisted.promise
  const guide = { ...initialGuide(), step: 2, conversationOpen: true }
  await store.dispatch({ type: "guide.changed", actor: "user", guide }).isPersisted.promise
  await store.dispatch({ type: "message.submitted", actor: "user", turnId: "chat", text: "Explain" }).isPersisted.promise
  await store.dispatch({ type: "message.response.delta", actor: "smithers", turnId: "chat", channel: "text", delta: "Here is the answer." }).isPersisted.promise
  // This producer captured the guide before the reply arrived.
  await store.dispatch({ type: "guide.changed", actor: "system", guide: { ...guide, step: 3 } }).isPersisted.promise
  const placement = store.session().guide?.transcript
  expect(placement?.['message-chat-user']).toEqual({ step: 2, source: "chat", owned: true })
  expect(placement?.['message-chat-smithers']).toEqual({ step: 2, source: "chat", owned: true })
  const reloaded = await createAppStore({ kind: "localStorage", storage })
  expect(reloaded.session().guide?.transcript).toEqual(placement)
})
