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
import { GUIDE_KEYS } from "./GuideButton"
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
  for (let step = 1; step <= GUIDE_LAST_STEP; step++) {
    const host = await mountGuide(step, still, { repo: "acme/api" })
    if (step > 1 && step < GUIDE_LAST_STEP) {
      const back = host.querySelector('[aria-keyshortcuts="b"]')
      expect(back).not.toBeNull()
      expect(text(back)).toBe("Back b")
    }
    // SCRIPT v4 principle 1: the pill is the instruction; numbered "Click X" rows are gone.
    expect(host.querySelector(".guide-steps")).toBeNull()
    for (const button of host.querySelectorAll<HTMLButtonElement>(".guide-navigation button[data-flow], .guide-actions button[data-flow]")) {
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
        expect(text(button?.querySelector("kbd") ?? null)).toBe(action.key === "⌘K" ? "⌘ K" : action.key)
        expect(button?.getAttribute("aria-keyshortcuts")).toBe(action.key.length === 1 ? action.key.toLowerCase() : "Meta+K Control+K")
        expect(button?.getAttribute("aria-describedby")).toBe(`guide-instruction-${step}${step === 1 ? " guide-help-1" : ""}`)
      }
      if (lesson.secondary !== undefined) expect(text(host.querySelector(".guide-actions [data-secondary]"))).toContain(lesson.secondary.label)
      // Skip practice (Q) sits beside Back on the practice beats only.
      expect(host.querySelector(".guide-skip") !== null).toBe(lesson.practice === true)
    }
    // The goal card is pinned through the practice beats.
    expect(host.querySelector(".guide-goal") !== null).toBe(step > 0 && step <= 9)
    mounted.pop()?.()
  }
})

test("a real persisted completion shows the check and the follow-up line before advancing", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(6, still, {}, c => { controller = c })
  await controller.guideAct("signal", "commits.made")
  await settle()
  expect(host.querySelector('[data-message-step="6"] [aria-label="Done"]')).not.toBeNull()
  expect(text(host.querySelector('[data-message-step="6"] [data-followup]'))).toBe("The implementation is ready to review.")
  expect(controller.store.session().guide?.step).toBe(6)
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
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "l", bubbles: true, ...init }))
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
      document.dispatchEvent(new KeyboardEvent("keyup", { key: action.key.toLowerCase(), bubbles: true }))
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
  expect([...host.querySelectorAll(".guide-goal li")].map(item => text(item))).toEqual(["Issue", "Plan", "Commits", "Change"])
})


test("overlapping tutorial shortcuts highlight together and only the final release dispatches", async () => {
  const calls: Array<[string, string?]> = []
  const host = await mountGuide(1, still, {}, c => {
    spyOn(c, "runCommand").mockImplementation((name, args) => { calls.push([name, args]); return true })
  })
  const tutorial = host.querySelector<HTMLElement>('[aria-keyshortcuts="i"]')!
  const sound = host.querySelector<HTMLElement>('[aria-keyshortcuts="s"]')!
  const key = (type: string, key: string, repeat = false) => document.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, repeat }))
  key('keydown', 'i')
  key('keydown', 's')
  key('keydown', 'i', true)
  expect(tutorial.hasAttribute('data-pressed')).toBe(true)
  expect(sound.hasAttribute('data-pressed')).toBe(true)
  expect(calls).toEqual([])
  key('keyup', 'i')
  expect(tutorial.hasAttribute('data-pressed')).toBe(false)
  expect(sound.hasAttribute('data-pressed')).toBe(true)
  expect(calls).toEqual([])
  key('keyup', 's')
  expect(sound.hasAttribute('data-pressed')).toBe(false)
  expect(calls).toEqual([['onboarding.act', 'sound']])
  key('keydown', 'i')
  expect(calls).toHaveLength(1)
  key('keyup', 'i')
  expect(calls).toEqual([['onboarding.act', 'sound'], ['issues.list', 'open practice:smithersai/hello-server']])
})

test("held input survives an incidental tutorial state render", async () => {
  let controller!: ReturnType<typeof createAppController>
  const calls: Array<[string, string?]> = []
  const host = await mountGuide(1, still, {}, c => {
    controller = c
    spyOn(c, 'runCommand').mockImplementation((name, args) => { calls.push([name, args]); return true })
  })
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }))
  await controller.guideAct('pause')
  await settle()
  expect(host.querySelector('[aria-keyshortcuts="i"]')!.hasAttribute('data-pressed')).toBe(true)
  expect(calls).toEqual([])
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'i', bubbles: true, cancelable: true }))
  expect(calls).toEqual([['issues.list', 'open practice:smithersai/hello-server']])
})

test("first practice help describes the suggested action without emitting a notification", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(1, still, {}, c => { controller = c })
  const target = host.querySelector<HTMLButtonElement>('.guide-actions [data-flow="issues.list"]')!
  expect(text(host.querySelector('#guide-help-1'))).toContain("Click Show issues or press i")
  expect(target.getAttribute('aria-describedby')).toContain('guide-help-1')
  expect(host.querySelector('.guide-toasts .guide-tip')).toBeNull()
  const dismiss = host.querySelector<HTMLButtonElement>('[aria-label="Dismiss help"]')!
  dismiss.focus()
  flushSync(() => dismiss.click())
  expect(host.querySelector('[role="note"]')).toBeNull()
  expect(document.activeElement).toBe(target)
  expect(target.getAttribute('aria-describedby')).toBe('guide-instruction-1')
  await controller.store.dispose?.()
})

test("completion removes the help before the next lesson advances", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(1, still, {}, c => { controller = c })
  expect(host.querySelector('#guide-help-1')).not.toBeNull()
  await controller.guideAct('signal', 'issues.opened')
  await settle()
  expect(host.querySelector('#guide-help-1')).toBeNull()
})


test("lesson keys cannot collide with Back, Dictation, or Sound", () => {
  const reserved = [GUIDE_KEYS.back, GUIDE_KEYS.dictation, GUIDE_KEYS.sound, 'w']
  for (const lesson of GUIDE_STAGES) {
    if (lesson.kind !== 'do') continue
    const keys = [...lesson.actions, ...(lesson.secondary ? [lesson.secondary] : [])].map(action => action.key.toLowerCase())
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.some(key => reserved.includes(key as typeof reserved[number]))).toBe(false)
  }
  expect(GUIDE_STAGES.flatMap(lesson => lesson.kind === 'do' ? lesson.actions : []).find(action => action.flow === 'wiki.create')?.key).toBe('k')
})

test("Show issues, Chat, Sound, and Dictation share a keycap control; Back starts at the next lesson", async () => {
  const host = await mountGuide(1, still)
  for (const shortcut of ['i', 'Meta+K Control+K', 's', 'v']) {
    const button = host.querySelector<HTMLButtonElement>(`button[aria-keyshortcuts="${shortcut}"]`)!
    expect(button).not.toBeNull()
    expect(button.classList.contains('guide-button')).toBe(true)
    expect(button.querySelector(':scope > .guide-button-content')).not.toBeNull()
    expect(button.querySelector(':scope > .guide-button-key')).not.toBeNull()
  }
  expect(host.querySelector('[aria-keyshortcuts="b"]')).toBeNull()
  const next = await mountGuide(2, still)
  expect(text(next.querySelector('[aria-keyshortcuts="b"]'))).toBe('Back b')
})

test("Back and Dictation compete on release; Wiki uses its own key", async () => {
  const calls: Array<[string, string?]> = []
  const host = await mountGuide(12, still, { repo: 'acme/api' }, c => {
    spyOn(c, 'runCommand').mockImplementation((name, args) => { calls.push([name, args]); return true })
  })
  const key = (type: string, key: string) => document.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }))
  key('keydown', 'b'); key('keydown', 'v')
  expect(host.querySelector('[aria-keyshortcuts="b"]')!.hasAttribute('data-pressed')).toBe(true)
  expect(host.querySelector('[aria-keyshortcuts="v"]')!.hasAttribute('data-pressed')).toBe(true)
  expect(calls).toEqual([])
  key('keyup', 'b'); key('keyup', 'v')
  expect(calls).toEqual([['chat.dictate', undefined]])
  key('keydown', 'k'); key('keyup', 'k')
  expect(calls[1]).toEqual(['wiki.create', 'acme/api'])
  key('keydown', 'b'); key('keyup', 'b')
  expect(calls[2]).toEqual(['onboarding.act', 'back'])
})
