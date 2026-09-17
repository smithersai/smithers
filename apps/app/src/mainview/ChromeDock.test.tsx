import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import type { StorageApi } from "@tanstack/db"
import { afterAll,afterEach,describe,expect,test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "./App"
import { ChromeDock } from "./ChromeDock"
import { ControllerTestProvider } from "./ControllerContext"
import type { NativeRepositories } from "./native/NativeBridge"
import type { AgentPort } from "./runtime/AgentPort"
import type { AppController as AppControllerType,AppServices } from "./state/AppController"
import { createAppController } from "./state/AppController"
import type { AppStore } from "./state/AppStore"
import { createAppStore } from "./state/AppStore"

/*
 * The dock (ChromeDock.tsx): the chrome as a vertical icon rail on the left
 * edge, always on screen. The six buttons keep the factory design session's
 * fixed order and render exactly where their flow registers; the theme
 * toggle closes the column and must be on screen on every tab.
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

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const localHarness = async (services: AppServices = {}): Promise<{ store: AppStore; controller: AppControllerType }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    ...services,
    features: { wiki: true, mythicalHistory: true, ...services.features },
    bootstrap: {
      apiVersion: 1,
      host: "local",
      version: "test",
      buildSha: "test",
      capabilities: ["local.repositories", "local.targets", "local.terminal", "local.harnesses"],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    },
    socketUrl: () => undefined
  })
  return { store, controller }
}

/** The Worker's shell (docs/web-mode/PLAN.md §1): host `cloud`, capabilities from the table the server calls. */
const cloudHarness = async (services: AppServices = {}): Promise<{ store: AppStore; controller: AppControllerType }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    ...services,
    features: { wiki: true, mythicalHistory: true, ...services.features },
    bootstrap: {
      apiVersion: 1,
      host: "cloud",
      version: "test",
      buildSha: "cloud",
      capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }),
      authFlow: "redirect",
      sandbox: null
    },
    socketUrl: () => undefined
  })
  return { store, controller }
}

const mount = (controller: AppControllerType): { host: HTMLElement; act: (change: () => void) => Promise<void> } => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <ChromeDock />
        <App />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return {
    host,
    act: async (change) => {
      flushSync(change)
      await new Promise((resolve) => setTimeout(resolve, 0))
      flushSync(() => {})
    }
  }
}

const persisted = async (store: AppStore, transition: Parameters<AppStore["dispatch"]>[0]): Promise<void> => {
  await store.dispatch(transition).isPersisted.promise
}

/** The canonical row: the accessible name, the registered flow the button runs, and its test id. */
const CHROME = [
  { label: "Wiki", flow: "wiki", testid: "chrome-wiki" },
  { label: "Dispatcher", flow: "triggers.list", testid: "chrome-dispatcher" },
  { label: "Flows", flow: "flows", testid: "chrome-flows" },
  { label: "Secrets", flow: "secrets.list", testid: "chrome-secrets" },
  { label: "History", flow: "history.show", testid: "chrome-history" },
  { label: "Account", flow: "account.show", testid: "chrome-account" }
] as const

/** Every dock button that is one of the six, in DOM order. */
const rendered = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLButtonElement>("[data-testid=chrome-actions] .chrome-icon-action")].filter((button) =>
    CHROME.some((row) => row.testid === button.dataset.testid)
  )

const signedOut = async (store: AppStore): Promise<void> => {
  await persisted(store, {
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
}

describe("the dock", () => {
  test("the + menu opens outside the bar: Terminal first, then the agents", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "harnesses.loaded",
      actor: "system",
      harnesses: [
        {
          id: "claude",
          displayName: "Claude Code",
          binary: "/opt/homebrew/bin/claude",
          version: "2.1.0",
          status: "signed-in",
          account: { email: "will@codeplane.app" },
          launch: { argv: ["claude"] }
        },
        {
          id: "gemini",
          displayName: "Gemini",
          binary: null,
          version: null,
          status: "unavailable",
          account: null,
          launch: { argv: ["gemini"] }
        }
      ]
    })
    const { host, act } = mount(controller)
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=dock-add]")
    expect(trigger).not.toBeNull()
    expect(trigger?.closest(".chrome-dock")).not.toBeNull()
    await act(() => trigger?.click())
    const menu = host.querySelector<HTMLElement>("[data-testid=dock-add-menu]")
    expect(menu).not.toBeNull()
    expect(trigger?.getAttribute("aria-expanded")).toBe("true")
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])]
    expect(items.map((item) => item.getAttribute("data-flow"))).toEqual([
      "tab.terminal",
      // The six named roles (AgentRoles.ts) lead the Agents section, then the raw harnesses.
      "agent.role",
      "agent.role",
      "agent.role",
      "agent.role",
      "agent.role",
      "agent.role",
      "tab.harness",
      "tab.harness",
    ])
    expect(items[0]?.textContent).toBe("Terminal")
    expect(host.querySelector("[data-testid=dock-add-agents]")?.textContent).toBe("Agents")
    // Six role rows sit between Terminal and the first raw harness.
    expect(items[1]?.textContent).toContain("Orchestrator · Fable 5")
    expect(items[7]?.textContent).toContain("Claude Code")
    // The explainer's harness (OpenCode · Kimi) is absent from this fixture: disabled, with the reason.
    expect(items[2]?.disabled).toBe(true)
    expect(items[2]?.textContent).toContain("not installed")
    // The unavailable raw harness stays last and disabled.
    expect(items[8]?.disabled).toBe(true)
    // One Smithers: the menu offers no second conversation, and no tab.chat flow exists to open one.
    expect(host.querySelector("[data-testid=dock-add-chat]")).toBeNull()
    expect(controller.commands.find("tab.chat")).toBeUndefined()
    // The three-door law: every flow this menu binds is the agent's too (the launches confirm).
    const callable = new Set(controller.commands.callable().map((entry) => entry.binding.descriptor.name))
    for (const name of ["tab.terminal", "agent.role", "tab.harness"]) expect(callable.has(name)).toBe(true)
    expect(controller.commands.find("tab.terminal")?.metadata.confirm).toBeUndefined()
    expect(controller.commands.find("agent.role")?.metadata.confirm).toBeDefined()
    expect(controller.commands.find("tab.harness")?.metadata.confirm).toBeDefined()
    // The backdrop press closes the menu.
    await act(() => host.querySelector<HTMLElement>(".dock-add-backdrop")?.click())
    expect(host.querySelector("[data-testid=dock-add-menu]")).toBeNull()
    expect(trigger?.getAttribute("aria-expanded")).toBe("false")
  })

  test("host cloud, signed out: all six render in the fixed order, each bound to a registered flow, before the theme toggle", async () => {
    const { store, controller } = await cloudHarness()
    await signedOut(store)
    const { host } = mount(controller)
    const buttons = rendered(host)
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(CHROME.map((row) => row.label))
    expect(buttons.map((button) => button.dataset.flow)).toEqual(CHROME.map((row) => row.flow))
    expect(buttons.map((button) => button.dataset.testid)).toEqual(CHROME.map((row) => row.testid))
    for (const button of buttons) {
      // Parity: the button names a registered flow and carries its icon; the slash door offers the same entry.
      expect(controller.commands.find(button.dataset.flow ?? "")).toBeDefined()
      expect(button.querySelector("svg")).not.toBeNull()
    }
    // Icon-only: no word reaches a person through the dock, and none of it is "workflow".
    for (const button of host.querySelectorAll("[data-testid=chrome-actions] [data-flow]")) {
      expect(button.getAttribute("aria-label")?.toLowerCase() ?? "").not.toContain("workflow")
    }
    // The theme toggle closes the row; sign-in lives in the header, never the dock.
    const flows = [...host.querySelectorAll<HTMLElement>("[data-testid=chrome-actions] [data-flow]:not(.help-bubble-dismiss)")].map((el) => el.dataset.flow)
    expect(flows.at(-1)).toBe("appearance.dark-mode")
    expect(flows).not.toContain("auth.sign-in")
    expect(host.querySelector("[data-testid=chrome-sign-in]")).toBeNull()
  })

  test("host local: the row is the canonical list filtered by the registry, so only Wiki and Flows render, in that order", async () => {
    const { controller } = await localHarness()
    const registered = CHROME.filter((row) => controller.commands.find(row.flow) !== undefined)
    expect(registered.map((row) => row.label)).toEqual(["Wiki", "Flows"])
    const { host } = mount(controller)
    const buttons = rendered(host)
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Wiki", "Flows"])
    expect(buttons.map((button) => button.dataset.flow)).toEqual(["wiki", "flows"])
    for (const row of CHROME) {
      if (registered.includes(row)) continue
      expect(host.querySelector(`[data-testid=${row.testid}]`)).toBeNull()
      expect(host.querySelector(`[data-flow="${row.flow}"]`)).toBeNull()
    }
  })

  test("the theme toggle runs its own flow and follows the session theme", async () => {
    const { store, controller } = await localHarness()
    const { host, act } = mount(controller)
    const toggle = host.querySelector<HTMLButtonElement>('[data-flow="appearance.dark-mode"]')
    expect(toggle?.getAttribute("aria-label")).toBe("Toggle light and dark mode")
    const before = store.session().theme
    await act(() => toggle?.click())
    expect(store.session().theme).toBe(before === "dark" ? "light" : "dark")
    // The icon is the toggle's state: the sun offers the light theme back once dark.
    await act(() => host.querySelector<HTMLButtonElement>('[data-flow="appearance.dark-mode"]')?.click())
    expect(store.session().theme).toBe(before)
  })

  test("the dock stays on screen while a terminal tab owns the view", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · ~", sessionId: "t1", cwd: "~" }
    })
    await persisted(store, { type: "tab.selected", actor: "user", id: "t1" })
    const { host } = mount(controller)
    expect(store.session().activeTabId).toBe("t1")
    expect(host.querySelector<HTMLElement>("[data-testid=tab-body-main]")?.hidden).toBe(true)
    const dock = host.querySelector<HTMLElement>("[data-testid=chrome-actions]")
    expect(dock).not.toBeNull()
    expect(dock?.closest("[hidden]")).toBeNull()
    expect(host.querySelector<HTMLElement>('[data-flow="appearance.dark-mode"]')?.closest("[hidden]")).toBeNull()
  })
})
