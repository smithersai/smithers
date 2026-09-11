import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppController } from "../state/AppController"
import { initialGuide } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { GuideShell } from "./GuideShell"
import { LIBRARIAN_LESSON_STEP, PLUGINS_LESSON_STEP } from "./pluginLesson"

/*
 * The two plugin lessons, driven the way a reader drives them: the lesson
 * asks for `/plugins`, typing it opens the real Library inside the lesson,
 * and Install is the real `plugins.install` flow — the shelf it writes is the
 * workspace's own, and what the plugin adds appears on the sidebar rail.
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

const silentAgent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "native only" })
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const mountLesson = async (step: number): Promise<{
  readonly host: HTMLElement
  readonly store: AppStore
  readonly controller: AppController
  readonly act: (change: () => void) => Promise<void>
}> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, silentAgent)
  await store.dispatch({
    type: "guide.changed",
    actor: "user",
    guide: { ...initialGuide(), step, conversationOpen: true }
  }).isPersisted.promise
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <GuideShell>
          <div />
        </GuideShell>
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
  return { host, store, controller, act }
}

describe("the plugin lessons", () => {
  test("the lesson names its button, and the typed flow still opens the real Library", async () => {
    const { host, store, controller, act } = await mountLesson(PLUGINS_LESSON_STEP)
    expect((host.querySelector('[data-message-step="5"] .guide-steps')?.textContent ?? "")).toContain("Click Install the Librarian")
    expect(host.querySelector(".guide-library")).toBeNull()

    /* Typed into the composer, exactly as the lesson says. */
    await act(() => {
      controller.changeDraft("/plugins")
      controller.send(store.session().draft)
    })
    expect(store.session().guide?.step).toBe(PLUGINS_LESSON_STEP)
    expect(host.querySelector('[data-message-step="5"] [aria-label="Done"]')).toBeNull()
    expect(host.querySelector('.guide-library[aria-label="Library"] .plugin-card')).not.toBeNull()
    await act(() => controller.runCommand("onboarding.act", 'advance "0:5"'))
    expect(store.session().guide?.step).toBe(5)
    expect(store.session().guide?.library).toBe(true)
    expect(store.session().surface).toBe("plugins")

  }, 20000)

  test("installing from the lesson's Library is the real act, and its flows reach the sidebar", async () => {
    const { host, store, act } = await mountLesson(LIBRARIAN_LESSON_STEP)
    await act(() => {
      store.dispatch({
        type: "guide.changed",
        actor: "user",
        guide: { ...initialGuide(), step: LIBRARIAN_LESSON_STEP, library: true }
      })
    })
    const install = host.querySelector<HTMLElement>("[data-testid=\"plugin-install-librarian\"]")
    expect(install?.dataset["flow"]).toBe("plugins.install")
    await act(() => install?.click())
    expect(store.session().plugins).toEqual(["librarian"])
    expect(store.session().guide?.librarian).toBe(true)
    expect(store.session().guide?.step).toBe(LIBRARIAN_LESSON_STEP)
    expect(host.querySelector('[data-message-step="5"] [aria-label="Done"]')).not.toBeNull()
    const rail = [...host.querySelectorAll<HTMLElement>(".guide-sidebar .plugin-rail button")]
    expect(rail.map((button) => button.dataset["flow"])).toEqual(["wiki", "history.show"])
  }, 20000)
})
