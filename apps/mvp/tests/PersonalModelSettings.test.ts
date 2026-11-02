// @vitest-environment happy-dom
import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Exit, Scope } from "effect"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test } from "vitest"
import { PersonalModelProvider } from "../src/features/personal-model/components/PersonalModelContext"
import { PersonalModelSettings } from "../src/features/personal-model/components/PersonalModelSettings"
import type { ConnectionPut } from "../src/features/personal-model/contract"
import { CLAUDE_COMMAND, KIND_LABEL } from "../src/features/personal-model/copy"
import type { PersonalModelView } from "../src/features/personal-model/personalModel"
import { addQuery, formQuery, linkQuery, rowsQuery, testQuery } from "../src/features/personal-model/queries"
import { ADD, AddRow, type AddView, Form, LinkRow, PersonalModelRow, TestRow } from "../src/features/personal-model/schema"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// The Your model section (decision 0132, docs/features/personal-model.md#the-settings-section): the real React view and
// live queries over saved-connection fixtures, without a network or module replacements. Add's menu and forms run on the
// same row the page's `showAdd` writes; what each press sends is kept at the view's output boundary.
const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  document.body.innerHTML = ""
})

/** An Anthropic-compatible API key, Fast named on it. */
const SAVED: PersonalModelRow = {
  personId: "person-member",
  id: "connection-anthropic",
  kind: "api_key",
  position: 0,
  active: true,
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

/** A Claude subscription, off: it has no base URL, so its last characters name it, and it can't be tested from here. */
const CLAUDE: PersonalModelRow = {
  ...SAVED,
  id: "connection-claude",
  kind: "claude_subscription",
  position: 1,
  active: false,
  protocol: null,
  baseUrl: null,
  fastModel: null,
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
      getKey: (row) => row.id,
      initialData: initial,
    })
    const form = yield* Collection.local({ id: "settings-personal-model-form", schema: Form, getKey: (row) => row.id })
    const tests = yield* Collection.local({ id: "settings-personal-model-test", schema: TestRow, getKey: (row) => row.id })
    const add = yield* Collection.local({
      id: "settings-personal-model-add",
      schema: AddRow,
      getKey: (row) => row.id,
      initialData: [{ id: ADD, view: "closed" }],
    })
    const link = yield* Collection.local({ id: "settings-personal-model-link", schema: LinkRow, getKey: (row) => row.id })
    const queries: PersonalModelView["queries"] = {
      saved: (yield* rowsQuery(rows)).tanstack,
      form: (yield* formQuery(form)).tanstack,
      test: (yield* testQuery(tests)).tanstack,
      add: (yield* addQuery(add)).tanstack,
      link: (yield* linkQuery(link)).tanstack,
    }
    return { rows, form, add, queries }
  })))
  const pressed: Array<unknown> = []
  const added: Array<ConnectionPut> = []
  const press = (...entry: ReadonlyArray<unknown>) => {
    pressed.push(entry)
    return true
  }
  const view: PersonalModelView = {
    queries: built.queries,
    actions: {
      save: (form) => press("save", form),
      add: (connection) => {
        added.push(connection)
        return true
      },
      setActive: (id, active) => press("setActive", id, active),
      move: (id, by) => press("move", id, by),
      remove: (id) => press("remove", id),
      removeAll: () => press("removeAll"),
      test: (connection, draft) => press("test", connection, draft),
      showAdd: (shown: AddView) => void Effect.runSync(built.add.update(ADD, (row) => { row.view = shown })),
      link: () => press("link"),
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
  /** Add's menu and its dialog portal to the body. */
  const button = (name: string, within: ParentNode = document.body) =>
    [...within.querySelectorAll("button")].find((each) => each.textContent === name || each.getAttribute("aria-label") === name)!
  const click = (element: HTMLElement) => act(async () => element.click())
  const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!
  const row = (name: string) => container.querySelector<HTMLElement>(`li[aria-label="${name}"]`)!
  return {
    ...built,
    run,
    container,
    pressed,
    added,
    button,
    click,
    input,
    row,
    open: async (kind: keyof typeof KIND_LABEL) => {
      await click(button("Add", container))
      await click(button(KIND_LABEL[kind]))
    },
  }
}

test("with no connection: the heading and Add alone; Add offers the five kinds", async () => {
  const tab = await section([])
  expect(tab.container.querySelector("h2")?.textContent).toBe("Your model")
  expect(tab.container.querySelector("ol")).toBeNull()
  expect([...tab.container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Add"])
  expect(tab.container.querySelector('[role="status"]')?.textContent).toBe("")
  await tab.click(tab.button("Add", tab.container))
  expect(Object.values(KIND_LABEL).map((label) => tab.button(label)?.textContent)).toEqual([
    "API key",
    "Kimi K3",
    "Claude subscription",
    "Codex subscription",
    "Jev",
  ])
})

test("an API key's form: labeled Protocol, Base URL, password Key and tiers; Save reads what was typed", async () => {
  const tab = await section([])
  await tab.open("api_key")
  const form = document.querySelector<HTMLFormElement>('form[aria-label="API key"]')!
  expect(form).not.toBeNull()
  expect(form.querySelector('[aria-labelledby="personal-model-protocol"]')?.textContent).toContain("OpenAI-compatible")
  expect(document.querySelector('label[for="personal-model-base-url"]')?.textContent).toBe("Base URL")
  expect(document.querySelector('label[for="personal-model-key"]')?.textContent).toBe("Key")
  const key = tab.input("personal-model-key")
  expect([key.type, key.autocomplete, key.value]).toEqual(["password", "off", ""])
  for (const [tier, label, purpose] of [["fast", "Fast", "Chat"], ["implement", "Implement", "Coding"], ["hard", "Hard", "Plans and reviews"]]) {
    const input = tab.input(`personal-model-${tier}`)
    expect(document.querySelector(`label[for="personal-model-${tier}"]`)?.textContent).toBe(label)
    expect(document.querySelectorAll(`#${input.getAttribute("aria-describedby")}`)).toHaveLength(1)
    expect(document.querySelector(`#${input.getAttribute("aria-describedby")}`)?.textContent).toBe(purpose)
  }
  tab.input("personal-model-base-url").value = "https://openrouter.ai/api"
  key.value = "sk-or-SENTINEL"
  tab.input("personal-model-fast").value = "qwen-test"
  await act(async () => form.requestSubmit())
  // The empty tiers send nothing.
  expect(tab.added).toEqual([{
    kind: "api_key",
    protocol: "openai-chat",
    baseUrl: "https://openrouter.ai/api",
    key: "sk-or-SENTINEL",
    models: { fast: "qwen-test" },
  }])
})

test("Claude's form shows the command and takes the token; Kimi's and Jev's take a key; Codex's links", async () => {
  const claude = await section([])
  await claude.open("claude_subscription")
  expect(document.body.textContent).toContain(CLAUDE_COMMAND)
  expect(document.querySelector('label[for="personal-model-key"]')?.textContent).toBe("Token")
  claude.input("personal-model-key").value = "sk-ant-oat-SENTINEL"
  await act(async () => document.querySelector<HTMLFormElement>('form[aria-label="Claude subscription"]')!.requestSubmit())
  expect(claude.added).toEqual([{ kind: "claude_subscription", key: "sk-ant-oat-SENTINEL" }])
  await claude.run(claude.add.update(ADD, (row) => { row.view = "moonshot" }))
  await act(async () => {})
  expect(document.querySelector('form[aria-label="Kimi K3"] input[type="password"]')).not.toBeNull()
  await claude.run(claude.add.update(ADD, (row) => { row.view = "jev" }))
  await act(async () => {})
  expect(document.querySelector('form[aria-label="Jev"] input[type="password"]')).not.toBeNull()
  await claude.run(claude.add.update(ADD, (row) => { row.view = "codex_subscription" }))
  await act(async () => {})
  await claude.click(claude.button("Link"))
  expect(claude.pressed).toEqual([["link"]])
})

test("saved connections: in order, by host or last characters, each with its controls; every press names its row", async () => {
  const tab = await section([{ ...CLAUDE, position: 1 }, { ...SAVED, position: 0 }])
  expect([...tab.container.querySelectorAll("li")].map((li) => li.getAttribute("aria-label"))).toEqual([
    "API key api.anthropic.com",
    "Claude subscription ····a1B2",
  ])
  const first = tab.row("API key api.anthropic.com")
  const second = tab.row("Claude subscription ····a1B2")
  expect([...first.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Active", "↑", "↓", "Test", "Remove"])
  // Test isn't offered for a Claude subscription, and a row's end stops its Move.
  expect([...second.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Active", "↑", "↓", "Remove"])
  expect([tab.button("Active", first).getAttribute("aria-pressed"), tab.button("Active", second).getAttribute("aria-pressed")])
    .toEqual(["true", "false"])
  expect([tab.button("Move up", first).disabled, tab.button("Move down", first).disabled]).toEqual([true, false])
  expect([tab.button("Move up", second).disabled, tab.button("Move down", second).disabled]).toEqual([false, true])

  await tab.click(tab.button("Active", first))
  await tab.click(tab.button("Move down", first))
  await tab.click(tab.button("Move up", second))
  await tab.click(tab.button("Test", first))
  await tab.click(tab.button("Remove", second))
  expect(tab.pressed).toEqual([
    ["setActive", "connection-anthropic", false],
    ["move", "connection-anthropic", 1],
    ["move", "connection-claude", -1],
    ["test", "connection-anthropic", {
      connections: [
        { id: "connection-anthropic", kind: "api_key", active: true, protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", models: { fast: "claude-test" } },
        { id: "connection-claude", kind: "claude_subscription", active: false },
      ],
    }],
    ["remove", "connection-claude"],
  ])

  // A synced change shows.
  await act(async () => {
    await tab.run(tab.rows.update("connection-anthropic", (row) => {
      row.baseUrl = "https://anthropic.example.com"
      row.updatedAt = "2026-10-24T10:01:00.000Z"
    }))
  })
  expect(tab.row("API key anthropic.example.com")).not.toBeNull()

  // A save on its way: Saving, and every control of a row waits.
  await act(async () => {
    await tab.run(tab.form.insert({
      id: "form", op: "save", state: "confirming", failure: null, before: null, sent: null, saved: 0, adding: false, quiet: false,
    }))
  })
  expect(tab.container.querySelector('section > [role="status"]')?.textContent).toBe("Saving")
  const waiting = [...tab.container.querySelectorAll("li button")].map((button) => (button as HTMLButtonElement).disabled)
  expect(waiting).toHaveLength(9)
  expect(waiting.every(Boolean)).toBe(true)
})

test("a refused connection shows the provider's host and status, and when, on its own row", async () => {
  const tab = await section([{ ...SAVED, failureStatus: 429, failedAt: new Date(Date.now() - 120_000).toISOString() }, CLAUDE])
  const status = tab.row("API key api.anthropic.com").querySelector('[role="status"]')!
  expect(status.textContent).toMatch(/^api\.anthropic\.com refused · HTTP 429 · .+/)
  expect(status.querySelector("time")).not.toBeNull()
  expect(tab.row("Claude subscription ····a1B2").querySelector('[role="status"]')?.textContent).toBe("")
})

test("someone who may no longer save sees Remove alone while a connection is saved, and nothing once it is gone", async () => {
  const saved = await section([SAVED], false)
  const region = saved.container.querySelector('section[aria-label="Your model"]')!
  expect(region).not.toBeNull()
  expect(region.querySelector("form")).toBeNull()
  expect(region.querySelector("input")).toBeNull()
  expect(region.querySelector("ol")).toBeNull()
  expect([...region.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Remove"])
  await act(async () => void region.querySelector("button")!.click())
  expect(saved.pressed).toEqual([["removeAll"]])
  const none = await section([], false)
  expect(none.container.innerHTML).toBe("")
})
