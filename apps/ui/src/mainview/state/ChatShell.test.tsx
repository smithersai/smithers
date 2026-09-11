import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { memoryStorage, settled, unavailableAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The chat-first contract: World and Connectors are embedded panes inside the
 * persistent chat shell, never full-screen takeovers. These tests pin all three
 * halves — the state/command half (opening a pane never touches messages or the
 * draft, and `chat` is the registered back-to-conversation command), the render
 * half (transcript and composer stay mounted alongside the pane), and the
 * identity half (the transcript and composer DOM nodes are the SAME nodes across
 * the transition, so nothing about the conversation is torn down and rebuilt).
 */

GlobalRegistrator.register()

/*
 * bun test shares one process across test files, so the DOM globals registered
 * above would otherwise leak into every file that runs after this one and
 * silently flip `typeof window`/`typeof document` branches (AppStore's theme
 * detection reads both). Registration is confined to this file's run.
 */
afterAll(async () => {
  // React's scheduler drains unmount work on a macrotask that reads `window`,
  // so the globals have to outlive the last teardown by a tick or two.
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

interface Mount {
  readonly host: HTMLElement
  readonly markup: () => string
  /** Run a state change and flush React, the way a real click does. */
  readonly act: (change: () => void) => Promise<void>
}

/** Client-render the app into a fresh DOM node and keep the root live. */
const mount = (controller: AppControllerType): Mount => {
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
  return {
    host,
    markup: () => host.innerHTML,
    act: async (change) => {
      flushSync(change)
      // Collection subscriptions land on a microtask; flush what they queued.
      await new Promise((resolve) => setTimeout(resolve, 0))
      flushSync(() => {})
    }
  }
}

/** The one-shot render the markup-only assertions use. */
const renderApp = (controller: AppControllerType): string => mount(controller).markup()

const harness = async (): Promise<{ store: AppStore; controller: AppControllerType }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent)
  return { store, controller }
}

describe("chat-first shell: panes never replace the conversation", () => {
  test("opening World or Connectors changes only the pane, never the messages or draft", async () => {
    const { store, controller } = await harness()
    const before = [...store.collections.messages.values()].map((message) => message.id)
    controller.changeDraft("a draft that must survive")

    expect(controller.runCommand("world")).toBe(true)
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.get("world-embedded")?.kind).toBe("world")
    expect([...store.collections.messages.values()].map((message) => message.id)).toEqual(before)
    expect(store.session().draft).toBe("a draft that must survive")

    expect(controller.runCommand("connect")).toBe(true)
    expect(store.session().surface).toBe("connectors")
    expect([...store.collections.messages.values()].map((message) => message.id)).toEqual(before)
    expect(store.session().draft).toBe("a draft that must survive")
  })

  test("the back-to-conversation affordance is the registered `chat` command", async () => {
    const { store, controller } = await harness()
    expect(controller.commands.find("chat")).toBeDefined()

    store.dispatch({ type: "surface.changed", actor: "user", surface: "world" })
    expect(store.session().surface).toBe("world")
    expect(controller.runCommand("chat")).toBe(true)
    expect(store.session().surface).toBe("chat")
  })

  test("with the World pane open the transcript and composer still render, with content intact", async () => {
    const { store, controller } = await harness()
    // Wave 14 §1: nothing is seeded into the transcript, so "content intact"
    // is pinned against a real turn the session actually holds.
    await store.dispatch({
      type: "message.submitted",
      actor: "user",
      turnId: "turn-shell",
      text: "a turn that must survive the pane"
    }).isPersisted.promise
    controller.changeDraft("draft stays in the composer")
    // Previously persisted pane navigation remains renderable; the Wiki flow now embeds.
    store.dispatch({ type: "surface.changed", actor: "user", surface: "world" })

    const markup = renderApp(controller)
    expect(markup).toContain("world-surface")
    expect(markup).toContain("smithers-transcript")
    expect(markup).toContain("smithers-composer")
    expect(markup).toContain("draft stays in the composer")
    expect(markup).toContain("a turn that must survive the pane")
    expect(store.session().surface).toBe("world")
  })

  test("with the Connectors pane open the transcript and composer still render", async () => {
    const { controller } = await harness()
    controller.runCommand("connect")

    const markup = renderApp(controller)
    expect(markup).toContain("connectors-surface")
    expect(markup).toContain("smithers-transcript")
    expect(markup).toContain("smithers-composer")
  })

  test("closing the pane returns to the conversation with nothing lost", async () => {
    const { store, controller } = await harness()
    controller.changeDraft("still here")
    controller.runCommand("connect")
    controller.runCommand("chat")

    const markup = renderApp(controller)
    expect(store.session().surface).toBe("chat")
    expect(markup).not.toContain("connectors-surface")
    expect(markup).not.toContain("world-surface")
    expect(markup).toContain("smithers-composer")
    expect(markup).toContain("still here")
  })

  test("a sent message stays in the transcript across pane open and close", async () => {
    const { controller } = await harness()
    controller.send("remember this message")
    await settled()

    controller.runCommand("world")
    const openMarkup = renderApp(controller)
    expect(openMarkup).toContain("remember this message")
    expect(openMarkup).toContain("world-card-workspace")

    controller.runCommand("chat")
    const closedMarkup = renderApp(controller)
    expect(closedMarkup).toContain("remember this message")
    expect(closedMarkup).not.toContain("world-surface")
  })

  /*
   * The bug this shell exists to prevent: "still rendered" is not the contract
   * — "never unmounted" is. A takeover that happened to re-render an identical
   * transcript would satisfy every markup assertion above and still throw away
   * scroll position, composer focus, and in-flight editor state. Node identity
   * across a live transition is the only assertion that catches it.
   */
  test("opening and closing panes never unmounts the transcript or the composer", async () => {
    const { store, controller } = await harness()
    controller.send("a message that must outlive every pane")
    await settled()

    const view = mount(controller)
    const transcript = view.host.querySelector(".smithers-transcript")
    const composer = view.host.querySelector("textarea")
    expect(transcript).not.toBeNull()
    expect(composer).not.toBeNull()

    for (const pane of ["connect", "world"] as const) {
      await view.act(() => {
        if (pane === "world") store.dispatch({ type: "surface.changed", actor: "user", surface: "world" })
        else controller.runCommand(pane)
      })
      expect(store.session().surface).toBe(pane === "connect" ? "connectors" : "world")
      expect(view.host.querySelector(".embedded-pane")).not.toBeNull()
      // The very same nodes, not equivalent replacements.
      expect(view.host.querySelector(".smithers-transcript")).toBe(transcript)
      expect(view.host.querySelector("textarea")).toBe(composer)
      expect(view.markup()).toContain("a message that must outlive every pane")

      await view.act(() => void controller.runCommand("chat"))
      expect(store.session().surface).toBe("chat")
      expect(view.host.querySelector(".embedded-pane")).toBeNull()
      expect(view.host.querySelector(".smithers-transcript")).toBe(transcript)
      expect(view.host.querySelector("textarea")).toBe(composer)
      expect(view.markup()).toContain("a message that must outlive every pane")
    }
  })

  test("a draft typed into the live composer survives opening and closing a pane", async () => {
    const { store, controller } = await harness()
    const view = mount(controller)

    await view.act(() => controller.changeDraft("half-written thought"))
    const composer = view.host.querySelector("textarea")
    expect(composer?.value).toBe("half-written thought")

    await view.act(() => void controller.runCommand("world"))
    expect(view.host.querySelector("textarea")).toBe(composer)
    expect(composer?.value).toBe("half-written thought")
    expect(store.session().draft).toBe("half-written thought")

    await view.act(() => void controller.runCommand("chat"))
    expect(composer?.value).toBe("half-written thought")
    expect(store.session().draft).toBe("half-written thought")
  })

  test("the pane's close affordance is a real, registered, back-to-conversation button", async () => {
    const { store, controller } = await harness()
    const view = mount(controller)
    await view.act(() => void controller.runCommand("connect"))

    const close = view.host.querySelector<HTMLButtonElement>(
      ".embedded-pane [data-flow=\"chat\"]"
    )
    expect(close).not.toBeNull()
    expect(controller.commands.find(close?.dataset.flow ?? "")).toBeDefined()

    // Clicking the affordance itself — not the command behind it — closes it.
    await view.act(() => close?.click())
    expect(store.session().surface).toBe("chat")
    expect(view.host.querySelector(".embedded-pane")).toBeNull()
    expect(view.host.querySelector("textarea")).not.toBeNull()
  })

  test("the composer's surfaces menu opens the panes without leaving chat", async () => {
    const { store, controller } = await harness()
    const view = mount(controller)

    for (
      const [command, paneClass] of [
        ["connect", "connectors-surface"],
        ["wiki", "world-card-workspace"]
      ] as const
    ) {
      // The surface buttons collapsed into ONE dropdown (§2c′): open it,
      // then invoke the entry — a direct command binding, state-aware.
      const trigger = view.host.querySelector<HTMLButtonElement>(".composer-menu-trigger")
      expect(trigger).not.toBeNull()
      await view.act(() => trigger?.click())
      const item = view.host.querySelector<HTMLButtonElement>(
        `.composer-menu-item[data-flow="${command}"]`
      )
      expect(item).not.toBeNull()

      await view.act(() => item?.click())
      expect(store.session().surface).toBe(command === "connect" ? "connectors" : "chat")
      expect(view.host.querySelector(`.${paneClass}`)).not.toBeNull()
      // The toggle law (§2c): invoking the open pane's entry returns to chat.
      await view.act(() => trigger?.click())
      const again = view.host.querySelector<HTMLButtonElement>(
        `.composer-menu-item[data-flow="${command}"]`
      )
      expect(again?.getAttribute("aria-pressed")).toBe(command === "connect" ? "true" : "false")
      await view.act(() => again?.click())
      expect(store.session().surface).toBe("chat")
      if (command === "connect") expect(view.host.querySelector(`.${paneClass}`)).toBeNull()
      else expect(view.host.querySelector(`.${paneClass}`)).not.toBeNull()
      expect(view.host.querySelector("textarea")).not.toBeNull()
      expect(view.host.querySelector(".smithers-transcript")).not.toBeNull()
    }
  })
})
