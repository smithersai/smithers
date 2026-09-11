/*
 * The palette's keyboard contract (Search and Command Palette Spec 2026-09-07
 * §3) against the real App: Cmd+K opens on the composer, the arrows wrap,
 * Tab walks groups, → opens the actions panel and ← walks back, Enter runs
 * the item's open flow and clears the draft, Backspace on an empty query
 * strips the prefix and then closes, Esc closes and leaves the draft, `?`
 * lists the prefixes, and Cmd+Shift+K reopens the last query. The slash tree
 * keeps its own contract (state/SlashTree.test.tsx).
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "./App"
import { runSearchRef } from "./flows/RunCommand"
import { ControllerTestProvider } from "./ControllerContext"
import type { NativeRepositories } from "./native/NativeBridge"
import type { AgentPort } from "./runtime/AgentPort"
import { createAppController } from "./state/AppController"
import type { AppController as AppControllerType } from "./state/AppController"
import { createAppStore } from "./state/AppStore"
import type { AppStore } from "./state/AppStore"

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface View {
  readonly controller: AppControllerType
  readonly store: AppStore
  readonly host: HTMLElement
  readonly act: (change: () => void) => Promise<void>
}

/** The app signed in with two files and a run already listed, so the palette has rows to walk. */
const mount = async (): Promise<View> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    fetchImpl: async () => json(404, { status: "error", message: "no backend" })
  })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: "files-1",
      kind: "file-list",
      title: "files",
      status: "active",
      createdAt: 1,
      ordinal: 1,
      payload: {
        repo: "smithers",
        localRepoId: "r1",
        path: "src",
        entries: [{ name: "Composer.tsx", kind: "file" }, { name: "Compose.css", kind: "file" }]
      }
    }
  })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: "runs-1",
      kind: "run-list",
      title: "runs",
      status: "active",
      createdAt: 2,
      ordinal: 2,
      payload: { repo: "will/flows", runs: [{ runId: "run-compose", flowId: "review", status: "running", createdAt: 1, turns: 1, calls: 1 }] }
    }
  })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <App />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  const act = async (change: () => void): Promise<void> => {
    flushSync(change)
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => {})
  }
  await act(() => {})
  return { controller, store, host, act }
}

const textarea = (host: HTMLElement): HTMLTextAreaElement | null => host.querySelector<HTMLTextAreaElement>("textarea")

const palette = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>("[data-testid='palette']")

const rows = (host: HTMLElement): Array<string> =>
  Array.from(host.querySelectorAll<HTMLElement>("[data-testid='palette'] [role='option']")).map((option) =>
    option.dataset["ref"] ?? option.dataset["flow"] ?? option.dataset["prefix"] ?? ""
  )

const highlighted = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>("[data-testid='palette'] [data-highlighted='true']")

const press = async (view: View, key: string, modifiers: { meta?: boolean; shift?: boolean } = {}): Promise<void> => {
  await view.act(() => {
    textarea(view.host)?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, metaKey: modifiers.meta === true, shiftKey: modifiers.shift === true })
    )
  })
}

/** Every flow the registry's one run path traced, from the transition journal; the recommender's own refresh (system.recommend) is not a palette act. */
const invoked = (store: AppStore): Array<{ name: string; args: string | null }> =>
  [...store.collections.transitions.values()]
    .filter((row) => row.type === "flow.invoked" && !row.payload.includes('"system.recommend"'))
    .sort((left, right) => left.revision - right.revision)
    .map((row) => {
      const payload = JSON.parse(row.payload) as { name?: string; args?: string | null }
      return { name: payload.name ?? "", args: payload.args ?? null }
    })

describe("§3 the keyboard contract", () => {
  test("Cmd+K opens the overlay on the composer with the draft as the query; Esc closes it and leaves the draft", async () => {
    const view = await mount()
    expect(palette(view.host)).toBeNull()
    await view.act(() => view.controller.changeDraft("Compose"))
    expect(palette(view.host)).toBeNull()
    await press(view, "k", { meta: true })
    expect(view.store.session().paletteOpen).toBe(true)
    expect(palette(view.host)?.dataset["mode"]).toBe("all")
    // Files (both prefix matches, in listing order), the run (contains), then the flow whose summary says "compose".
    expect(rows(view.host)).toEqual(["src/Composer.tsx", "src/Compose.css", runSearchRef("run-compose", "runs-1"), "chat.send"])
    await press(view, "Escape")
    expect(view.store.session().paletteOpen).toBe(false)
    expect(palette(view.host)).toBeNull()
    expect(view.store.session().draft).toBe("Compose")
    // A second Esc mid-query still finds the draft intact (story 10).
    await press(view, "Escape")
    expect(view.store.session().draft).toBe("Compose")
  })

  test("the arrows move and wrap; Tab and Shift+Tab walk the groups", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("Compose"))
    await press(view, "k", { meta: true })
    expect(highlighted(view.host)?.dataset["ref"]).toBe("src/Composer.tsx")
    await press(view, "ArrowUp")
    expect(highlighted(view.host)?.dataset["ref"]).toBe("chat.send")
    await press(view, "ArrowDown")
    expect(highlighted(view.host)?.dataset["ref"]).toBe("src/Composer.tsx")
    await press(view, "ArrowDown")
    expect(highlighted(view.host)?.dataset["ref"]).toBe("src/Compose.css")
    await press(view, "Tab")
    expect(highlighted(view.host)?.dataset["ref"]).toBe(runSearchRef("run-compose", "runs-1"))
    await press(view, "Tab")
    expect(highlighted(view.host)?.dataset["ref"]).toBe("chat.send")
    await press(view, "Tab", { shift: true })
    expect(highlighted(view.host)?.dataset["ref"]).toBe(runSearchRef("run-compose", "runs-1"))
  })

  test("→ opens the item's actions (registered flows), ← walks back, Enter on an action runs it", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("run:compose"))
    await press(view, "k", { meta: true })
    expect(palette(view.host)?.dataset["mode"]).toBe("runs")
    await press(view, "ArrowRight")
    expect(view.store.session().paletteActionsRef).toBe(runSearchRef("run-compose", "runs-1"))
    const actions = rows(view.host)
    expect(actions[0]).toBe("runs.open")
    expect(actions).toContain("runs.resume")
    expect(actions).toContain("runs.logs")
    expect(view.host.querySelector("[data-testid='palette-chip']")?.textContent).toBe("actions")
    await press(view, "ArrowLeft")
    expect(view.store.session().paletteActionsRef).toBeNull()
    expect(rows(view.host)).toEqual([runSearchRef("run-compose", "runs-1")])
    // A second Cmd+K on the highlighted item opens the actions too.
    await press(view, "k", { meta: true })
    expect(view.store.session().paletteActionsRef).toBe(runSearchRef("run-compose", "runs-1"))
    await press(view, "ArrowDown")
    await press(view, "Enter")
    expect(invoked(view.store).map((row) => row.name)).toContain("runs.resume")
    expect(view.store.session().paletteOpen).toBe(false)
    expect(view.store.session().draft).toBe("")
  })

  test("Enter runs the highlighted item's open flow with its ref, notes the recent, clears the draft and remembers the query", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("Composer.tsx"))
    await press(view, "k", { meta: true })
    expect(palette(view.host)?.dataset["mode"]).toBe("path")
    expect(rows(view.host)).toEqual(["src/Composer.tsx"])
    await press(view, "Enter")
    expect(invoked(view.store)).toContainEqual({ name: "files.read", args: "src/Composer.tsx" })
    expect(view.store.session().draft).toBe("")
    expect(view.store.session().paletteOpen).toBe(false)
    expect(view.store.session().paletteLastQuery).toBe("Composer.tsx")
    expect(view.store.session().paletteRecents?.[0]).toMatchObject({ kind: "file", ref: "src/Composer.tsx", count: 1 })
    // Cmd+Shift+K reopens the last query.
    await press(view, "k", { meta: true, shift: true })
    expect(view.store.session().draft).toBe("Composer.tsx")
    expect(palette(view.host)).not.toBeNull()
  })

  test("Cmd+Enter runs the primary flow when the item has one, and nothing when it has none", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("run:compose"))
    await press(view, "k", { meta: true })
    await press(view, "Enter", { meta: true })
    expect(invoked(view.store)).toContainEqual({ name: "runs.resume", args: "sourceCard=runs-1 run-compose" })
    // A file's primary flow is Implement (§2), which is not registered: Cmd+Enter runs nothing and never invents a flow.
    await view.act(() => view.controller.changeDraft("Composer.tsx"))
    await press(view, "k", { meta: true })
    const before = invoked(view.store).length
    await press(view, "Enter", { meta: true })
    expect(invoked(view.store).length).toBe(before)
    expect(view.store.session().paletteOpen).toBe(true)
  })

  test("Backspace on an empty query removes the prefix, then closes; the mode chip follows the prefix", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("wiki:"))
    await press(view, "k", { meta: true })
    expect(view.host.querySelector("[data-testid='palette-chip']")?.textContent).toBe("wiki:")
    await press(view, "Backspace")
    expect(view.store.session().draft).toBe("")
    expect(view.store.session().paletteOpen).toBe(true)
    await press(view, "Backspace")
    expect(view.store.session().paletteOpen).toBe(false)
  })

  test("? lists every prefix; Enter on a row switches the draft to that prefix", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("?"))
    await press(view, "k", { meta: true })
    expect(palette(view.host)?.dataset["mode"]).toBe("help")
    const listed = Array.from(view.host.querySelectorAll<HTMLElement>("[data-testid='palette'] [role='option'] .slash-menu-name")).map((node) => node.textContent)
    expect(listed).toContain("text:")
    expect(listed).toContain("secret:")
    await press(view, "ArrowDown")
    await press(view, "ArrowDown")
    await press(view, "Enter")
    expect(view.store.session().draft).toBe("@")
    expect(palette(view.host)?.dataset["mode"]).toBe("symbols")
    expect(view.host.querySelector("[data-testid='palette-refusal']")?.textContent).toContain("No symbol index")
  })

  test("a mode with no rows runs its flow on Enter (the form law answers a bare prefix)", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("box:"))
    await press(view, "k", { meta: true })
    expect(rows(view.host)).toEqual([])
    await press(view, "Enter")
    expect(invoked(view.store).map((row) => row.name)).toContain("search.boxes")
  })

  test("with the overlay open, Enter on a slash command with arguments is the composer's send, never search.flows", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    expect(view.store.session().paletteOpen).toBe(true)
    // `/implement fix it` has no slash rows (the tree lists names, not arguments), so the overlay owns nothing here.
    await view.act(() => view.controller.changeDraft("/implement fix it"))
    expect(palette(view.host)?.dataset["mode"]).toBe("flows")
    expect(rows(view.host)).toEqual([])
    await press(view, "Enter")
    const names = invoked(view.store).map((row) => row.name)
    expect(invoked(view.store)).toContainEqual({ name: "chat.send", args: "/implement fix it" })
    expect(names).not.toContain("search.flows")
    expect(view.store.session().paletteOpen).toBe(false)
  })

  test("the slash tree stays the / mode of the same overlay", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("/app"))
    expect(palette(view.host)?.dataset["mode"]).toBe("flows")
    expect(rows(view.host)[0]).toBe("")
    expect(view.host.querySelector("[data-testid='palette'] [data-namespace='appearance']")).not.toBeNull()
    await press(view, "ArrowRight")
    expect(view.store.session().draft).toBe("/appearance.")
  })
})
