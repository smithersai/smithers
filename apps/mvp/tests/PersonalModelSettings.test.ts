// @vitest-environment happy-dom
import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Exit, Scope } from "effect"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test } from "vitest"
import { PersonalModelProvider } from "../src/features/personal-model/components/PersonalModelContext"
import { PersonalModelSettings } from "../src/features/personal-model/components/PersonalModelSettings"
import { MODEL_TIERS } from "../src/features/model/contract"
import { PROTOCOLS, resolveTier } from "../src/features/personal-model/contract"
import { tierKeyLabel } from "../src/features/personal-model/copy"
import type { PersonalModelView } from "../src/features/personal-model/personalModel"
import { formQuery, rowsQuery, testQuery } from "../src/features/personal-model/queries"
import { Form, PersonalModelRow, TestRow } from "../src/features/personal-model/schema"
import type { SaveForm } from "../src/features/personal-model/view"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// The Your model section (docs/features/personal-model.md#the-settings-section): the real React view and live queries
// over saved-key fixtures, one row per protocol, without a network or module replacements. What Save, Test and Remove
// receive is kept at the view's output boundary.
const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

/** The Anthropic-compatible key, Fast named on it. */
const SAVED: PersonalModelRow = {
  personId: "person-member",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  fastModel: "claude-test",
  implementModel: null,
  hardModel: null,
  keyLast4: "x7Qz",
  failureStatus: null,
  failedAt: null,
  updatedAt: "2026-10-24T10:00:00.000Z",
}

/** The OpenAI-compatible key, Implement named on it. */
const OPENAI: PersonalModelRow = {
  ...SAVED,
  protocol: "openai-chat",
  baseUrl: "https://api.openai.com",
  fastModel: null,
  implementModel: "gpt-test",
  keyLast4: "a1B2",
}

const section = async (initial: ReadonlyArray<PersonalModelRow>, canSave = true) => {
  const scope = Effect.runSync(Scope.make())
  disposals.push(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const built = await Effect.runPromise(Scope.provide(scope)(Effect.gen(function* () {
    const rows = yield* Collection.local({
      id: "settings-personal-model",
      schema: PersonalModelRow,
      getKey: (row) => `${row.personId}:${row.protocol}`,
      initialData: initial,
    })
    const form = yield* Collection.local({ id: "settings-personal-model-form", schema: Form, getKey: (row) => row.id })
    const tests = yield* Collection.local({ id: "settings-personal-model-test", schema: TestRow, getKey: (row) => row.id })
    const queries: PersonalModelView["queries"] = {
      saved: (yield* rowsQuery(rows)).tanstack,
      form: (yield* formQuery(form)).tanstack,
      test: (yield* testQuery(tests)).tanstack,
    }
    return { rows, form, queries }
  })))
  const pressed: Array<string> = []
  const saved: Array<SaveForm> = []
  const tested: Array<SaveForm | undefined> = []
  const view: PersonalModelView = {
    queries: built.queries,
    actions: {
      save: (form) => {
        saved.push(form)
        return true
      },
      remove: () => {
        pressed.push("remove")
        return true
      },
      test: (draft) => {
        tested.push(draft)
        pressed.push("test")
        return true
      },
    },
  }
  const container = document.createElement("div")
  document.body.append(container)
  let root: Root
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(PersonalModelProvider, { value: view }, createElement(PersonalModelSettings, { canSave })))
  })
  disposals.push(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!
  const buttons = () =>
    [...container.querySelectorAll("button")].map((button) => button.textContent).filter((text) =>
      ["Save", "Test", "Remove"].includes(text!)
    )
  /** A tier's key select, by its accessible name: it shows the protocol it is on. */
  const select = (name: string) => container.querySelector(`[aria-label="${name}"]`)
  const submit = () => act(async () => input("personal-model-fast").form!.requestSubmit())
  return {
    ...built,
    run,
    container,
    saved,
    tested,
    pressed,
    input,
    buttons,
    select,
    submit,
    status: () => container.querySelector('[role="status"]')!,
  }
}

test("with no key: each protocol's labeled Base URL and password Key, the tiers and their keys, Save alone; Enter saves what was typed", async () => {
  const tab = await section([])
  expect(tab.container.querySelector("h2")?.textContent).toBe("Your model")
  expect([...tab.container.querySelectorAll("fieldset legend")].map((legend) => legend.textContent)).toEqual([
    "OpenAI-compatible",
    "Anthropic-compatible",
  ])
  for (const [protocol, example] of [["openai-chat", "https://api.openai.com"], ["anthropic-messages", "https://api.anthropic.com"]]) {
    expect(tab.container.querySelector(`label[for="personal-model-${protocol}-base-url"]`)?.textContent).toBe("Base URL")
    expect(tab.container.querySelector(`label[for="personal-model-${protocol}-key"]`)?.textContent).toBe("Key")
    expect(tab.input(`personal-model-${protocol}-base-url`).placeholder).toBe(example)
    const key = tab.input(`personal-model-${protocol}-key`)
    expect([key.type, key.autocomplete, key.placeholder, key.required]).toEqual(["password", "off", "", false])
  }
  for (const [tier, label] of [["fast", "Fast"], ["implement", "Implement"], ["hard", "Hard"]]) {
    expect(tab.container.querySelector(`label[for="personal-model-${tier}"]`)?.textContent).toBe(label)
    expect([tab.input(`personal-model-${tier}`).value, tab.input(`personal-model-${tier}`).placeholder]).toEqual(["", ""])
    // With no key saved, a tier starts on the first protocol.
    expect(tab.select(`${label} key`)?.textContent).toContain("OpenAI-compatible")
  }
  expect(tab.buttons()).toEqual(["Save"])
  expect(tab.status().textContent).toBe("")

  tab.input("personal-model-openai-chat-base-url").value = "https://openrouter.ai/api"
  tab.input("personal-model-openai-chat-key").value = "sk-or-SENTINEL"
  tab.input("personal-model-fast").value = "qwen-test"
  await tab.submit()
  // The empty Anthropic-compatible group and the empty tiers send nothing.
  expect(tab.saved).toEqual([{
    keys: [{ protocol: "openai-chat", baseUrl: "https://openrouter.ai/api", key: "sk-or-SENTINEL" }],
    models: { fast: { protocol: "openai-chat", modelId: "qwen-test" } },
  }])
})

test("with saved keys: base URLs and named models until edited, each key's tail, an empty tier's model, Test and Remove; Saving waits", async () => {
  const rows = [SAVED, OPENAI]
  const tab = await section(rows)
  expect(tab.input("personal-model-anthropic-messages-base-url").value).toBe("https://api.anthropic.com")
  expect(tab.input("personal-model-openai-chat-base-url").value).toBe("https://api.openai.com")
  expect([tab.input("personal-model-anthropic-messages-key").value, tab.input("personal-model-openai-chat-key").value])
    .toEqual(["", ""])
  expect(tab.input("personal-model-anthropic-messages-key").placeholder).toBe("····x7Qz")
  expect(tab.input("personal-model-openai-chat-key").placeholder).toBe("····a1B2")
  expect(tab.input("personal-model-fast").value).toBe("claude-test")
  expect(tab.input("personal-model-implement").value).toBe("gpt-test")
  // Hard names no model: its placeholder is the one it uses anyway, here the preset at the Anthropic-compatible key's host.
  expect(tab.input("personal-model-hard").value).toBe("")
  expect(tab.input("personal-model-hard").placeholder).toBe(`Default: ${resolveTier(rows, "hard")!.modelId}`)
  expect(tab.input("personal-model-hard").placeholder).toBe("Default: claude-opus-5-5")
  expect(MODEL_TIERS.map((tier) => tab.select(tierKeyLabel(tier))?.textContent)).toEqual([
    "Anthropic-compatible",
    "OpenAI-compatible",
    "Anthropic-compatible",
  ])
  expect(tab.buttons()).toEqual(["Save", "Test", "Remove"])

  // An edit survives a synced change; an untouched field follows it.
  tab.input("personal-model-fast").value = "claude-draft"
  await act(async () => {
    await tab.run(tab.rows.update("person-member:anthropic-messages", (row) => {
      row.baseUrl = "https://anthropic.example.com"
      row.fastModel = "claude-remote"
      row.updatedAt = "2026-10-24T10:01:00.000Z"
    }))
  })
  expect(tab.input("personal-model-anthropic-messages-base-url").value).toBe("https://anthropic.example.com")
  expect(tab.input("personal-model-fast").value).toBe("claude-draft")

  // Save with the keys left empty keeps both saved keys; each named tier goes on its select's key.
  await tab.submit()
  expect(tab.saved).toEqual([{
    keys: PROTOCOLS.map((protocol) => ({
      protocol,
      baseUrl: protocol === "openai-chat" ? "https://api.openai.com" : "https://anthropic.example.com",
      key: "",
    })),
    models: {
      fast: { protocol: "anthropic-messages", modelId: "claude-draft" },
      implement: { protocol: "openai-chat", modelId: "gpt-test" },
    },
  }])

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
  const tab = await section([OPENAI, { ...SAVED, failureStatus: 429, failedAt: new Date(Date.now() - 120_000).toISOString() }])
  expect(tab.status().textContent).toMatch(/^api\.anthropic\.com refused · HTTP 429 · .+/)
  expect(tab.status().querySelector("time")).not.toBeNull()
})

test("someone who may no longer save sees Remove alone while a key is saved, and nothing once it is gone", async () => {
  const saved = await section([SAVED], false)
  const region = saved.container.querySelector('section[aria-label="Your model"]')!
  expect(region).not.toBeNull()
  expect(region.querySelector("form")).toBeNull()
  expect(region.querySelector("input")).toBeNull()
  expect([...region.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Remove"])
  await act(async () => void region.querySelector("button")!.click())
  expect(saved.pressed).toEqual(["remove"])
  const none = await section([], false)
  expect(none.container.innerHTML).toBe("")
})


test("Test submits the visible draft, including unsaved keys, only to the synchronous validation boundary", async () => {
  const tab = await section([OPENAI])
  tab.input("personal-model-openai-chat-base-url").value = "not a url"
  tab.input("personal-model-openai-chat-key").value = "sk-unsaved-key-sentinel"
  const button = [...tab.container.querySelectorAll("button")].find((button) => button.textContent === "Test")!
  await act(async () => button.click())
  expect(tab.tested).toEqual([{
    keys: [{ protocol: "openai-chat", baseUrl: "not a url", key: "sk-unsaved-key-sentinel" }],
    models: { implement: { protocol: "openai-chat", modelId: "gpt-test" } },
  }])
  expect(tab.saved).toEqual([])
})


test("provider fields have distinct accessible names without relying on group context", async () => {
  const tab = await section([])
  for (const [protocol, label] of [["openai-chat", "OpenAI-compatible"], ["anthropic-messages", "Anthropic-compatible"]]) {
    expect(tab.input(`personal-model-${protocol}-base-url`).getAttribute("aria-label")).toBe(`${label} Base URL`)
    expect(tab.input(`personal-model-${protocol}-key`).getAttribute("aria-label")).toBe(`${label} Key`)
  }
})


test("each tier names its purpose beside its model and describes the input", async () => {
  const tab = await section([])
  for (const [tier, purpose] of [["fast", "Chat"], ["implement", "Code"], ["hard", "Plans & reviews"]]) {
    const input = tab.input(`personal-model-${tier}`)
    const description = tab.container.querySelector(`#${input.getAttribute("aria-describedby")}`)
    expect(description?.textContent).toBe(purpose)
  }
})
