import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { CardView } from "../ChatCards"
import { cardActions } from "../cards/CardActions"
import { renderCardBody } from "../cards/CardRenderers"
import type { CardOf } from "../cards/CardFamily"
import { flowArgs } from "../flows/FlowArgs"
import type { CommandOutcome } from "../flows/Commands"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import { memoryStorage, unavailableAgent, unavailableRepositories } from "../state/TestFixtures"
import { Graph, Table } from "./Primitives"
import { EXPERIMENTAL_MANIFEST } from "./Manifest"
import type { ExperimentalPane } from "./Pane"
import * as Registry from "./Registry"

GlobalRegistrator.register()
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT
actGlobal.IS_REACT_ACT_ENVIRONMENT = true
const createAppController = scopedControllers()
const mounted = new Map<Root, HTMLDivElement>()

afterEach(async () => {
  for (const [root, host] of mounted) {
    await act(async () => root.unmount())
    host.remove()
  }
  mounted.clear()
})
afterAll(async () => {
  if (previousActEnvironment === undefined) delete actGlobal.IS_REACT_ACT_ENVIRONMENT
  else actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  await GlobalRegistrator.unregister()
})

const mount = async (body: ReactNode) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted.set(root, host)
  const render = async (next: ReactNode) => { await act(async () => root.render(next)) }
  await render(body)
  return { host, render, unmount: async () => {
    await act(async () => root.unmount())
    host.remove()
    mounted.delete(root)
  } }
}

const boot = async (experimental: boolean) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, { features: { experimental } })
  return { controller, store }
}

const savedCard: CardOf<"experimental"> = {
  id: "saved-plan", kind: "experimental", title: "Plan", status: "active", createdAt: 1, ordinal: 1,
  payload: { pane: "plan", props: { nodeId: "build" } }
}

describe("experimental card rendering", () => {
  test("a persisted disabled card has exactly one body line and never loads a pane", async () => {
    const { controller, store } = await boot(false)
    await store.dispatch({ type: "card.upsert", actor: "system", card: savedCard }).isPersisted.promise
    const loader = spyOn(Registry, "loadPane")
    try {
      const actions = { ...cardActions(controller), worldDocuments: [] }
      expect(actions.experimental).toBe(false)
      const view = await mount(<CardView card={savedCard} maximized={false} {...actions} />)
      const body = view.host.querySelector(".smithers-card-body")!
      expect(body.innerHTML).toBe('<p class="experimental-missing">Experimental panes are disabled.</p>')
      expect(loader).not.toHaveBeenCalled()
      // Prove the spy sees the real lazy import, then disable an already loaded pane.
      await view.render(renderCardBody(savedCard, { ...actions, experimental: true }))
      expect(loader).toHaveBeenCalledWith("plan")
      expect(view.host.querySelector('.experimental-pane[data-pane="plan"]')).not.toBeNull()
      loader.mockClear()
      await view.render(renderCardBody(savedCard, actions))
      expect(view.host.innerHTML).toBe('<p class="experimental-missing">Experimental panes are disabled.</p>')
      expect(loader).not.toHaveBeenCalled()
    } finally { loader.mockRestore() }
  })

  test("the mounted card and account switch follow the live setting", async () => {
    const { controller, store } = await boot(false)
    await store.dispatch({ type: "card.upsert", actor: "system", card: savedCard }).isPersisted.promise
    const account: CardOf<"account"> = {
      id: "account-test", kind: "account", title: "Account", status: "active", createdAt: 1, ordinal: 2,
      payload: { login: "will", allowlisted: true, accessRequested: false, scopes: [], boxes: [] }
    }
    const pending: Promise<CommandOutcome>[] = []
    const actions = { ...cardActions(controller), worldDocuments: [],
      onRunCommand: (name: string, args?: string) => { pending.push(controller.commands.run(name, args)) } }
    const view = await mount(<><CardView card={savedCard} maximized={false} {...actions} />
      <CardView card={account} maximized={false} {...actions} /></>)
    const toggle = view.host.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute("aria-label")).toBe("Experimental")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(view.host.querySelector(".experimental-missing")?.textContent).toBe("Experimental panes are disabled.")
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    await act(async () => { toggle.click(); await Promise.all(pending) })
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    expect(view.host.querySelector('.experimental-pane[data-pane="plan"]')).not.toBeNull()
    await act(async () => { await controller.commands.run("card.maximize", savedCard.id) })
    expect(store.session().maximizedCardId).toBe(savedCard.id)
    await act(async () => { toggle.click(); await Promise.all(pending) })
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(view.host.querySelector(".experimental-pane")).toBeNull()
    expect(view.host.querySelector(".experimental-missing")?.textContent).toBe("Experimental panes are disabled.")
    expect(store.session().maximizedCardId).toBeNull()
  })

  /*
   * Keyboard-only access (apps/app/AGENTS.md). The switch is a native button,
   * so Enter and Space ARE its activation — but happy-dom performs no default
   * action, so the proof is in two halves: the element is the one the browser
   * activates and nothing intercepts either key, and that activation runs the
   * flow. A div with an onClick passes every other test in this file.
   */
  test("the account switch is a native button and neither Enter nor Space is intercepted", async () => {
    const { controller, store } = await boot(false)
    const account: CardOf<"account"> = {
      id: "account-keys", kind: "account", title: "Account", status: "active", createdAt: 1, ordinal: 1,
      payload: { login: "will", allowlisted: true, accessRequested: false, scopes: [], boxes: [] }
    }
    const pending: Promise<CommandOutcome>[] = []
    const actions = { ...cardActions(controller), worldDocuments: [],
      onRunCommand: (name: string, args?: string) => { pending.push(controller.commands.run(name, args)) } }
    const view = await mount(<CardView card={account} maximized={false} {...actions} />)
    const toggle = view.host.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.tagName).toBe("BUTTON")
    expect(toggle.type).toBe("button")
    expect(toggle.disabled).toBe(false)
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    for (const key of ["Enter", " "]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
      await act(async () => { toggle.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(false)
    }
    for (const checked of [true, false]) {
      await act(async () => { toggle.click(); await Promise.all(pending) })
      expect(store.session().experimental).toBe(checked)
      expect(toggle.getAttribute("aria-checked")).toBe(String(checked))
    }
  })

  test("a card selection runs the typed flow, keeps its id, and renders again after remount", async () => {
    const { controller, store } = await boot(true)
    await controller.commands.runAsAgent("experimental.plan")
    const card = () => store.collections.cards.get("experimental:plan") as CardOf<"experimental">
    const pending: Promise<CommandOutcome>[] = []
    const onRunCommand = mock((name: string, args?: string) => { pending.push(controller.commands.run(name, args)) })
    const actions = { ...cardActions(controller), worldDocuments: [], onRunCommand }
    const body = () => <CardView card={card()} maximized={false} {...actions} />
    const first = await mount(body())
    const row = [...first.host.querySelectorAll<HTMLElement>('.xp-graph-node[role="button"]')].find(row => row.textContent?.includes("typecheck"))!
    expect(row).toBeDefined()
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
    expect(onRunCommand.mock.calls).toEqual([["experimental.set", flowArgs("experimental.set", {
      cardId: "experimental:plan", key: "nodeId", value: "typecheck"
    })]])
    expect((await Promise.all(pending)).map(outcome => outcome.status)).toEqual(["executed"])
    expect(card().id).toBe("experimental:plan")
    expect(card().payload.props?.nodeId).toBe("typecheck")
    await first.unmount()
    const second = await mount(body())
    expect(second.host.querySelector('.xp-graph-node[aria-pressed="true"]')?.textContent).toContain("typecheck")
  })

  test("a failed pane chunk reaches the card boundary and loads again on remount", async () => {
    const { controller } = await boot(true)
    // Keep this pane distinct from the plan card's already fulfilled lazy component.
    const card: CardOf<"experimental"> = {
      ...savedCard, id: "saved-index", title: "Experimental", payload: { pane: "index" }
    }
    const actions = { ...cardActions(controller), worldDocuments: [] }
    const body = () => <CardView card={card} maximized={false} {...actions} />
    const chunkError = new Error("Failed to fetch dynamically imported module")
    let attempts = 0
    const importPane = mock(async (file: string) => {
      attempts += 1
      if (attempts === 1) throw chunkError
      return await import(`./panes/${file}.tsx`) as { readonly Pane: ExperimentalPane }
    })
    // Inject below the real loader while leaving the card's React.lazy cache intact.
    const loadPane = Registry.loadPane
    const loader = spyOn(Registry, "loadPane").mockImplementation(id => loadPane(id, importPane))
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const first = await mount(body())
      const failure = first.host.querySelector('.smithers-card-body [data-card-error][role="alert"]')
      expect(failure?.textContent).toContain("This card's viewer did not load")
      expect(failure?.querySelector('[data-flow="chat.reload"]')?.textContent).toBe("Reload app")
      expect(first.host.querySelector('.experimental-pane[data-pane="index"]')).toBeNull()
      expect(errors).toHaveBeenCalledWith(`Card ${card.id} could not render`, chunkError, expect.any(String))
      expect(importPane.mock.calls).toEqual([["Index"]])

      await first.unmount()
      const second = await mount(body())
      await act(async () => { await importPane.mock.results[1]?.value })
      expect(second.host.querySelector("[data-card-error]")).toBeNull()
      expect(second.host.querySelector('.experimental-pane[data-pane="index"]')?.textContent).toContain("/experimental.plan")
      expect(importPane.mock.calls).toEqual([["Index"], ["Index"]])
    } finally {
      loader.mockRestore()
      errors.mockRestore()
    }
  })

  /*
   * One test per pane rather than one loop: thirty mounts share a single 5 s
   * budget otherwise, and under fleet load the loop reddens at pane ~28 with
   * an assertion error that is really the timeout's afterEach unmounting
   * mid-iteration. Per pane, a red names the pane and means what it says.
   */
  for (const entry of EXPERIMENTAL_MANIFEST.filter(entry => entry.id !== "index")) {
    test(`${entry.id}: its selection delegates its payload key and projects the stored value on remount`, async () => {
      const pane = await Registry.loadPane(entry.id)
      expect(pane).toBeDefined()
      const set = mock((_key: string, _value: string) => {})
      const context = { cardId: `experimental:${entry.id}`, props: {}, set, onRunCommand: mock(() => {}) }
      const view = await mount(pane!.render(context))
      const choices = view.host.querySelectorAll<HTMLElement>('[aria-pressed="false"]')
      expect(choices.length).toBeGreaterThan(0)
      const choice = choices[0]!
      const label = choice.textContent
      await act(async () => { choice.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
      expect(set.mock.calls.length).toBeGreaterThan(0)
      const props = Object.fromEntries(set.mock.calls)
      expect(Object.values(props).every(value => typeof value === "string")).toBe(true)
      await view.unmount()
      const restored = await mount(pane!.render({ ...context, props }))
      expect([...restored.host.querySelectorAll('[aria-pressed="true"]')].some(node => node.textContent === label)).toBe(true)
      expect(set.mock.calls.length).toBe(Object.keys(props).length)
      await restored.unmount()
    })
  }
})

describe("selectable primitives have a keyboard door", () => {
  for (const kind of ["Table", "Graph"] as const) {
    test(`${kind}: focus, Enter and Space select the addressed row`, async () => {
      const onSelect = mock((_id: string) => {})
      const body = (selected = "first") => kind === "Table"
        ? <Table columns={[{ key: "label", label: "Name" }]} rows={[{ id: "first", label: "First" }, { id: "second", label: "Second" }]} selected={selected} onSelect={onSelect} />
        : <Graph nodes={[{ id: "first", label: "First", depth: 0, lane: 0 }, { id: "second", label: "Second", depth: 1, lane: 0 }]} edges={[["first", "second"]]} selected={selected} onSelect={onSelect} />
      const view = await mount(body())
      const buttons = view.host.querySelectorAll<HTMLElement>('[role="button"]')
      expect(buttons).toHaveLength(2)
      const target = buttons[1]!
      expect(target.tabIndex).toBe(0)
      expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true")
      expect(target.getAttribute("aria-pressed")).toBe("false")
      target.focus()
      expect(document.activeElement).toBe(target)
      for (const key of ["Enter", " "]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
        await act(async () => target.dispatchEvent(event))
        expect(event.defaultPrevented).toBe(true)
      }
      expect(onSelect.mock.calls).toEqual([["second"], ["second"]])
      await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })))
      expect(onSelect).toHaveBeenCalledTimes(2)
      await view.render(body("second"))
      expect(view.host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1)
      expect(view.host.querySelector('[aria-pressed="true"]')?.textContent).toBe("Second")
    })
  }

  test("read-only rows and nodes add no button or tab stop", async () => {
    const view = await mount(<>
      <Table columns={[{ key: "label", label: "Name" }]} rows={[{ id: "one", label: "One" }]} />
      <Graph nodes={[{ id: "one", label: "One", depth: 0, lane: 0 }]} edges={[]} />
    </>)
    expect(view.host.querySelectorAll('[role="button"], [tabindex], [aria-pressed]')).toHaveLength(0)
  })
})
