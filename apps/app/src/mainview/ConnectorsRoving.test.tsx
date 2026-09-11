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

/*
 * The connect surface's roving arrows move between the rows' ACTIONS — the
 * buttons. Lane sync (ADR 0005) made the signed-in GitHub row interactive
 * (its act is github.app) and added the Linear row, so signed in every row
 * action is a button and the ring walks them in order, wrapping at the end.
 * (The pre-sync row wore a status Badge in the action slot; roving onto it
 * called focus() on a non-focusable element and stranded the ring, §21.2.)
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

describe("the connect surface's roving arrows walk the row actions", () => {
  test("signed in, ArrowDown walks GitHub → Linear → Import and wraps", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "codeplanesmithers",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" } })
    })
    const host = mount(controller)
    flushSync(() => controller.showConnectors())

    const list = host.querySelector<HTMLElement>(".connect-store-list")
    expect(list).not.toBeNull()
    /* Lane sync: signed in, every row's action slot is an interactive button. */
    const buttons = Array.from(list?.querySelectorAll<HTMLButtonElement>("button[data-row-action]") ?? [])
    const flows = buttons.map((button) => button.dataset.flow)
    expect(flows).toEqual(["github.app", "linear.connect", "repos.import"])
    expect(list?.querySelector("[data-row-action]:not(button)")).toBeNull()

    const ring = async (): Promise<Array<string | undefined>> => {
      const walked: Array<string | undefined> = []
      for (let step = 0; step < flows.length + 1; step += 1) {
        flushSync(() => {
          list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
        })
        walked.push((document.activeElement as HTMLButtonElement | null)?.dataset.flow)
      }
      return walked
    }
    /* The ring walks the rows in order and wraps onto the first. */
    expect(await ring()).toEqual(["github.app", "linear.connect", "repos.import", "github.app"])
  })
})

describe("the Linear row (ADR 0005 Connectors surface: per team, with last sync)", () => {
  test("a connected team's row carries its last-sync age off the loaded integration; a team that never synced carries none", async () => {
    /* Review finding 11: the row named the team keys and dropped the last sync the same rows already carried. */
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "codeplanesmithers",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    const integration = {
      teamId: "team-eng",
      teamName: "Engineering",
      repoOwner: "will",
      repoName: "smithers",
      active: true,
      remediation: null,
      createdAt: "2026-09-01T10:00:00Z"
    }
    store.dispatch({
      type: "linear.integrations.loaded",
      actor: "system",
      integrations: [
        { ...integration, id: "7", teamKey: "ENG", lastSyncAt: new Date(Date.now() - 4 * 60_000).toISOString() },
        { ...integration, id: "9", teamKey: "DES", teamId: "team-design", teamName: "Design", lastSyncAt: null }
      ]
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" } })
    })
    const host = mount(controller)
    flushSync(() => controller.showConnectors())

    const row = Array.from(host.querySelectorAll<HTMLElement>(".connect-store-row")).find((candidate) =>
      candidate.querySelector("strong")?.textContent === "Linear"
    )
    expect(row?.textContent).toContain("DES, ENG (last sync 4 min ago) connected — issues sync both ways.")
  })
})
