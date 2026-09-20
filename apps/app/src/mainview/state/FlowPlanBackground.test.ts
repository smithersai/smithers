/*
 * The plan door obeys the instant-chat rule (AGENTS.md §1).
 *
 * Planning crosses the relay to a workspace that may still be provisioning,
 * so `/flow.plan` persists the card, acknowledges, and returns. The graph
 * fills in the background under the shared toast, a refusal stays on the card
 * with the door that asks again, and asking twice for the same plan is one
 * request, not two.
 */
import { describe, expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { json, memoryStorage, settle, silentAgent, unavailableRepositories } from "./TestFixtures"
import type { Card } from "./AppState"

const createAppController = scopedControllers()

const REPO = "smithersai/smithers"
const FLOW = "review"
const CARD = `flow-plan-${REPO}-${FLOW}-`
const TOAST = `toast-flow.plan:${CARD}`

const planCard = (payload: {
  readonly nodes?: ReadonlyArray<unknown>
  readonly graph?: unknown
}) => ({
  planId: "plan-1",
  flowId: FLOW,
  digest: "d".repeat(64),
  inputSummary: "{}",
  envelope: { capabilities: [], flows: [], budget: {} },
  deployClass: false,
  nodes: payload.nodes ?? [],
  ...(payload.graph === undefined ? {} : { graph: payload.graph }),
  approval: {
    target: { _tag: "Plan", planId: "plan-1", digest: "d".repeat(64), envelope: { capabilities: [], flows: [], budget: {} } },
    scope: "run",
    idempotencyKey: "approve:plan-1"
  }
})

/* One node in the control plane's own shape (gateway.test.ts), not the card's. */
const NODE = {
  id: "read",
  kind: "step",
  key: `key1_${"0".repeat(64)}`,
  material: { version: "flows/key-material/v2", kind: "sealed", body: { action: "files/read" }, inputs: [], layers: [], capabilities: [] },
  effects: { reads: [], writes: [], boundaryMode: "hard" },
  dependsOn: [],
  conflicts: [],
  strategy: "serialize",
  runtime: "delay-rebase",
  priority: 0,
  generation: 0,
  status: "run"
}

/**
 * A relay whose `Plan` answer this test releases by hand.
 *
 * Nothing about the background rule is observable against a call that has
 * already answered: the claim is what the command does WHILE the workspace is
 * still thinking.
 */
const scriptedRelay = (answer: () => unknown) => {
  const plans: Array<unknown> = []
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    plans,
    release: () => release?.(),
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url), "https://app.test").pathname
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { procedure?: string; payload?: unknown } : undefined
      if (path === "/api/workflow/provision") return json(200, { status: "ready", repo: REPO, gatewayId: "gw-1" })
      if (path === "/api/workflow/rpc" && body?.procedure === "Plan") {
        plans.push(body.payload)
        await gate
        return json(200, answer())
      }
      return json(404, { status: "error", message: `no stub for ${path}` })
    }
  }
}

const readyController = async (relay: ReturnType<typeof scriptedRelay>, storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({
    type: "identity.session.loaded", actor: "system", state: "signed-in",
    login: "will", allowlisted: true, admin: false, scopesPlain: null
  }).isPersisted.promise
  await store.dispatch({
    type: "repositories.loaded", actor: "system",
    repositories: [{ id: REPO, org: "smithersai", ownerKind: "org", name: "smithers", head: null }]
  }).isPersisted.promise
  const controller = createAppController(store, unavailableRepositories, silentAgent, {
    fetchImpl: relay.fetchImpl,
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000
  })
  return { store, controller }
}

const held = (store: Awaited<ReturnType<typeof createAppStore>>): Extract<Card, { kind: "flow-plan" }> | undefined => {
  const card = store.collections.cards.get(CARD)
  return card?.kind === "flow-plan" ? card : undefined
}

/*
 * The in-flight guard and the attempt counter live in this controller's
 * memory, so a reload is the end of the request they were tracking. A card
 * left saying "pending" would be a claim about work nobody is doing, and
 * while it says pending the body offers Run instead of Plan (AGENTS.md: a
 * persisted request either reconnects or settles, and a failure stays visible
 * and retryable).
 */
describe("a reload settles the plans it cannot reconnect", () => {
  test("a pending plan card reopens as a failure with the door that asks again", async () => {
    const storage = memoryStorage()
    const relay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE] }) }))
    const first = await readyController(relay, storage)

    await first.controller.planFlow(FLOW, REPO)
    await settle(4)
    expect(held(first.store)?.payload.status).toBe("pending")
    await first.controller.dispose()

    // Same storage, new controller: the reload.
    const second = await readyController(scriptedRelay(() => ({ ok: true, payload: planCard({}) })), storage)
    const card = held(second.store)
    expect(card?.payload.status).toBe("failed")
    expect(card?.payload.error).toBeTypeOf("string")
    expect(card?.payload.planId).toBeUndefined()
    expect(card?.payload.nodes).toBeUndefined()

    // Retryable on the door it now offers, on the card it already has.
    await second.controller.planFlow(FLOW, REPO)
    expect(held(second.store)?.payload.status).toBe("pending")
    expect([...second.store.collections.cards.values()].filter((row) => row.kind === "flow-plan")).toHaveLength(1)
  })

  test("a settled plan card reopens exactly as it was", async () => {
    const storage = memoryStorage()
    const relay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE], graph: { edges: [] } }) }))
    const first = await readyController(relay, storage)

    await first.controller.planFlow(FLOW, REPO)
    await settle(4)
    relay.release()
    await settle(12)
    const done = held(first.store)
    expect(done?.payload.status).toBe("done")
    await first.controller.dispose()

    const second = await readyController(scriptedRelay(() => ({ ok: true, payload: planCard({}) })), storage)
    expect(held(second.store)?.payload).toEqual(done!.payload)
  })
})

describe("the plan door returns before the workspace answers", () => {
  test("the command acknowledges a pending card, then the toast and the graph settle with the job", async () => {
    const relay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE], graph: { edges: [] } }) }))
    const { store, controller } = await readyController(relay)

    const acknowledged = await controller.planFlow(FLOW, REPO)
    // The command answered while the relay's Plan call is still unresolved.
    expect(acknowledged).toEqual({ value: `plan-requested flow=${FLOW} repo=${REPO}` })
    await settle(4)
    expect(held(store)?.payload.status).toBe("pending")
    expect(held(store)?.payload.nodes).toBeUndefined()
    expect(store.collections.toasts.get(TOAST)?.status).toBe("running")

    // Chat and the doors beside it keep working while the plan is in flight.
    await store.dispatch({ type: "message.appended", actor: "user", text: "meanwhile" }).isPersisted.promise
    expect([...store.collections.messages.values()].some((row) => row.text === "meanwhile")).toBe(true)
    expect((await controller.commands.run("card.dismiss", CARD)).status).not.toBe("unknown-command")

    relay.release()
    await settle(12)
    expect(held(store)?.payload.status).toBe("done")
    expect(held(store)?.payload.nodes?.map((node) => node.id)).toEqual(["read"])
    expect(held(store)?.payload.planId).toBe("plan-1")
    expect(store.collections.toasts.get(TOAST)?.status).toBe("ok")
  })

  /*
   * D-054: the workspace reports where each node was declared, beside the
   * edges and outside the approval digest. The card keeps it, because it is
   * what the drawer's Code tab anchors on.
   */
  test("the declaration sites the workspace reported reach the card", async () => {
    const relay = scriptedRelay(() => ({
      ok: true,
      payload: planCard({
        nodes: [NODE],
        graph: { edges: [], nodes: [{ id: "read", declaredAt: { path: "flows/review/flow.ts", line: 12 } }] }
      })
    }))
    const { store, controller } = await readyController(relay)

    await controller.planFlow(FLOW, REPO)
    await settle(4)
    relay.release()
    await settle(12)
    expect(held(store)?.payload.graph?.nodes)
      .toEqual([{ id: "read", declaredAt: { path: "flows/review/flow.ts", line: 12 } }])
  })

  test("asking twice for the same plan is one Plan call and one card", async () => {
    const relay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE] }) }))
    const { store, controller } = await readyController(relay)

    const first = await controller.planFlow(FLOW, REPO)
    const second = await controller.planFlow(FLOW, REPO)
    expect(second).toEqual(first)
    await settle(4)
    expect(relay.plans).toHaveLength(1)
    expect([...store.collections.cards.values()].filter((card) => card.kind === "flow-plan")).toHaveLength(1)

    relay.release()
    await settle(12)
    expect(relay.plans).toHaveLength(1)
    expect(held(store)?.payload.status).toBe("done")
  })

  /*
   * The card id is an identity, not a transcript. It reaches the DOM as a
   * `data-card` attribute and the toast as `toast-flow.plan:<id>`, so the
   * input goes in as a digest of its canonical bytes: the same input is the
   * same card whatever order its keys arrived in, and no value a person typed
   * is readable off the page.
   */
  test("the same input in another key order is one card, and no input value reaches the id", async () => {
    const relay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE] }) }))
    const { store, controller } = await readyController(relay)

    await controller.planFlow(FLOW, REPO, { issue: "531", title: "secret-title" })
    await controller.planFlow(FLOW, REPO, { title: "secret-title", issue: "531" })
    await settle(4)

    const cards = [...store.collections.cards.values()].filter((card) => card.kind === "flow-plan")
    expect(cards).toHaveLength(1)
    expect(relay.plans).toHaveLength(1)
    expect(cards[0]!.id).not.toContain("secret-title")
    expect(cards[0]!.id).not.toContain("531")
    expect([...store.collections.toasts.keys()].join(" ")).not.toContain("secret-title")
    // The input itself still rides the card, where the body reads it.
    expect(cards[0]!.kind === "flow-plan" ? cards[0]!.payload.input : undefined).toEqual({ issue: "531", title: "secret-title" })

    relay.release()
    await settle(12)
    expect(relay.plans).toHaveLength(1)
  })

  test("a refusal stays on the card with the door that asks again, and never claims a plan", async () => {
    const relay = scriptedRelay(() => ({ ok: false, error: { message: "the workspace has no flow called review" } }))
    const { store, controller } = await readyController(relay)

    await controller.planFlow(FLOW, REPO)
    await settle(4)
    relay.release()
    await settle(12)

    const card = held(store)
    expect(card?.payload.status).toBe("failed")
    expect(card?.payload.error).toBe("the workspace has no flow called review")
    expect(card?.payload.nodes).toBeUndefined()
    expect(card?.payload.planId).toBeUndefined()
    expect(store.collections.toasts.get(TOAST)?.status).toBe("failed")

    // Retryable: the in-flight guard released, so the same ask reaches the
    // relay again, on the card it already has.
    await controller.planFlow(FLOW, REPO)
    expect(held(store)?.payload.status).toBe("pending")
    await settle(12)
    expect(relay.plans).toHaveLength(2)
    expect([...store.collections.cards.values()].filter((row) => row.kind === "flow-plan")).toHaveLength(1)
    expect(held(store)?.payload.status).toBe("failed")
  })
})
