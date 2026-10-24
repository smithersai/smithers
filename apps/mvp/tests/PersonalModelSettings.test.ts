// @vitest-environment happy-dom
import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Exit, Scope } from "effect"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test } from "vitest"
import { PersonalModelProvider } from "../src/features/personal-model/components/PersonalModelContext"
import { PersonalModelSettings } from "../src/features/personal-model/components/PersonalModelSettings"
import type { PersonalModelView } from "../src/features/personal-model/personalModel"
import { formQuery, hiddenQuery, rowQuery, testQuery } from "../src/features/personal-model/queries"
import { Form, Hidden, PersonalModelRow, TestRow } from "../src/features/personal-model/schema"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// The Your model section (docs/features/personal-model.md#the-settings-section): the real React view and live queries
// over row fixtures, without a network or module replacements. What Save, Test and Remove receive is kept at the view's
// output boundary.
const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

const SAVED: PersonalModelRow = {
  personId: "person-member",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  modelId: "claude-test",
  keyLast4: "x7Qz",
  failureStatus: null,
  failedAt: null,
  updatedAt: "2026-10-24T10:00:00.000Z",
}

const section = async (initial: ReadonlyArray<PersonalModelRow>) => {
  const scope = Effect.runSync(Scope.make())
  disposals.push(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const built = await Effect.runPromise(Scope.provide(scope)(Effect.gen(function* () {
    const rows = yield* Collection.local({
      id: "settings-personal-model", schema: PersonalModelRow, getKey: (row) => row.personId, initialData: initial,
    })
    const form = yield* Collection.local({ id: "settings-personal-model-form", schema: Form, getKey: (row) => row.id })
    const tests = yield* Collection.local({ id: "settings-personal-model-test", schema: TestRow, getKey: (row) => row.id })
    const hidden = yield* Collection.local({ id: "settings-personal-model-hidden", schema: Hidden, getKey: (row) => row.id })
    const queries: PersonalModelView["queries"] = {
      row: (yield* rowQuery(rows)).tanstack,
      form: (yield* formQuery(form)).tanstack,
      test: (yield* testQuery(tests)).tanstack,
      hidden: (yield* hiddenQuery(hidden)).tanstack,
    }
    return { rows, form, queries }
  })))
  const pressed: Array<string> = []
  const saved: Array<ReadonlyArray<string>> = []
  const view: PersonalModelView = {
    queries: built.queries,
    actions: {
      save: (...fields) => {
        saved.push(fields)
        return true
      },
      remove: () => {
        pressed.push("remove")
        return true
      },
      test: () => {
        pressed.push("test")
        return true
      },
      hide: () => {
        throw new Error("Settings has no Hide")
      },
    },
  }
  const container = document.createElement("div")
  document.body.append(container)
  let root: Root
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(PersonalModelProvider, { value: view }, createElement(PersonalModelSettings)))
  })
  disposals.push(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!
  const buttons = () => [...container.querySelectorAll("button")].filter((button) => button.type === "submit" || button.type === "button")
    .map((button) => button.textContent)
  return { ...built, run, container, saved, pressed, input, buttons, status: () => container.querySelector('[role="status"]')! }
}

test("with no model: labeled fields, a password key with no placeholder, Save alone, and Enter saves what was typed", async () => {
  const tab = await section([])
  expect(tab.container.querySelector("h2")?.textContent).toBe("Your model")
  for (const [id, label] of [
    ["personal-model-protocol", "Protocol"],
    ["personal-model-base-url", "Base URL"],
    ["personal-model-model", "Model"],
    ["personal-model-key", "Key"],
  ]) {
    expect(tab.container.querySelector(`label[for="${id}"]`)?.textContent).toBe(label)
    expect(tab.container.querySelector(`#${id}`)).not.toBeNull()
  }
  expect(tab.input("personal-model-base-url").placeholder).toBe("https://api.openai.com")
  const key = tab.input("personal-model-key")
  expect([key.type, key.autocomplete, key.placeholder, key.required]).toEqual(["password", "off", "", true])
  expect(tab.container.querySelector("#personal-model-protocol")?.textContent).toContain("OpenAI-compatible")
  expect(tab.buttons().filter((text) => ["Save", "Test", "Remove"].includes(text!))).toEqual(["Save"])
  expect(tab.status().textContent).toBe("")

  tab.input("personal-model-base-url").value = "https://openrouter.ai/api"
  tab.input("personal-model-model").value = "qwen-test"
  key.value = "sk-or-SENTINEL"
  await act(async () => key.form!.requestSubmit())
  expect(tab.saved).toEqual([["openai-chat", "https://openrouter.ai/api", "qwen-test", "sk-or-SENTINEL"]])
})

test("with a saved model: its values until edited, the key's tail, Test and Remove; Saving waits", async () => {
  const tab = await section([SAVED])
  expect(tab.input("personal-model-base-url").value).toBe("https://api.anthropic.com")
  expect(tab.input("personal-model-model").value).toBe("claude-test")
  expect(tab.input("personal-model-key").value).toBe("")
  expect(tab.input("personal-model-key").placeholder).toBe("····x7Qz")
  expect(tab.container.querySelector("#personal-model-protocol")?.textContent).toContain("Anthropic-compatible")
  expect(tab.buttons().filter((text) => ["Save", "Test", "Remove"].includes(text!))).toEqual(["Save", "Test", "Remove"])

  // An edit survives a synced change; an untouched field follows it.
  const model = tab.input("personal-model-model")
  model.value = "claude-draft"
  await act(async () => {
    await tab.run(tab.rows.update("person-member", (row) => {
      row.baseUrl = "https://anthropic.example.com"
      row.modelId = "claude-remote"
      row.updatedAt = "2026-10-24T10:01:00.000Z"
    }))
  })
  expect(tab.input("personal-model-base-url").value).toBe("https://anthropic.example.com")
  expect(tab.input("personal-model-model").value).toBe("claude-draft")

  for (const label of ["Test", "Remove"]) {
    await act(async () => [...tab.container.querySelectorAll("button")].find((button) => button.textContent === label)!.click())
  }
  expect(tab.pressed).toEqual(["test", "remove"])

  // A save on its way: Saving, and every button waits.
  await act(async () => {
    await tab.run(tab.form.insert({
      id: "form", op: "save", state: "confirming", failure: null, before: null, sent: null, saved: 0, quiet: false,
    }))
  })
  expect(tab.status().textContent).toBe("Saving")
  const waiting = [...tab.container.querySelectorAll("button")].filter((button) => ["Save", "Test", "Remove"].includes(button.textContent!))
  expect(waiting.map((button) => button.disabled)).toEqual([true, true, true])
})

test("a refused key shows the provider's host and status, and when", async () => {
  const tab = await section([{ ...SAVED, failureStatus: 429, failedAt: new Date(Date.now() - 120_000).toISOString() }])
  expect(tab.status().textContent).toMatch(/^api\.anthropic\.com refused · HTTP 429 · .+/)
  expect(tab.status().querySelector("time")).not.toBeNull()
})
