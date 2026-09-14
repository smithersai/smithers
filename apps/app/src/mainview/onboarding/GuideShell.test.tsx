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
import { PRACTICE_CARD, PRACTICE_REPO, practiceChange, practicePicker, practiceStack } from "../state/practice/PracticeRepository"
import type { GuideClock } from "./advance"
import { GuideShell } from "./GuideShell"
import App from "../App"
import { GUIDE_KEYS, guideShortcut } from "./GuideButton"
import { GUIDE_BRIDGE, GUIDE_LAST_STEP, GUIDE_STAGES, GUIDE_RESERVED_KEYS, lessonMessage, lessonText } from "./lessons"


GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
}, 2_000)

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
}, 2_000)

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

const mountGuide = async (step: number, clock?: GuideClock, answers: Record<string, unknown> = { heard: "", project: "" }, observe?: (controller: ReturnType<typeof createAppController>) => void | Promise<void>, children = <div />): Promise<HTMLElement> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, silentAgent)
  await observe?.(controller)
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step, ...answers } }).isPersisted.promise
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <GuideShell clock={clock}>
          {children}
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

for (const trigger of ["click", "shortcut"] as const) test(`an actionable seam notice starts sign-in by ${trigger}`, async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(1, still, {}, async c => {
    controller = c
    c.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null,
      allowlisted: false, admin: false, scopesPlain: null })
    await c.store.dispatch({ type: "toast.shown", actor: "system", key: "seam.sign-in", title: "Sign in with GitHub" }).isPersisted.promise
    await c.store.dispatch({ type: "toast.resolved", actor: "system", key: "seam.sign-in", status: "failed", detail: "Sign in to continue.",
      action: { flow: "auth.sign-in", label: "Sign in with GitHub" } }).isPersisted.promise
  })
  const run = spyOn(controller, "runCommand").mockReturnValue(true)
  try {
    const button = host.querySelector<HTMLButtonElement>('.guide-toasts [data-flow="auth.sign-in"]')!
    expect(button !== null).toBe(true)
    expect(button.textContent).toContain("Sign in with GitHub")
    expect(button.getAttribute("aria-keyshortcuts")).toContain("Control+Shift+G")
    if (trigger === "click") button.click()
    else {
      // The recovery chord still works while text editing owns focus.
      const input = document.createElement("textarea")
      host.append(input)
      input.focus()
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "G", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
      expect(run).not.toHaveBeenCalled()
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "G", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
    }
    expect(run.mock.calls).toEqual([["toast.dismiss", "toast-seam.sign-in"], ["auth.sign-in", undefined]])
  } finally { run.mockRestore(); controller.dispose() }
}, 2_000)
const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  flushSync(() => {})
}

test("Chat button focuses the input before another keydown, including reopening", async () => {
  const host = await mountGuide(1, still, { autoPaused: true }, undefined, <App />)
  await settle()
  for (let attempt = 0; attempt < 2; attempt++) {
    const chat = host.querySelector<HTMLButtonElement>('.guide-footer [data-flow="chat.open"]')!
    chat.focus()
    chat.click()
    expect(document.activeElement === host.querySelector('textarea[data-testid="composer-input"]')).toBe(true)
    const input = document.activeElement!
    for (let escape = 0; escape < 2; escape++) {
      flushSync(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true, cancelable: true }))
      })
    }
    await settle()
  }
}, 2_000)

test("tutorial slash Escape dismisses just the menu, then Chat, preserving the draft", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(1, still, { autoPaused: true }, c => { controller = c }, <App />)
  await settle()
  flushSync(() => controller.runCommand('chat.open'))
  await settle()
  flushSync(() => controller.changeDraft('/'))
  await settle()
  const input = host.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!
  const escape = () => flushSync(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  escape()
  await settle()
  expect(host.querySelector('[data-testid="palette"]') === null).toBe(true)
  expect(controller.store.session().guide?.conversationOpen).toBe(true)
  expect(controller.store.session().draft).toBe('/')
  escape()
  await settle()
  expect(controller.store.session().guide?.conversationOpen).toBe(false)
}, 2_000)

test("Tab wraps from Mode to the input and Shift+Tab wraps back inside Chat", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(1, still, { autoPaused: true }, c => { controller = c }, <App />)
  await settle()
  flushSync(() => controller.runCommand('chat.open'))
  await settle()
  flushSync(() => controller.changeDraft('hello'))
  await settle()
  const input = host.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!
  const mode = host.querySelector<HTMLButtonElement>('.guide-composer-layer [aria-haspopup="menu"]')!
  mode.focus()
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  flushSync(() => mode.dispatchEvent(tab))
  expect(tab.defaultPrevented).toBe(true)
  expect(document.activeElement === input).toBe(true)
  const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
  flushSync(() => input.dispatchEvent(back))
  expect(back.defaultPrevented).toBe(true)
  expect(document.activeElement === mode).toBe(true)
}, 2_000)

test("completed pills and their keys advance after Back, including the live approval", async () => {
  for (const step of [2, 6, 7, 8]) {
    const lesson = GUIDE_STAGES[step]!
    if (lesson.kind !== "do") throw Error("expected action lesson")
    const calls: Array<[string, string?]> = []
    const host = await mountGuide(step, still, { autoPaused: true, completed: [lesson.completion] }, c => {
      spyOn(c, "runCommand").mockImplementation((name, args) => { calls.push([name, args]); return true })
    })
    const button = host.querySelector<HTMLButtonElement>(".guide-actions .guide-primary")!
    expect(button.disabled).toBe(false)
    expect(button.dataset.done).toBe("true")
    button.click()
    const key = lesson.actions[0]!.key
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
    document.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }))
    expect(calls).toEqual([["onboarding.act", "next"], ["onboarding.act", "next"]])
    mounted.pop()?.()
  }
}, 2_000)

/* Beat 13's key is the reserved C: it must still open Chat, and the rewound lesson moves on. */
test("Chat still opens at a completed beat 13, and pressing it again resumes the lesson", async () => {
  for (const press of ["key", "pointer"] as const) {
    const timers: Array<() => void> = []
    const ticking: GuideClock = { setTimeout: callback => timers.push(callback), clearTimeout: () => {} }
    let controller!: ReturnType<typeof createAppController>
    const host = await mountGuide(13, ticking, { autoPaused: true, completed: ["palette.opened"] }, c => { controller = c })
    const button = host.querySelector<HTMLButtonElement>(".guide-actions .guide-primary")!
    expect(button.dataset.flow).toBe("chat.open")
    if (press === "pointer") button.click()
    else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: GUIDE_KEYS.chat, bubbles: true }))
      document.dispatchEvent(new KeyboardEvent("keyup", { key: GUIDE_KEYS.chat, bubbles: true }))
    }
    await settle()
    expect(controller.store.session().paletteOpen).toBe(true)
    expect(controller.store.session().guide?.autoPaused).toBe(false)
    timers.pop()?.()
    await settle()
    expect(controller.store.session().guide?.step).toBe(14)
    mounted.pop()?.()
  }
}, 2_000)

test("every beat has keyboard navigation, one pill shape, and no numbered instruction rows", async () => {
  for (let step = 1; step <= GUIDE_LAST_STEP; step++) {
    const host = await mountGuide(step, still, { repo: "acme/api" })
    if (step > 1 && step < GUIDE_LAST_STEP) {
      const back = host.querySelector('[aria-keyshortcuts="b"]')
      expect(back !== null).toBe(true)
      expect(text(back)).toBe("Back b")
    }
    // SCRIPT v4 principle 1: the pill is the instruction; numbered "Click X" rows are gone.
    expect(host.querySelector(".guide-steps") === null).toBe(true)
    for (const button of host.querySelectorAll<HTMLButtonElement>(".guide-navigation button[data-flow], .guide-actions button[data-flow]")) {
      expect(button.getAttribute("aria-keyshortcuts")).toBeTruthy()
      expect(button.querySelector("kbd")?.closest("button") === button).toBe(true)
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
        expect(button?.getAttribute("aria-keyshortcuts")).toBe(guideShortcut(action.key))
        expect(button?.getAttribute("aria-describedby")).toBe(`guide-instruction-${step}${lesson.help?.actionKey === action.key ? ` guide-help-${step}` : ""}`)
      }
      if (lesson.secondary !== undefined) expect(text(host.querySelector(".guide-actions [data-secondary]"))).toContain(lesson.secondary.label)
      // Skip practice (Q) sits beside Back on the practice beats only.
      expect(host.querySelector(".guide-skip") !== null).toBe(lesson.practice === true)
    }
    // The payoff stays pinned until the user acts on the bridge.
    expect(host.querySelector(".guide-goal") !== null).toBe(step > 0 && step <= GUIDE_BRIDGE)
    mounted.pop()?.()
  }
}, 5_000)

for (const { step, declined, visible, goalState } of [
  { step: 10, declined: [], visible: true, goalState: "complete" },
  { step: 11, declined: [], visible: false, goalState: null },
  { step: 10, declined: ["practice"], visible: false, goalState: "skipped" },
]) {
  test(`persisted practice Change at stage ${step}, declined ${JSON.stringify(declined)}: cards ${visible ? "visible" : "hidden"}, goal ${goalState}`, async () => {
    const stack = practiceStack([2, 3])
    if (typeof stack === "string") throw new Error(stack)
    let controller!: ReturnType<typeof createAppController>
    const host = await mountGuide(step, still, {
      completed: ["issue.opened", "plan.ready", "commits.made", "change.opened"], declined,
    }, async c => {
      controller = c
      await c.store.dispatch({ type: "card.upsert", actor: "system", card: {
        id: PRACTICE_CARD.commits, kind: "change", title: "Change #1", status: "active", createdAt: 1, ordinal: 1,
        payload: practiceChange(stack),
      } }).isPersisted.promise
    })
    await settle()
    expect(host.querySelector('[data-tutorial-cards] [data-kind="change"]') !== null).toBe(visible)
    const goal = host.querySelector(".guide-goal")
    expect(goal?.getAttribute("data-goal-state") ?? null).toBe(goalState)
    if (goalState === "complete") {
      expect([...goal!.querySelectorAll('[data-done="true"]')].map(node => node.getAttribute("data-checkpoint")))
        .toEqual(["issue", "plan", "commits", "change"])
    }
    // Stepping aside only changes the projection; the card survives reloads.
    expect(controller.store.collections.cards.get(PRACTICE_CARD.commits)?.kind).toBe("change")
  }, 2_000)
}

test("a real persisted completion shows the check and the follow-up line before advancing", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(6, still, {}, c => { controller = c })
  await controller.guideAct("signal", "commits.made")
  await settle()
  expect(host.querySelector('[data-message-step="6"] [aria-label="Done"]') !== null).toBe(true)
  expect(text(host.querySelector('[data-message-step="6"] [data-followup]'))).toBe("The implementation is ready to review.")
  expect(controller.store.session().guide?.step).toBe(6)
}, 2_000)

test("lesson shortcuts share the button dispatch and preserve keyboard guards", async () => {
  const calls: string[] = []
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(GUIDE_BRIDGE, still, undefined, c => {
    controller = c
    spyOn(c, "runCommand").mockImplementation(name => { calls.push(name); return true })
  })
  const press = (init: KeyboardEventInit = {}, target: EventTarget = document) => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, ...init }))
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true, ...init }))
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
}, 2_000)

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
}, 5_000)

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
}, 2_000)

test("Skip practice lands on an honest bridge without narrating unreached lessons", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(4, still, { completed: ["issues.opened", "issue.opened", "issue.flows.opened"] }, c => { controller = c })
  await controller.guideAct("skip-practice")
  await settle()
  expect(controller.store.session().guide?.step).toBe(GUIDE_BRIDGE)
  expect(host.querySelector(".guide-goal")?.getAttribute("data-goal-state")).toBe("skipped")
  expect(text(host)).toContain("Bring your own repository")
  expect(text(host)).not.toContain("Everything you just did")
  expect(host.querySelector('[data-message-step="4"]') !== null).toBe(true)
  for (let step = 5; step <= 9; step++) expect(host.querySelector(`[data-message-step="${step}"]`) === null).toBe(true)
}, 2_000)


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
}, 2_000)

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
}, 2_000)

test("first practice help describes the suggested action without emitting a notification", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(1, still, {}, c => { controller = c })
  const target = host.querySelector<HTMLButtonElement>('.guide-actions [data-flow="issues.list"]')!
  expect(text(host.querySelector('#guide-help-1'))).toContain("Smithers makes suggestions")
  expect(target.getAttribute('aria-describedby')).toContain('guide-help-1')
  expect(host.querySelector('.guide-toasts .guide-tip') === null).toBe(true)
  const dismiss = host.querySelector<HTMLButtonElement>('[aria-label="Dismiss help"]')!
  dismiss.focus()
  flushSync(() => dismiss.click())
  expect(host.querySelector('[role="note"]') === null).toBe(true)
  expect(document.activeElement === target).toBe(true)
  expect(target.getAttribute('aria-describedby')).toBe('guide-instruction-1')
  await controller.store.dispose?.()
}, 2_000)

test("completion removes the help before the next lesson advances", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(1, still, {}, c => { controller = c })
  expect(host.querySelector('#guide-help-1') !== null).toBe(true)
  await controller.guideAct('signal', 'issues.opened')
  await settle()
  expect(host.querySelector('#guide-help-1') === null).toBe(true)
}, 2_000)


test("lesson keys cannot collide with Back, Mode, Sound, or Vim navigation", () => {
  const reserved = [GUIDE_KEYS.back, GUIDE_KEYS.mode, GUIDE_KEYS.sound, 'w', 'h', 'j', 'k', 'l']
  for (const lesson of GUIDE_STAGES) {
    if (lesson.kind !== 'do') continue
    const keys = [...lesson.actions, ...(lesson.secondary ? [lesson.secondary] : [])].map(action => action.key.toLowerCase())
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.some(key => reserved.includes(key as typeof reserved[number]))).toBe(false)
  }
  expect(GUIDE_STAGES.flatMap(lesson => lesson.kind === 'do' ? lesson.actions : []).find(action => action.flow === 'wiki.create')?.key).toBe('u')
}, 2_000)

test("Show issues, Chat, Sound, and Mode share a keycap control; Back starts at the next lesson", async () => {
  const host = await mountGuide(1, still)
  for (const shortcut of ['i', 'c Meta+K Control+K', 's', 'm']) {
    const button = host.querySelector<HTMLButtonElement>(`button[aria-keyshortcuts="${shortcut}"]`)!
    expect(button !== null).toBe(true)
    expect(button.classList.contains('guide-button')).toBe(true)
    expect(button.querySelector(':scope > .guide-button-content') !== null).toBe(true)
    expect(button.querySelector(':scope > .guide-button-key') !== null).toBe(true)
  }
  expect(host.querySelector('[aria-keyshortcuts="b"]') === null).toBe(true)
  const next = await mountGuide(2, still)
  expect(text(next.querySelector('[aria-keyshortcuts="b"]'))).toBe('Back b')
}, 2_000)

test("Back and Chat compete on release; Wiki keeps its own key", async () => {
  const calls: Array<[string, string?]> = []
  const host = await mountGuide(12, still, { repo: 'acme/api' }, c => {
    spyOn(c, 'runCommand').mockImplementation((name, args) => { calls.push([name, args]); return true })
  })
  const key = (type: string, key: string) => document.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }))
  key('keydown', 'b'); key('keydown', 'c')
  expect(host.querySelector('[aria-keyshortcuts="b"]')!.hasAttribute('data-pressed')).toBe(true)
  expect(host.querySelector('[data-flow="chat.open"]')!.hasAttribute('data-pressed')).toBe(true)
  expect(calls).toEqual([])
  key('keyup', 'b'); key('keyup', 'c')
  expect(calls).toEqual([['chat.open', undefined]])
  key('keydown', 'u'); key('keyup', 'u')
  expect(calls[1]).toEqual(['wiki.create', 'acme/api'])
  key('keydown', 'b'); key('keyup', 'b')
  expect(calls[2]).toEqual(['onboarding.act', 'back'])
}, 2_000)

test("Mode opens on release and selecting Dictation does not open Chat", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SpeechRecognition')
  Object.defineProperty(globalThis, 'SpeechRecognition', { configurable: true, value: class {} })
  mounted.push(() => { if (descriptor) Object.defineProperty(globalThis, 'SpeechRecognition', descriptor); else Reflect.deleteProperty(globalThis, 'SpeechRecognition') })
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(1, still, {}, c => { controller = c })
  const key = (type: string, key: string) => flushSync(() => (document.activeElement ?? document).dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true })))
  key('keydown', 'm')
  expect(host.querySelector('[aria-keyshortcuts="m"]')!.hasAttribute('data-pressed')).toBe(true)
  expect(host.querySelector('[role="menu"]') === null).toBe(true)
  key('keyup', 'm')
  expect(host.querySelector('[role="menu"]') !== null).toBe(true)
  const options = host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
  expect(document.activeElement === options[0]).toBe(true)
  key('keydown', 'ArrowDown')
  expect(document.activeElement === options[0]).toBe(true)
  key('keyup', 'ArrowDown')
  key('keydown', 'ArrowDown'); key('keyup', 'ArrowDown')
  expect(document.activeElement === options[2]).toBe(true)
  key('keydown', 'Enter')
  expect(controller.store.session().inputMode).toBe('normal')
  key('keyup', 'Enter')
  await settle()
  expect(controller.store.session().inputMode).toBe('dictation')
  expect(controller.store.session().paletteOpen).not.toBe(true)
  expect(controller.store.session().dictating).not.toBe(true)
  expect(text(host.querySelector('[aria-keyshortcuts="m"]'))).toBe('Mode: Dictation m')
  key('keydown', 'm'); key('keyup', 'm')
  key('keydown', 'Escape'); key('keyup', 'Escape')
  expect(host.querySelector('[role="menu"]') === null).toBe(true)
  expect(document.activeElement === host.querySelector('[aria-keyshortcuts="m"]')).toBe(true)
}, 2_000)


test("a running tutorial suggestion cannot dispatch through a click or shortcut", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(4, still, {}, c => { controller = c })
  await controller.store.dispatch({ type: "card.upsert", actor: "system", card: {
    id: "live-tutorial-research", kind: "run-trace", title: "Research", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "practice:hello-server", workflow: "issue.research", runId: "pending-research", phase: "launching", steps: [], result: null, lastSeq: 0,
      input: { liveTutorial: { operation: "research", playthrough: 0 } } },
  } }).isPersisted.promise
  await settle()
  const calls: string[] = []
  spyOn(controller, "runCommand").mockImplementation(name => { calls.push(name); return true })
  const button = host.querySelector<HTMLButtonElement>('.guide-actions [data-flow="issue.repro"]')!
  expect(button.disabled).toBe(true)
  expect(text(button)).toContain("Researching issue")
  button.click()
  const shell = host.querySelector<HTMLElement>(".guide-shell")!
  shell.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }))
  shell.dispatchEvent(new KeyboardEvent("keyup", { key: "r", bubbles: true }))
  expect(calls).not.toContain("issue.repro")
}, 2_000)

for (const declined of [[], ["login"], ["install"]]) {
  test(`terminal message and ordinary keyed actions survive ${JSON.stringify(declined)}`, async () => {
    const calls: Array<[string, string?]> = []
    const host = await mountGuide(14, still, { repo: "acme/api", declined }, c => {
      spyOn(c, "runCommand").mockImplementation((name, args) => { calls.push([name, args]); return true })
    })
    expect(text(host.querySelector('[data-message-step="14"] [data-line="1"]'))).toBe(lessonMessage(14, { repo: "acme/api", declined }))
    const actions = [...host.querySelectorAll<HTMLButtonElement>('.guide-actions button')]
    expect(actions.map(button => text(button.querySelector('.guide-button-content')))).toEqual(["Finish tutorial", "What else can you do?"])
    const keys = actions.map(button => button.getAttribute('aria-keyshortcuts')!)
    expect(new Set(keys).size).toBe(2)
    for (const key of keys) {
      expect(key).toMatch(/^[a-z]$/)
      expect(GUIDE_RESERVED_KEYS as readonly string[]).not.toContain(key)
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
    }
    expect(calls).toEqual([["onboarding.act", "finish"], ["tut.more", undefined]])
  }, 2_000)
}

test("a chat turn arriving at beat 2 is visible in the tutorial, including its pending bubble", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(2, still, { conversationOpen: true }, c => { controller = c })
  await controller.store.dispatch({ type: "message.submitted", actor: "user", turnId: "tutorial-chat", text: "Explain this issue" }).isPersisted.promise
  await settle()
  expect(text(host.querySelector('.guide-transcript .smithers-chat-message[data-role="user"]'))).toContain("Explain this issue")
  expect(host.querySelector('.guide-transcript .sui-chat-bubble-pending') !== null).toBe(true)
  await controller.store.dispatch({ type: "message.response.delta", actor: "smithers", turnId: "tutorial-chat", channel: "text", delta: "The default name is missing." }).isPersisted.promise
  await settle()
  expect(text(host.querySelector('.guide-transcript .smithers-chat-message[data-role="assistant"]'))).toContain("The default name is missing.")
  expect(controller.store.session().guide?.conversationOpen).toBe(true)
  await controller.store.dispatch({ type: "card.upsert", actor: "smithers", card: {
    id: "chat-home", kind: "repo-home", title: "Home from chat", status: "active", ordinal: 100, createdAt: 100,
    payload: { repo: "acme/api", path: ".smithers/home.json", blocks: [{ type: "text", text: "This is the repository overview." }], featuredFlows: null },
  } }).isPersisted.promise
  await settle()
  const reply = host.querySelector('.guide-transcript .smithers-chat-message[data-role="assistant"]')!
  const card = host.querySelector('.guide-transcript [data-testid="card-chat-home"]')!
  expect(card !== null).toBe(true)
  expect(reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await controller.store.dispatch({ type: "guide.changed", actor: "system", guide: { ...controller.store.session().guide!, step: 3 } }).isPersisted.promise
  await settle()
  const user = host.querySelector('.guide-transcript [data-role="user"]')!
  const next = host.querySelector('[data-message-step="3"]')!
  expect(user.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}, 2_000)


for (const transition of ["card.upsert", "card.navigated"] as const) test(`a picker replaced through ${transition} lands below the current Smithers line`, async () => {
  const stack = practiceStack([2, 3])
  if (typeof stack === "string") throw new Error(stack)
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(9, still, {}, async c => {
    controller = c
    await c.store.dispatch({ type: "guide.changed", actor: "system", guide: { ...initialGuide(), step: 6 } }).isPersisted.promise
    await c.store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: PRACTICE_CARD.commits, kind: "commit-pick", title: "Pick commits", status: "active", createdAt: 1, ordinal: 1,
      payload: practicePicker(),
    } }).isPersisted.promise
    await c.store.dispatch({ type: "guide.changed", actor: "system", guide: { ...c.store.session().guide!, step: 7 } }).isPersisted.promise
    await c.store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "previous", kind: "change", title: "Previous card", status: "active", createdAt: 2, ordinal: 2,
      payload: practiceChange(stack),
    } }).isPersisted.promise
  })
  const beforeReplacement = controller.store.session().guide!
  await controller.store.dispatch({ type: transition, actor: "system", card: {
    id: PRACTICE_CARD.commits, kind: "change", title: "Change #1", status: "active", createdAt: 1, ordinal: 1,
    payload: practiceChange(stack),
  } }).isPersisted.promise
  // Completion captured the guide before the replacement card arrived.
  await controller.store.dispatch({ type: "guide.changed", actor: "system", guide: {
    ...beforeReplacement, completed: ["change.opened"],
  } }).isPersisted.promise
  await settle()
  const change = host.querySelector(`[data-testid="card-${PRACTICE_CARD.commits}"]`)!
  expect(change.closest('[data-entry-step]')?.getAttribute('data-entry-step')).toBe('9')
  expect(host.querySelector('[data-message-step="9"]')!.compareDocumentPosition(change) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}, 2_000)

test("chat cards still join their reply at the terminal beat", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(14, still, { conversationOpen: true }, c => { controller = c }, <App />)
  await controller.store.dispatch({ type: "message.submitted", actor: "user", turnId: "terminal-chat", text: "Show the home card" }).isPersisted.promise
  await controller.store.dispatch({ type: "card.upsert", actor: "smithers", card: {
    id: "terminal-chat-home", kind: "repo-home", title: "Home from chat", status: "active", ordinal: 100, createdAt: 100,
    payload: { repo: "acme/api", path: ".smithers/home.json", blocks: [{ type: "text", text: "This is the repository overview." }], featuredFlows: null },
  } }).isPersisted.promise
  await settle()
  expect(host.querySelector('.guide-transcript [data-testid="card-terminal-chat-home"]') !== null).toBe(true)
  expect(host.querySelectorAll('[data-testid="card-terminal-chat-home"]').length).toBe(1)
}, 2_000)

test("chat can show a practice card after the practice lessons have been skipped", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(14, still, { declined: ["practice", "login"], conversationOpen: true }, c => { controller = c })
  await controller.store.dispatch({ type: "message.submitted", actor: "user", turnId: "practice-chat", text: "Show the practice repository" }).isPersisted.promise
  await controller.store.dispatch({ type: "card.upsert", actor: "smithers", card: {
    id: "practice-chat-home", kind: "repo-home", title: "Practice Home", status: "active", ordinal: 100, createdAt: 100,
    payload: { repo: PRACTICE_REPO, path: ".smithers/home.json", blocks: [], featuredFlows: null },
  } }).isPersisted.promise
  await settle()
  expect(host.querySelector('.guide-transcript [data-testid="card-practice-chat-home"]') !== null).toBe(true)
}, 2_000)

test("a Home card requested again in chat follows the user bubble", async () => {
  let controller!: ReturnType<typeof createAppController>
  const home = {
    id: "entry-home", kind: "repo-home" as const, title: "Home", status: "active" as const, ordinal: 1, createdAt: 1,
    payload: { repo: "acme/api", path: ".smithers/home.json", blocks: [], featuredFlows: null },
  }
  const host = await mountGuide(2, still, { conversationOpen: true }, async c => {
    controller = c
    await c.store.dispatch({ type: "card.upsert", actor: "system", card: home }).isPersisted.promise
  })
  expect(host.querySelector('[data-testid="card-entry-home"]') === null).toBe(true)
  await controller.store.dispatch({ type: "message.submitted", actor: "user", turnId: "home-again", text: "Show Home" }).isPersisted.promise
  await controller.store.dispatch({ type: "card.upsert", actor: "smithers", card: home }).isPersisted.promise
  await settle()
  const card = host.querySelector('.guide-transcript [data-testid="card-entry-home"]')
  expect(card !== null).toBe(true)
  const user = host.querySelector('.guide-transcript [data-role="user"]')!
  expect(user.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}, 2_000)


test("optional background setup can be deferred without a launch receipt", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(12, still, { repo: "will/demo", notice: "Setup failed", noticeDetail: "upstream detail" }, c => { controller = c })
  expect(text(host.querySelector(".guide-actions [data-secondary]"))).toContain("Do this later")
  await controller.guideAct("decline", "background")
  await settle()
  const guide = controller.store.session().guide!
  expect(guide.step).toBe(13)
  expect(guide.declined).toContain("background")
  expect(guide.completed).not.toContain("librarian.runs.launched")
  expect(guide.notice).toBeUndefined()
  expect(guide.noticeDetail).toBeUndefined()
}, 2_000)


test("saved raw setup errors become one concise action-row message with closed technical details", async () => {
  const raw = '{"status":502,"message":"upstream failed"}'
  const host = await mountGuide(12, still, { repo: "will/demo", notice: `Create Wiki didn't start: ${raw}` })
  const notice = host.querySelector(".guide-actions [data-notice]")!
  expect(text(notice.querySelector("p"))).toBe("Wiki couldn't start. Retry Wiki, or choose Do this later to keep going.")
  expect(notice.querySelector("details")?.open).toBe(false)
  expect(text(notice.querySelector("pre"))).toBe(raw)
  expect(host.querySelectorAll("[data-notice]").length).toBe(1)
  expect(text(host.querySelector('.guide-actions [data-flow="wiki.create"]'))).toContain("Retry Wiki")
}, 2_000)

test("a sign-in answer scrolls into the tutorial read without changing the lesson", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(3, still, {}, c => { controller = c })
  const viewport = host.querySelector<HTMLElement>(".guide-transcript")!
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const geometry = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    if (this === viewport) return { top: 100, bottom: 600, height: 500 } as DOMRect
    if (this.matches('[data-testid="auth-prompt"]')) return { top: 850 - viewport.scrollTop, height: 100 } as DOMRect
    return originalRect.call(this)
  })
  const moves: number[] = []
  viewport.scrollTo = (options: ScrollToOptions | number = {}) => {
    if (typeof options !== "number" && options.top !== undefined) {
      moves.push(options.top)
      viewport.scrollTop = options.top
    }
  }
  try {
    await controller.store.dispatch({ type: "message.appended", actor: "system", text: "Sign in to connect Linear.",
      action: { flow: "auth.sign-in", label: "Sign in with GitHub" },
    }).isPersisted.promise
    await settle()
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cancelAnimationFrame(frame)
        reject(new Error('Guide scroll frame did not run within 500 ms'))
      }, 500)
      const frame = requestAnimationFrame(() => { clearTimeout(timeout); resolve() })
    })
    expect(moves.at(-1)).toBe(740)
    expect(controller.store.session().guide?.step).toBe(3)
    viewport.scrollTop = 200
    viewport.dispatchEvent(new Event("scroll"))
    host.querySelector('.guide-message')?.dispatchEvent(new Event("animationend", { bubbles: true }))
    expect(viewport.scrollTop).toBe(200)
  } finally {
    geometry.mockRestore()
  }
}, 2_000)

test("closing Chat keeps its answer anchored independently of the composer", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(2, still, { conversationOpen: true }, c => { controller = c })
  const viewport = host.querySelector<HTMLElement>(".guide-transcript")!
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const geometry = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    if (this === viewport) return { top: 100, bottom: 600, height: 500 } as DOMRect
    if (this.matches('[data-chat-message-id]')) return { top: 650 - viewport.scrollTop } as DOMRect
    if (this.matches('[data-message-step="2"]')) return { top: 110 - viewport.scrollTop } as DOMRect
    return originalRect.call(this)
  })
  viewport.scrollTo = (options: ScrollToOptions | number = {}) => {
    if (typeof options !== "number" && options.top !== undefined) viewport.scrollTop = options.top
  }
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  try {
    await controller.store.dispatch({ type: "message.submitted", actor: "user", turnId: "paused", text: "What is issue 3 about?" }).isPersisted.promise
    await controller.store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "paused-answer", kind: "anonymous-ceiling", title: "Exploring is paused", status: "active", ordinal: 100, createdAt: 100,
      payload: { message: "Sign in with GitHub to keep going.", retryAt: null },
    } }).isPersisted.promise
    await settle()
    await frame()
    expect(viewport.scrollTop).toBe(540)
    await controller.guideAct("close")
    await settle()
    await frame()
    host.querySelector('.guide-message')?.dispatchEvent(new Event("animationend", { bubbles: true }))
    expect(controller.store.session().guide?.conversationOpen).toBe(false)
    expect(viewport.scrollTop).toBe(540)
    expect(host.querySelector('.guide-transcript [data-kind="anonymous-ceiling"] [data-flow="auth.sign-in"]')).not.toBeNull()
  } finally { geometry.mockRestore(); controller.dispose() }
}, 2_000)

for (const kind of ["wiki", "history"] as const) test(`${kind} launch receipt uses the pill's name without internal ids`, async () => {
  const host = await mountGuide(12, still, { repo: "will/demo" }, async controller => {
    await controller.store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: `launch-${kind}`, kind: "run-trace", title: "Background run", status: "active", ordinal: 100, createdAt: 100,
      payload: { repo: "will/demo", runId: "run-7", workflow: `librarian/${kind}`, phase: "running",
        steps: [`Started librarian/${kind} on will/demo (run run-7).`], result: null, lastSeq: 0,
        input: { _librarian: { kind, scope: "test", inspected: false } } },
    } }).isPersisted.promise
  })
  expect(text(host.querySelector(`[data-run-chip="${kind}"]`))).toBe(`${kind === "wiki" ? "Wiki" : "Mythical history"} started on will/demo`)
}, 2_000)


test("ArrowRight on an incomplete lesson gives quiet guidance without a flow-name toast", async () => {
  let controller!: ReturnType<typeof createAppController>
  const host = await mountGuide(4, still, {}, c => { controller = c })
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }))
  for (let tick = 0; tick < 30 && !host.querySelector("[data-notice]"); tick++) await settle()
  expect(controller.store.session().guide?.step).toBe(4)
  expect(text(host.querySelector("[data-notice]"))).toBe("Finish this step first.")
  expect([...controller.store.collections.toasts.values()]).toEqual([])
}, 2_000)

test("Finish projects Home first, omits practice frames, and retains the working replay door", async () => {
  const host = await mountGuide(14, still, { finished: true }, async controller => {
    const store = controller.store
    await store.dispatch({ type: "repository.upserted", actor: "system", repository: { id: "acme/api", org: "acme", name: "api", ownerKind: "user", head: null } }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "user", id: "acme/api" }).isPersisted.promise
    await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "practice-issue-flows-3", kind: "workflow-list", title: "Issue #3 · Flows", status: "active", ordinal: 1, createdAt: 1,
      payload: { repo: PRACTICE_REPO, workflows: [] } } }).isPersisted.promise
    await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "home", kind: "repo-home", title: "Home · acme/api", status: "active", ordinal: 3, createdAt: 1,
      payload: { repo: "acme/api", path: ".smithers/home.json", blocks: [{ type: "text", text: "Repository home" }], featuredFlows: null } } }).isPersisted.promise
    await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "real-read", kind: "file", title: "README.md", status: "active", ordinal: 2, createdAt: 1,
      payload: { repo: "other/repo", path: "README.md", content: "Real work stays", truncated: false } } }).isPersisted.promise
  }, <App />)
  await settle()
  expect(host.querySelector(".guide-shell") === null).toBe(true)
  expect(host.querySelector('.smithers-card')?.getAttribute("data-kind")).toBe("repo-home")
  expect(host.textContent).not.toContain("Issue #3 · Flows")
  expect(host.querySelector('[data-testid="card-real-read"]') !== null).toBe(true)
  const replay = host.querySelector<HTMLButtonElement>('[data-flow="tut"]')!
  expect(text(replay)).toBe("Replay introduction")
  replay.click()
  for (let tick = 0; tick < 30 && !host.querySelector('.guide-shell[data-stage="1"]'); tick++) await settle()
  expect(host.querySelector('.guide-shell[data-stage="1"]') !== null).toBe(true)
}, 2_000)
