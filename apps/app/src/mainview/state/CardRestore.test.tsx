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
import { memoryStorage, settled, silentAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * Ask 8 (will, 2026-09-02): "when I maximize a file I have no way of
 * minimizing it". A maximized card carries a named Restore button, and the
 * two ambient exits — Escape and the backdrop — put the card back too. All
 * three go through the restore flow that already exists (card.minimize);
 * none of them is a second implementation.
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

const act = (work: () => void): void => {
  flushSync(work)
}

/** A file card in the transcript: the card the ask was reported against. */
const withFileCard = async (): Promise<{ store: AppStore; controller: AppControllerType }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, silentAgent)
  store.dispatch({
    type: "card.upsert",
    actor: "smithers",
    card: {
      id: "file-one",
      kind: "file",
      title: "File · smithersai/smithers · README.md",
      status: "active",
      createdAt: Date.now(),
      ordinal: 10,
      payload: {
        repo: "smithersai/smithers",
        path: "notes.txt",
        content: "one\ntwo\nthree\n",
        truncated: false
      }
    }
  })
  await settled()
  return { store, controller }
}

const fileCard = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>(".smithers-card[data-kind=\"file\"]")

describe("a maximized card always states the way back (ask 8)", () => {
  test("the Restore button is on screen while the card is maximized, and puts it back", async () => {
    const { store, controller } = await withFileCard()
    const host = mount(controller)

    act(() => host.querySelector<HTMLButtonElement>("[data-flow=\"card.maximize\"]")?.click())
    expect(fileCard(host)?.dataset.maximized).toBe("true")

    const restore = host.querySelector<HTMLButtonElement>("[data-testid=\"card-minimize-file-one\"]")
    expect(restore).not.toBeNull()
    expect(restore?.dataset.flow).toBe("card.minimize")
    expect(restore?.textContent).toContain("Restore")

    act(() => restore?.click())
    expect(fileCard(host)?.dataset.maximized).toBe("false")
    expect(store.session().maximizedCardId).toBeNull()
    expect(host.querySelector(".card-maximize-backdrop")).toBeNull()
  })

  test("Escape restores a maximized card", async () => {
    const { store, controller } = await withFileCard()
    const host = mount(controller)

    act(() => host.querySelector<HTMLButtonElement>("[data-flow=\"card.maximize\"]")?.click())
    expect(store.session().maximizedCardId).toBe("file-one")

    act(() => {
      host.querySelector(".smithers-card[data-kind=\"file\"]")?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    })
    expect(store.session().maximizedCardId).toBeNull()
    expect(fileCard(host)?.dataset.maximized).toBe("false")
  })

  test("the backdrop restores a maximized card", async () => {
    const { store, controller } = await withFileCard()
    const host = mount(controller)

    act(() => host.querySelector<HTMLButtonElement>("[data-flow=\"card.maximize\"]")?.click())
    const backdrop = host.querySelector<HTMLElement>(".card-maximize-backdrop")
    expect(backdrop).not.toBeNull()

    act(() => backdrop?.click())
    expect(store.session().maximizedCardId).toBeNull()
    expect(fileCard(host)?.dataset.maximized).toBe("false")
  })
})
