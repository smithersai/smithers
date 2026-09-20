/*
 * The flow builder's flag (D-038).
 *
 * Every `jj bookmark set main` deploys, so the plan door, its card and its
 * graph land dark: with `flowBuilder` off the app is the app it was before
 * the lane, in the command registry, in the agent's catalog and in the DOM.
 * This file is that claim, from both sides of the flag.
 */
import { describe, expect, test } from "bun:test"
import baseline from "./fixtures/FlowBuilderBaseline.json"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CardView } from "../ChatCards"
import { ControllerTestProvider } from "../ControllerContext"
import { cardActions } from "../cards/CardActions"
import { agentVisibleCatalog } from "../flows/agentTools"
import type { Card } from "./AppState"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

const REPO = "smithersai/smithers"

/* The listing the Plan button hangs off: one real flow row, as flow.list writes it. */
const listCard: Card = {
  id: "workflow-list-1",
  kind: "workflow-list",
  title: `Flows: ${REPO}`,
  status: "active",
  createdAt: 1,
  ordinal: 1,
  payload: { repo: REPO, workflows: [{ key: "review", description: "Review a change" }], gatewayBindingVersion: 1 }
}

const controllerWith = async (features: { readonly flowBuilder?: boolean }) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "card.upsert", actor: "system", card: listCard }).isPersisted.promise
  await store.dispatch({
    type: "identity.session.loaded", actor: "system", state: "signed-in",
    login: "will", allowlisted: true, admin: false, scopesPlain: null
  }).isPersisted.promise
  return createAppController(store, unavailableRepositories, silentAgent, { features })
}

const flowsMarkup = (controller: ReturnType<typeof createAppController>): string =>
  renderToStaticMarkup(createElement(ControllerTestProvider, {
    controller,
    children: createElement(CardView, { card: listCard, maximized: false, worldDocuments: [], ...cardActions(controller) })
  }))

const names = (controller: ReturnType<typeof createAppController>) => ({
  all: controller.commands.all().map((item) => item.name),
  callable: controller.commands.callable().map((entry) => entry.binding.descriptor.name),
  slash: controller.commands.slashTree("flow").flatMap((row) => row.kind === "flow" ? [row.flow.name] : []),
  catalog: agentVisibleCatalog(controller.commands.callable()).map((row) => row.name)
})

describe("the flow builder behind its flag", () => {
  test("off: the plan door is unregistered, uncallable, out of the catalog and off the DOM", async () => {
    const controller = await controllerWith({})
    expect(controller.features.flowBuilder).toBe(false)

    const registry = names(controller)
    expect(controller.commands.find("flow.plan")).toBeUndefined()
    for (const list of [registry.all, registry.callable, registry.slash, registry.catalog]) {
      expect(list).not.toContain("flow.plan")
    }
    expect((await controller.commands.run("flow.plan", "review")).status).toBe("unknown-command")
    expect((await controller.commands.runForAgent("flow.plan", "review")).status).toBe("unknown-command")

    // The leaf builder is live: the door beside it keeps every one of its own.
    expect(registry.callable).toContain("flow.run")
    expect(registry.catalog).toContain("flow.run")

    const markup = flowsMarkup(controller)
    expect(markup).toContain("Run")
    expect(markup).not.toContain(">Plan<")
    expect(markup).not.toContain("flow.plan")
    expect(JSON.stringify(agentVisibleCatalog(controller.commands.callable()))).not.toContain("flow.plan")
  })

  test("off: the handler itself refuses, so an agent holding an older catalog plans nothing", async () => {
    const controller = await controllerWith({})
    expect(await controller.planFlow("review", REPO)).toBe("This feature is not enabled.")
  })

  test("on: the slash leaf, the agent tool and the Plan button all exist", async () => {
    const controller = await controllerWith({ flowBuilder: true })
    expect(controller.features.flowBuilder).toBe(true)

    const registry = names(controller)
    expect(controller.commands.find("flow.plan")).toBeDefined()
    for (const list of [registry.all, registry.callable, registry.slash, registry.catalog]) {
      expect(list).toContain("flow.plan")
    }
    expect(registry.all.filter((name) => name === "flow.plan")).toHaveLength(1)
    expect(flowsMarkup(controller)).toContain(">Plan<")
  })

  // Compare off to the frozen pre-feature checkout too: changing a shared
  // wrapper in both branches must fail, even if their difference stays one button.
  test("off and on differ by exactly one button", async () => {
    const off = flowsMarkup(await controllerWith({}))
    expect(off).toBe(baseline.listing)
    const on = flowsMarkup(await controllerWith({ flowBuilder: true }))
    expect(on).not.toBe(off)
    const opens = on.lastIndexOf("<button", on.indexOf(">Plan<"))
    const planButton = on.slice(opens, on.indexOf("</button>", opens) + "</button>".length)
    expect(planButton).toContain(">Plan<")
    expect(planButton).toContain("flow.plan")
    expect(on.replace(planButton, "")).toBe(off)
  })
})
