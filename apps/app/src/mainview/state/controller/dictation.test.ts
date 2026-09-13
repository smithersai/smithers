import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createDictation, type DictationRecognition } from "./dictation"

const setup = async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: key => { data.delete(key) }
  } })
  let starts = 0, stops = 0, aborts = 0
  const recognition: DictationRecognition = {
    continuous: false, interimResults: false, lang: "", onresult: null, onerror: null, onend: null,
    start: () => { starts++ }, stop: () => { stops++ }, abort: () => { aborts++ }
  }
  return { store, recognition, control: createDictation(store, () => recognition), counts: () => ({ starts, stops, aborts }) }
}

test("dictation appends final speech to the current draft without sending, and stops on request", async () => {
  const { store, recognition, control, counts } = await setup()
  store.dispatch({ type: "composer.changed", actor: "user", draft: "Please" })
  control.toggle()
  expect(store.session().dictating).toBe(true)
  store.dispatch({ type: "composer.changed", actor: "user", draft: "Please check" })
  recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "the issue" } }] })
  expect(store.session().draft).toBe("Please check the issue")
  expect([...store.collections.messages.values()]).toHaveLength(0)
  control.toggle()
  expect(counts()).toEqual({ starts: 1, stops: 1, aborts: 0 })
  recognition.onend?.()
  expect(store.session().dictating).toBe(false)
})

test("cancel ignores late results and permission denial resets microphone state", async () => {
  const { store, recognition, control, counts } = await setup()
  control.toggle()
  const late = recognition.onresult
  control.cancel()
  late?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "late" } }] })
  expect(store.session().draft).toBe("")
  expect(store.session().dictating).toBe(false)
  control.toggle()
  recognition.onerror?.({ error: "not-allowed" })
  expect(store.session().dictating).toBe(false)
  expect([...store.collections.toasts.values()].some(toast => toast.title.includes("denied"))).toBe(true)
  expect(counts().aborts).toBe(2)
})

test("unsupported speech and synchronous start failure report a useful error", async () => {
  const { store, recognition } = await setup()
  expect(createDictation(store, () => undefined).toggle()).toContain("unavailable")
  recognition.start = () => { throw new Error("not available") }
  expect(createDictation(store, () => recognition).toggle()).toContain("could not start")
  expect(store.session().dictating).toBe(false)
})
