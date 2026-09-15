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
import { INTRO_SLIDES } from "./introScript"

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
const still: GuideClock = { setTimeout: () => 1, clearTimeout: () => {} }
const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  flushSync(() => {})
}

/* The launch flow is recorded but not executed; onboarding.act calls through so the guide state moves. */
const mountStage12 = async (): Promise<{ host: HTMLElement; calls: Array<[string, string?]> }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, silentAgent)
  const real = controller.runCommand.bind(controller)
  const calls: Array<[string, string?]> = []
  spyOn(controller, "runCommand").mockImplementation((name, args) => {
    calls.push([name, args])
    return name === "onboarding.act" ? real(name, args) : true
  })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 12, repo: "acme/api", autoPaused: true } }).isPersisted.promise
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ControllerTestProvider controller={controller}><GuideShell clock={still}><div /></GuideShell></ControllerTestProvider>))
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return { host, calls }
}

const press = async (key: string) => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  document.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }))
  await settle()
}

test("launching the Wiki at beat 12 opens its introduction; → advances; Escape closes and focus returns", async () => {
  const { host, calls } = await mountStage12()
  await press("u")
  const dialog = host.querySelector<HTMLElement>('.guide-intro-dock[data-intro="wiki"]')!
  expect(dialog !== null).toBe(true)
  expect(dialog.getAttribute("role")).toBe("dialog")
  expect(dialog.getAttribute("aria-modal")).toBe("true")
  expect(dialog.getAttribute("aria-labelledby")).toBe("guide-intro-heading")
  expect(text(dialog.querySelector("#guide-intro-heading"))).toBe(INTRO_SLIDES.wiki[0]!.headline)
  expect(text(dialog.querySelector(".guide-intro-chip"))).toBe("Building…")
  expect(dialog.querySelector(".guide-intro-art") !== null).toBe(true)
  expect(dialog.querySelectorAll(".guide-intro-dots span").length).toBe(INTRO_SLIDES.wiki.length)
  expect(dialog.querySelector(".guide-intro-dots")?.getAttribute("aria-label")).toBe("Slide 1 of 4")
  expect(dialog.contains(document.activeElement)).toBe(true)
  await press("ArrowRight")
  expect(text(host.querySelector("#guide-intro-heading"))).toBe(INTRO_SLIDES.wiki[1]!.headline)
  expect(host.querySelector(".guide-intro-dots")?.getAttribute("aria-label")).toBe("Slide 2 of 4")
  await press("Enter")
  expect(text(host.querySelector("#guide-intro-heading"))).toBe(INTRO_SLIDES.wiki[2]!.headline)
  await press("b")
  expect(text(host.querySelector("#guide-intro-heading"))).toBe(INTRO_SLIDES.wiki[1]!.headline)
  await press("Escape")
  expect(host.querySelector(".guide-intro-dock") === null).toBe(true)
  const launcher = host.querySelector<HTMLElement>('.guide-actions [data-flow="wiki.create"]')!
  expect(document.activeElement === launcher).toBe(true)
  expect(calls.filter(([name]) => name === "wiki.create")).toEqual([["wiki.create", "acme/api"]])
}, 5_000)

test("launching Mythical history opens its introduction; the last slide returns to the tutorial", async () => {
  const { host, calls } = await mountStage12()
  await press("y")
  const dialog = host.querySelector<HTMLElement>('.guide-intro-dock[data-intro="history"]')!
  expect(dialog !== null).toBe(true)
  expect(text(dialog.querySelector("#guide-intro-heading"))).toBe(INTRO_SLIDES.history[0]!.headline)
  for (let slide = 1; slide < INTRO_SLIDES.history.length; slide++) await press("ArrowRight")
  const next = host.querySelector<HTMLButtonElement>("[data-intro-next]")!
  expect(text(next)).toBe("Back to tutorial →")
  flushSync(() => next.click())
  await settle()
  expect(host.querySelector(".guide-intro-dock") === null).toBe(true)
  const launcher = host.querySelector<HTMLElement>('.guide-actions [data-flow="history.bootstrap"]')!
  expect(document.activeElement === launcher).toBe(true)
  expect(calls.filter(([name]) => name === "history.bootstrap")).toEqual([["history.bootstrap", "acme/api"]])
}, 5_000)

test("each introduction presents once: a retry launches again without replaying the slideshow", async () => {
  const { host, calls } = await mountStage12()
  await press("u")
  expect(host.querySelector('.guide-intro-dock[data-intro="wiki"]') !== null).toBe(true)
  await press("Escape")
  expect(host.querySelector(".guide-intro-dock") === null).toBe(true)
  await press("y")
  expect(host.querySelector('.guide-intro-dock[data-intro="history"]') !== null).toBe(true)
  await press("Escape")
  await press("u")
  expect(host.querySelector(".guide-intro-dock") === null).toBe(true)
  expect(calls.filter(([name]) => name === "wiki.create")).toEqual([["wiki.create", "acme/api"], ["wiki.create", "acme/api"]])
}, 5_000)
