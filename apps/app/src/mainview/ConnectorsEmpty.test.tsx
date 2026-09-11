import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "./App"
import { ControllerTestProvider } from "./ControllerContext"
import type { NativeRepositories } from "./native/NativeBridge"
import type { AgentPort } from "./runtime/AgentPort"
import { createAppController } from "./state/AppController"
import type { AppController as AppControllerType } from "./state/AppController"
import { createAppStore } from "./state/AppStore"
import type { AppStore } from "./state/AppStore"

/*
 * §11.6 — zero connectors names the next step.
 *
 * The zero case rendered one line, "No repositories connected", with no
 * description and no affordance, while every sibling surface in the same file
 * states a move. It matters most here: on the web the only way to add a
 * repository is the import row, and connector.add answers "native app only",
 * so a reader who is not pointed at import has nowhere obvious to look.
 */

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

const silentAgent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const mount = (controller: AppControllerType): HTMLElement => {
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
  return host
}

const openConnectors = async (
  signedIn: boolean
): Promise<{ readonly host: HTMLElement; readonly store: AppStore }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  if (signedIn) {
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "codeplanesmithers",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
  }
  const controller = createAppController(store, unavailableRepositories, silentAgent, {
    fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" } })
  })
  const host = mount(controller)
  flushSync(() => controller.showConnectors())
  return { host, store }
}

describe("the connectors surface with nothing connected", () => {
  test("signed in, it names the act that adds one and offers it", async () => {
    const { host } = await openConnectors(true)
    const empty = host.querySelector(".connector-empty")
    expect(empty).not.toBeNull()
    const text = empty?.textContent ?? ""
    expect(text).toContain("No repositories connected")
    // A fact plus a move, not a fact alone.
    expect(text).toContain("Import a GitHub repository")
    const action = empty?.querySelector("[data-flow=\"repos.import\"]")
    expect(action).not.toBeNull()
    expect(action?.textContent).toContain("Import a repository")
  })

  test("signed out, it points at the one door there is instead of offering a second", async () => {
    const { host } = await openConnectors(false)
    const empty = host.querySelector(".connector-empty")
    const text = empty?.textContent ?? ""
    expect(text).toContain("No repositories connected")
    expect(text).toContain("Connecting GitHub above is the first step")
    // §1.1: signed out there is exactly one way in, and it is the GitHub row.
    expect(empty?.querySelector("[data-flow=\"repos.import\"]")).toBeNull()
  })
})
