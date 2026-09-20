/** Shared inputs for the frozen main@origin comparison. Copy this harness
 * unchanged into the baseline workspace; never record through feature code. */
import { renderToStaticMarkup } from "react-dom/server"
import { CardView } from "../../ChatCards"
import { ControllerTestProvider } from "../../ControllerContext"
import { cardActions } from "../../cards/CardActions"
import { RunTraceBody } from "../../cards/RunTraceCard"
import { agentVisibleCatalog } from "../../flows/agentTools"
import type { Card } from "../AppState"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { json, memoryStorage, silentAgent, unavailableRepositories, waitFor } from "../TestFixtures"

export const baselineListCard: Extract<Card, { kind: "workflow-list" }> = {
  id: "workflow-list-1", kind: "workflow-list", title: "Flows: smithersai/smithers",
  status: "active", createdAt: 1, ordinal: 1,
  payload: { repo: "smithersai/smithers", workflows: [{ key: "review", description: "Review a change" }], gatewayBindingVersion: 1 }
}
export const baselineRunCard: Extract<Card, { kind: "run-trace" }> = {
  id: "flow-run-run-1", kind: "run-trace", title: "review", status: "active", createdAt: 1, ordinal: 1,
  payload: { repo: "smithersai/smithers", runId: "run-1", workflow: "review", phase: "running", steps: [], result: null, lastSeq: 0, events: [] }
}

export const openFlowBuilderBaseline = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const calls: Array<unknown> = []
  const controller = createAppController(store, unavailableRepositories, silentAgent, {
    workflowPollMs: 60_000,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input), "https://app.test")
      if (url.pathname === "/api/workflow/provision") return json(200, { status: "ready", repo: "smithersai/smithers" })
      if (url.pathname !== "/api/workflow/rpc") return json(404, {})
      const body = JSON.parse(String(init?.body))
      if (body.procedure === "List") return json(200, { ok: true, payload: { _tag: "flows", items: [{ flowId: "review", description: "Review a change" }] } })
      if (body.procedure === "Plan") {
        calls.push(body)
        return json(200, { ok: true, payload: { planId: "plan-1", flowId: "review", digest: "d".repeat(64), inputSummary: "{}",
          envelope: { capabilities: [], flows: [], budget: {} }, deployClass: false, nodes: [], approval: { target: { _tag: "Plan", planId: "plan-1", digest: "d".repeat(64), envelope: { capabilities: [], flows: [], budget: {} } }, scope: "run", idempotencyKey: "approve:plan-1" } } })
      }
      if (body.procedure === "Run") {
        calls.push(JSON.parse(JSON.stringify(body).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")))
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: "run-1" } })
      }
      if (body.procedure === "Approval.Submit") {
        calls.push(body)
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } })
      }
      return json(200, { ok: true, payload: { cursor: { projection: body.payload?.selector?._tag ?? "run-events", runId: "run-1", value: 0 }, rows: [] } })
    }
  })
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "user", name: "smithers", head: null }] }).isPersisted.promise
    const listing = renderToStaticMarkup(<ControllerTestProvider controller={controller}>
      <CardView card={baselineListCard} maximized={false} worldDocuments={[]} {...cardActions(controller)} />
    </ControllerTestProvider>)
    const run = renderToStaticMarkup(<RunTraceBody card={baselineRunCard} onRunCommand={() => {}} />)
    const registry = controller.commands.all().filter(row => /^(flow|runs)\./.test(row.name)).map(row => row.name)
    const catalog = agentVisibleCatalog(controller.commands.callable()).filter(row => /^(flow|runs)\./.test(row.name))
    return {
      surface: { listing, run, registry, catalog },
      launch: async () => {
        await controller.commands.run("flow.run", "review smithersai/smithers")
        const findRun = () => [...store.collections.cards.values()].find(card => card.kind === "run-trace" && card.payload.runId === "run-1")
        await waitFor(() => findRun()?.kind === "run-trace")
        const card = findRun()
        if (card?.kind !== "run-trace") throw new Error("Baseline launch did not produce a run card")
        return JSON.parse(JSON.stringify({ calls, payload: card.payload }).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")) as { calls: Array<unknown>; payload: typeof card.payload }
      },
      dispose: async () => { await controller.dispose(); await store.dispose?.() }
    }
  } catch (error) {
    await controller.dispose(); await store.dispose?.()
    throw error
  }
}

export const captureFlowBuilderBaseline = async () => {
  const capture = await openFlowBuilderBaseline()
  try { return { ...capture.surface, ...await capture.launch() } }
  finally { await capture.dispose() }
}
