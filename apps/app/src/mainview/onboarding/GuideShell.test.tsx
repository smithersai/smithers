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
import { GUIDE_BRIDGE, GUIDE_LAST_STEP, GUIDE_STAGES, lessonText } from "./lessons"


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

const mountGuide = async (step: number, clock?: GuideClock, answers: Record<string, unknown> = { heard: "", project: "" }, observe?: (controller: ReturnType<typeof createAppController>) => void): Promise<HTMLElement> => {
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


const still: GuideClock = { setTimeout: () => 1, clearTimeout: () => {} }
const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  flushSync(() => {})
}

test("every beat has keyboard navigation, one pill shape, and no numbered instruction rows", async () => {
  for (let step = 0; step <= GUIDE_LAST_STEP; step++) {
    const host = await mountGuide(step, still, { repo: "acme/api" })
    if (step < GUIDE_LAST_STEP) {
      const back = host.querySelector('[aria-keyshortcuts="ArrowLeft"]')
      expect(back).not.toBeNull()
      expect(text(back)).toContain("←")
    }
    // SCRIPT v4 principle 1: the pill is the instruction; numbered "Click X" rows are gone.
    expect(host.querySelector(".guide-steps")).toBeNull()
    for (const button of host.querySelectorAll<HTMLButtonElement>(".guide-navigation button, .guide-actions button")) {
      expect(button.getAttribute("aria-keyshortcuts")).toBeTruthy()
      expect(button.querySelector("kbd")?.closest("button")).toBe(button)
    }
    const lesson = GUIDE_STAGES[step]!
    if (lesson.kind === "do") {
      // No slash command in copy ("type /issues"); a path like src/hello.ts is fine.
      expect(lesson.instruction).not.toMatch(/(^|\s)\/[a-z][a-z.-]*/i)
      const primaries = host.querySelectorAll(".guide-actions .guide-primary")
      expect(primaries.length).toBe(lesson.actions.length)
      for (const action of lesson.actions) {
        const button = host.querySelector(`.guide-actions [data-flow="${action.flow}"]`)
        expect(text(button)).toContain(lessonText(action.label, { repo: "acme/api" }))
        expect(text(button?.querySelector("kbd") ?? null)).toBe(action.key)
        expect(button?.getAttribute("aria-keyshortcuts")).toBe(action.key.length === 1 ? action.key.toLowerCase() : "Meta+K Control+K")
        expect(button?.getAttribute("aria-describedby")).toBe(`guide-instruction-${step}`)
      }
      if (lesson.secondary !== undefined) expect(text(host.querySelector(".guide-actions [data-secondary]"))).toContain(lesson.secondary.label)
      // Skip practice (Q) sits beside Back on the practice beats only.
      expect(host.querySelector(".guide-skip") !== null).toBe(lesson.practice === true)
    }
    // The goal card is pinned through the practice beats.
    expect(host.querySelector(".guide-goal") !== null).toBe(step <= 9)
    mounted.pop()?.()
  }
})

test("a real persisted completion shows the check and the follow-up line before advancing", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(3, still, {}, c => { controller = c })
  await controller.guideAct("signal", "prs.opened")
  await settle()
  expect(host.querySelector('[data-message-step="3"] [aria-label="Done"]')).not.toBeNull()
  expect(text(host.querySelector('[data-message-step="3"] [data-followup]'))).toBe("Mira's on logging, not greetings. It's ours.")
  expect(controller.store.session().guide?.step).toBe(3)
})

test("lesson shortcuts share the button dispatch and preserve keyboard guards", async () => {
  const calls: string[] = []
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(GUIDE_BRIDGE, still, undefined, c => {
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
  await settle()
  press()
  expect(calls).toHaveLength(2)
})

test("every pill click and its letter dispatch the same flow and arguments", async () => {
  for (let step = 1; step < GUIDE_LAST_STEP; step++) {
    const lesson = GUIDE_STAGES[step]!
    if (lesson.kind !== "do") continue
    const calls: Array<[string, string?]> = []
    const host = await mountGuide(step, still, { repo: "acme/api" }, c => {
      spyOn(c, "runCommand").mockImplementation(name => { calls.push([name]); return true })
      spyOn(c, "runCommand").mockImplementation((name, args) => { calls.push([name, args]); return true })
    })
    for (const action of [...lesson.actions, ...(lesson.secondary === undefined ? [] : [lesson.secondary])]) {
      // The picker's set and the ⌘K chord are covered end to end (e2e/playwright/tutorial2-walk.spec.ts).
      if (action.args === "{picked}" || action.key.length > 1) continue
      calls.length = 0
      host.querySelector<HTMLButtonElement>(`.guide-actions [data-flow="${action.flow}"]${action === lesson.secondary ? "[data-secondary]" : ".guide-primary"}`)!.click()
      document.dispatchEvent(new KeyboardEvent("keydown", { key: action.key.toLowerCase(), bubbles: true }))
      const args = action.args?.replaceAll("{repo}", "acme/api")
      const expected: [string, string?] = args === undefined ? [action.flow] : [action.flow, args]
      expect(calls).toEqual([expected, expected])
    }
    mounted.pop()?.()
  }
})

test("Not now at login skips the repository beats; Later at install skips the background runs", async () => {
  let controller!: ReturnType<typeof createAppController>
  await mountGuide(GUIDE_BRIDGE, still, {}, c => { controller = c })
  await controller.guideAct("decline", "login")
  expect(controller.store.session().guide?.step).toBe(13)
  await controller.guideAct("back")
  expect(controller.store.session().guide?.step).toBe(GUIDE_BRIDGE)
  mounted.pop()?.()
  await mountGuide(11, still, {}, c => { controller = c })
  await controller.guideAct("decline", "install")
  expect(controller.store.session().guide?.step).toBe(13)
  expect(controller.store.session().guide?.declined).toEqual(["install"])
})

test("Skip practice lands on the bridge and marks the goal skipped", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(3, still, {}, c => { controller = c })
  await controller.guideAct("skip-practice")
  await settle()
  expect(controller.store.session().guide?.step).toBe(GUIDE_BRIDGE)
  expect(host.querySelector(".guide-goal")?.getAttribute("data-goal-state")).toBe("skipped")
  expect(text(host.querySelector(".guide-goal"))).toContain("Skipped")
})
