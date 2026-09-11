import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, expect, test, spyOn } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { initialGuide } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import type { GuideClock } from "./advance"
import { GuideShell } from "./GuideShell"
import { GUIDE_STAGES } from "./lessons"


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

const silentAgent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const text = (node: Element | null): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim()

const mountGuide = async (step: number, clock?: GuideClock, answers = { heard: "", project: "" }, observe?: (controller: ReturnType<typeof createAppController>) => void): Promise<HTMLElement> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, silentAgent)
  observe?.(controller)
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step, ...answers } }).isPersisted.promise
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <GuideShell clock={clock}>
          <div />
        </GuideShell>
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return host
}


test("all nine lessons have keyboard navigation and numbered do instructions", async () => {
  for (let step = 0; step < 9; step++) {
    const host = await mountGuide(step, { setTimeout: () => 1, clearTimeout: () => {} })
    const back = host.querySelector('[aria-keyshortcuts="ArrowLeft"]')
    expect(back).not.toBeNull()
    expect(text(back)).toContain("←")
    const instruction = host.querySelector(`[data-message-step="${step}"] .guide-steps`)
    if (step > 0) expect(instruction).not.toBeNull()
    for (const button of host.querySelectorAll<HTMLButtonElement>(".guide-navigation button, .guide-actions button")) {
      expect(button.getAttribute("aria-keyshortcuts")).toBeTruthy()
      expect(button.querySelector("kbd")?.closest("button")).toBe(button)
    }
    const lesson = GUIDE_STAGES[step]
    if (lesson.kind === "do") {
      for (const copy of [lesson.instruction, ...(lesson.instructions ?? [])]) {
        expect(copy).not.toMatch(/\/[a-z][a-z.-]*/i)
        expect(copy).not.toMatch(/Cmd K|Ctrl K/)
      }
      expect(host.querySelectorAll(".guide-actions button").length).toBe(lesson.actions?.length ?? 0)
      for (const action of lesson.actions ?? []) {
        expect(action.key).toMatch(/^[A-Z]$/)
        expect(["C", "N", "R", "S", "W"]).not.toContain(action.key)
        const button = host.querySelector(`.guide-actions [data-flow="${action.flow}"]`)
        expect(text(button)).toContain(action.label)
        expect(text(button?.querySelector("kbd") ?? null)).toBe(action.key)
        expect(button?.getAttribute("aria-keyshortcuts")).toBe(action.key.toLowerCase())
      }
    }
    mounted.pop()?.()
  }
})
test("a real persisted completion checks the instruction before advancing", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(3, { setTimeout: () => 1, clearTimeout: () => {} }, { heard: "", project: "" }, c => { controller = c })
  await controller.guideAct("signal", "prs.opened")
  await new Promise(resolve => setTimeout(resolve, 0))
  flushSync(() => {})
  expect(host.querySelector('[data-message-step="3"] [aria-label="Done"]')).not.toBeNull()
  expect(controller.store.session().guide?.step).toBe(3)
})


test("lesson shortcuts share the button dispatch and preserve keyboard guards", async () => {
  const calls: string[] = []
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(1, { setTimeout: () => 1, clearTimeout: () => {} }, undefined, c => {
    controller = c
    spyOn(c, "runCommand").mockImplementation(name => { calls.push(name); return true })
  })
  const press = (init: KeyboardEventInit = {}, target: EventTarget = document) => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true, ...init }))
  }
  for (const init of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) press(init)
  const input = document.createElement("input")
  host.append(input)
  press({}, input)
  expect(calls).toEqual([])
  press()
  host.querySelector<HTMLButtonElement>('[data-flow="auth.sign-in"]')!.click()
  expect(calls).toEqual(["auth.sign-in", "auth.sign-in"])
  await controller.guideAct("open")
  await new Promise(resolve => setTimeout(resolve, 0))
  flushSync(() => {})
  press()
  expect(calls).toHaveLength(2)
})


test("every action click and letter dispatch the same flow and arguments", async () => {
  for (let step = 1; step < 9; step++) {
    const calls: Array<[string, string?]> = []
    const host = await mountGuide(step, { setTimeout: () => 1, clearTimeout: () => {} }, undefined, c => {
      spyOn(c, "runCommand").mockImplementation(name => { calls.push([name]); return true })
      spyOn(c, "runCommand").mockImplementation((name, args) => { calls.push([name, args]); return true })
    })
    const lesson = GUIDE_STAGES[step]
    if (lesson.kind === "do") for (const action of lesson.actions ?? []) {
      calls.length = 0
      host.querySelector<HTMLButtonElement>(`.guide-actions [data-flow="${action.flow}"]`)!.click()
      document.dispatchEvent(new KeyboardEvent("keydown", { key: action.key.toLowerCase(), bubbles: true }))
      const args = action.flow === "plugins.install" ? "librarian" : action.args
      const expected: [string, string?] = args === undefined ? [action.flow] : [action.flow, args]
      expect(calls).toEqual([expected, expected])
    }
    mounted.pop()?.()
  }
})
