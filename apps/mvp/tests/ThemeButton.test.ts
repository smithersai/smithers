// @vitest-environment happy-dom
import { Persistence } from "@smthrs/effect-tanstack-db"
import { Action } from "@smthrs/flow"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { build } from "../worker/test/flowHost"
import { ClientEngine, FlowDispatch } from "../src/flows/dispatch.vibe"
import { FlowRegistry } from "../src/flows/registry.vibe"
import { THEME_ATTRIBUTE, THEME_MIRROR_KEY, type ThemeMode } from "../src/features/theme/contract"
import { ThemeButton, ThemeProvider, useShownMode } from "../src/features/theme/components/ThemeButton"
import { registration, SetTheme } from "../src/features/theme/flows.vibe"
import { tabPreferences, ThemeStore } from "../src/features/theme/store.vibe"
import { Theme } from "../src/features/theme/theme.vibe"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  document.documentElement.removeAttribute(THEME_ATTRIBUTE)
  localStorage.removeItem(THEME_MIRROR_KEY)
})

// A second view using the same hook as the terminal: both mounted consumers must update together.
const ModeView = () => createElement("output", null, useShownMode())

test("system changes update the button and every mode view without saving a preference", async () => {
  const scope = Effect.runSync(Scope.make())
  disposals.push(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  let system: ThemeMode = "light"
  const changes = new EventTarget()
  // The inline first paint pins the boot system mode until the store follows a change.
  document.documentElement.setAttribute(THEME_ATTRIBUTE, "light")
  const storeLayer = ThemeStore.layer({
    system: () => system,
    systemChanges: changes,
    painted: () => (document.documentElement.getAttribute(THEME_ATTRIBUTE) as ThemeMode | null) ?? undefined,
    paint: (mode) => {
      if (mode === undefined) document.documentElement.removeAttribute(THEME_ATTRIBUTE)
      else document.documentElement.setAttribute(THEME_ATTRIBUTE, mode)
    },
    mirror: (mode) => {
      if (mode === undefined) localStorage.removeItem(THEME_MIRROR_KEY)
      else localStorage.setItem(THEME_MIRROR_KEY, mode)
    },
  }).pipe(Layer.provide(Persistence.memory))
  const { context } = await Effect.runPromise(Scope.provide(scope)(build(registration.pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provide(tabPreferences),
    Layer.provideMerge(storeLayer),
  ))))
  const store = Context.get(context, ThemeStore)
  const themeContext = await Effect.runPromise(Scope.provide(scope)(Layer.build(Theme.layer.pipe(
    Layer.provide(FlowDispatch.layer.pipe(Layer.provide(FlowRegistry.layer))),
    Layer.provide(ClientEngine.layerRuntime([SetTheme])),
    Layer.provide(Layer.succeedContext(context)),
  ))))
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  disposals.push(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  await act(async () => root.render(createElement(ThemeProvider, { value: Context.get(themeContext, Theme) },
    createElement(ThemeButton), createElement(ModeView), createElement(ModeView),
  )))
  const check = async (mode: ThemeMode) => vi.waitFor(async () => {
    await act(async () => {})
    expect(container.querySelector("button")?.getAttribute("aria-label"))
      .toBe(mode === "dark" ? "Switch to light mode" : "Switch to dark mode")
    expect(container.querySelectorAll("button circle")).toHaveLength(mode === "dark" ? 1 : 0)
    expect([...container.querySelectorAll("output")].map((node) => node.textContent)).toEqual([mode, mode])
  })
  const changeSystem = async (mode: ThemeMode) => {
    await act(async () => {
      system = mode
      changes.dispatchEvent(new Event("change"))
    })
  }
  await check("light")
  for (const mode of ["dark", "light", "dark"] as const) {
    await changeSystem(mode)
    await check(mode)
    expect(document.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false)
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBeNull()
    expect(await Effect.runPromise(store.preferences.toArray)).toEqual([])
  }

  // A real click dispatches the durable flow and pins the opposite mode in every view.
  await act(async () => container.querySelector("button")!.click())
  await check("light")
  await vi.waitFor(() => expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("light"))
  await changeSystem("light")
  await changeSystem("dark")
  await check("light")
  expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light")
  expect(await Effect.runPromise(store.preferences.toArray)).toMatchObject([{ mode: "light" }])

  // Deletion clears both overrides; later changes still update every consumer.
  await act(async () => { await Effect.runPromise(store.preferences.delete("theme")) })
  await check("dark")
  expect(document.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false)
  expect(localStorage.getItem(THEME_MIRROR_KEY)).toBeNull()
  await changeSystem("light")
  await check("light")
})
