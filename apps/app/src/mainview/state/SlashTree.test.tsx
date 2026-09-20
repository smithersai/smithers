/*
 * The slash menu as a tree (registry.slashTree): a bare "/" lists surfaces,
 * recommendations, and namespace rows; Enter / ArrowRight on a namespace
 * rewrites the draft to `/ns.`, ArrowLeft walks back to "/", and a leaf's
 * Enter still runs the flow. Pinned against the real App + registry.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll,afterEach,describe,expect,test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage,unavailableAgent,unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

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

interface View {
  readonly controller: AppControllerType
  readonly host: HTMLElement
  readonly act: (change: () => void) => Promise<void>
}

const mount = async (): Promise<View> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent)
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
  const act = async (change: () => void): Promise<void> => {
    flushSync(change)
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => {})
  }
  await act(() => {})
  return { controller, host, act }
}

const textarea = (host: HTMLElement): HTMLTextAreaElement | null => host.querySelector<HTMLTextAreaElement>("textarea")

const rows = (host: HTMLElement): Array<string> =>
  Array.from(host.querySelectorAll<HTMLElement>(".slash-menu [role='option']")).map((option) =>
    option.dataset["namespace"] !== undefined ? `${option.dataset["namespace"]}/` : option.dataset["flow"] ?? ""
  )

/* The shell's live registry manifest (App.tsx `data-flows`). */
const manifest = (host: HTMLElement): Array<string> =>
  (host.querySelector<HTMLElement>("[data-flows]")?.dataset["flows"] ?? "").split(" ")

const press = async (view: View, key: string): Promise<void> => {
  await view.act(() => {
    textarea(view.host)?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
}

describe("the slash menu is a tree", () => {
  test("a bare / lists surfaces and namespace rows, never a loose top-level toggle", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("/"))
    const listed = rows(view.host)
    expect(listed[0]).toBe("connect")
    expect(listed).toContain("appearance/")
    expect(listed).toContain("chat/")
    expect(listed).not.toContain("appearance.dark-mode")
    expect(listed).not.toContain("dark-mode")
    const namespace = view.host.querySelector<HTMLElement>(".slash-menu [data-namespace='appearance']")
    expect(namespace?.textContent).toContain("Appearance")
  })

  test("Enter or ArrowRight on a namespace opens the branch; ArrowLeft returns to the top", async () => {
    const view = await mount()
    const recent = view.controller.store.session().recentCommands ?? []
    await view.act(() => view.controller.changeDraft("/app"))
    // `/app` offers the namespace row first.
    expect(rows(view.host)[0]).toBe("appearance/")
    await press(view, "Enter")
    expect(view.controller.store.session().draft).toBe("/appearance.")
    expect(rows(view.host)).toEqual(["appearance.theme", "appearance.dark-mode"])
    // Nothing ran: opening a branch is a draft edit.
    expect(view.controller.store.session().recentCommands ?? []).toEqual(recent)
    await press(view, "ArrowLeft")
    expect(view.controller.store.session().draft).toBe("/")
    // Move to the chat namespace using the rendered catalog order.
    const chatIndex = rows(view.host).indexOf("chat/")
    expect(chatIndex).toBeGreaterThanOrEqual(0)
    for (let index = 0; index < chatIndex; index++) await press(view, "ArrowDown")
    const highlighted = view.host.querySelector<HTMLElement>(".slash-menu [data-highlighted='true']")
    expect(highlighted?.dataset["namespace"]).toBe("chat")
    await press(view, "ArrowRight")
    expect(view.controller.store.session().draft).toBe("/chat.")
  })

  test("a leaf's Enter runs the flow by name", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("/appearance."))
    await press(view, "ArrowDown")
    await press(view, "Enter")
    expect(view.controller.store.session().draft).toBe("")
    expect(view.controller.store.session().recentCommands?.[0]).toBe("appearance.dark-mode")
  })
})

/*
 * The menu is a live read of the registry, and the experimental namespace is
 * registered live off the session switch (flows/Commands.ts `entries`): the
 * listing has to follow a toggle the AGENT made, with no keystroke of the
 * human's to refresh it.
 */
describe("the slash menu follows the experimental switch", () => {
  test("a toggle with no keystroke adds and removes the branch's rows", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("/experimental."))
    expect(rows(view.host)).toEqual([])
    await view.controller.commands.run("app.experimental", "on")
    await view.act(() => {})
    expect(rows(view.host)).toContain("experimental.plan")
    expect(manifest(view.host)).toContain("experimental.plan")
    await view.controller.commands.run("app.experimental", "off")
    await view.act(() => {})
    expect(rows(view.host)).toEqual([])
    expect(manifest(view.host)).not.toContain("experimental.plan")
  })
})
