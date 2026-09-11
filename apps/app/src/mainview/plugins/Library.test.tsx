import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"

/*
 * The Library, end to end through the registry: `/plugins` opens the pane,
 * the Install button is the `plugins.install` flow, and what the plugin adds
 * shows up on the rail as buttons bound to the flows it named.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
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

const noRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "native only" })
}

const silentAgent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const openLibrary = async (): Promise<{
  readonly host: HTMLElement
  readonly store: AppStore
  readonly act: (change: () => void) => Promise<void>
}> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, noRepositories, silentAgent, {
    fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" } })
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
    await settled()
    flushSync(() => {})
  }
  /* The typed door, not a controller call: exactly what a person types. */
  await act(() => { controller.runCommand("plugins") })
  return { host, store, act }
}

describe("the Library", () => {
  test("/plugins opens the shelf, recommended first, with what to install said in words", async () => {
    const { host, store } = await openLibrary()
    expect(store.session().surface).toBe("plugins")
    const cards = [...host.querySelectorAll<HTMLElement>(".plugin-card")]
    expect(cards.length).toBeGreaterThan(2)
    expect(cards[0]?.dataset["plugin"]).toBe("librarian")
    expect(cards[0]?.dataset["recommended"]).toBe("true")
    expect(host.querySelector(".plugin-start")?.textContent).toContain("Librarian")
  })

  test("Install is the plugins.install flow, and the plugin's flows arrive on the rail", async () => {
    const { host, store, act } = await openLibrary()
    const install = host.querySelector<HTMLElement>("[data-testid=\"plugin-install-librarian\"]")
    expect(install?.dataset["flow"]).toBe("plugins.install")
    await act(() => install?.click())
    expect(store.session().plugins).toEqual(["librarian"])
    const rail = [...host.querySelectorAll<HTMLElement>(".plugin-rail button")].map((button) => button.dataset["flow"])
    expect(rail).toEqual(["wiki", "history.show"])
    expect(host.querySelector("[data-testid=\"plugin-install-librarian\"]")).toBeNull()
  })

  test("removing a plugin takes its rail buttons back off the workspace", async () => {
    const { host, store, act } = await openLibrary()
    await act(() => host.querySelector<HTMLElement>("[data-testid=\"plugin-install-box\"]")?.click())
    expect(store.session().plugins).toEqual(["box"])
    const remove = host.querySelector<HTMLElement>("[data-testid=\"plugin-remove-box\"]")
    expect(remove?.dataset["flow"]).toBe("plugins.remove")
    await act(() => remove?.click())
    expect(store.session().plugins).toEqual([])
    expect(host.querySelectorAll(".plugin-rail button").length).toBe(0)
  })
})
