import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { initialGuide } from "./AppState"
import { memoryStorage } from "./TestFixtures"
test("accepted messages close Chat; empty or busy submissions preserve the open draft", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), conversationOpen: true } }).isPersisted.promise
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "hello" }).isPersisted.promise
  await store.dispatch({ type: "message.submitted", actor: "user", turnId: "blank", text: " " }).isPersisted.promise
  expect(store.session().guide?.conversationOpen).toBe(true)
  expect(store.session().draft).toBe("hello")
  await store.dispatch({ type: "message.submitted", actor: "user", turnId: "first", text: "hello" }).isPersisted.promise
  expect(store.session().guide?.conversationOpen).toBe(false)
  expect(store.session().draft).toBe("")
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...store.session().guide!, conversationOpen: true } }).isPersisted.promise
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "later" }).isPersisted.promise
  await store.dispatch({ type: "message.submitted", actor: "user", turnId: "busy", text: "later" }).isPersisted.promise
  expect(store.session().guide?.conversationOpen).toBe(true)
  expect(store.session().draft).toBe("later")
  await store.dispatch({ type: "message.steered", actor: "user", turnId: "first", text: "later" }).isPersisted.promise
  expect(store.session().guide?.conversationOpen).toBe(false)
})
