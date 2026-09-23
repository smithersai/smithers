import type { Actor, Card } from "../AppState"
import { actorSharedState } from "../ActorBindings"
import { canonicalStoredJsonValue } from "../EventValue"
import { runtimeRunKey } from "../RuntimeProjection"
import { workflowLaunchOf, type WorkflowLaunch } from "../WorkflowLaunch"
import type { ControllerContext } from "./context"
import { TOAST_SUPERSEDED } from "./failures"
import { isFlowNotFound, type GatewayWorkspaceBinding } from "./gateway"
import { runtimeFlowAvailable } from "../KnowledgeFeatures"
import { planCardSnapshot } from "../../cards/PlanNodes"
import { runFailureOf } from "../RunFailure"
import { digest } from "@smthrs/core/Digest"

type RunCard = Extract<Card, { kind: "run-trace" }>
type Refusal = { readonly message: string; readonly code?: string; readonly retryAfterSeconds?: number }
const terminal = new Set(["completed", "failed", "cancelled"])
class RequestPersistenceError extends Error {}

/** One durable request owns preparation, launch and observation through remote settlement. */
export const createWorkflowLaunchController = (
  ctx: ControllerContext,
  nextOrdinal: () => number,
  pump: (cardId: string) => Promise<void>,
  prepare: (repo: string, binding: GatewayWorkspaceBinding, signal: AbortSignal) => Promise<true | Refusal>
) => actorSharedState(ctx, "workflow-launch", () => {
  const { store } = ctx
  const inFlight = new Map<string, { epoch: number; controller: AbortController; work: Promise<unknown> }>()
  const persisting = new Map<string, Promise<unknown>>()
  const controllers = new Set<AbortController>()
  const owner = () => {
    const identity = store.collections.identitySessions.get("identity")
    return identity?.state === "signed-in" && identity.allowlisted ? identity.login : undefined
  }
  const read = (id: string): RunCard | undefined => { const card = store.collections.cards.get(id); return card?.kind === "run-trace" ? card : undefined }
  const save = (card: RunCard) => store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
    const timer = setTimeout(done, Math.max(1, ms))
    ctx.unref(timer)
    signal.addEventListener("abort", done, { once: true })
  })
  ctx.onDispose(() => { for (const controller of controllers) controller.abort(); controllers.clear() })

  const send = (id: string, request: WorkflowLaunch): void => {
    if (ctx.disposed || owner() !== request.owner) return
    const epoch = ctx.accountEpoch
    const previous = inFlight.get(id)
    if (previous?.epoch === epoch) return
    previous?.controller.abort()
    const controller = new AbortController()
    controllers.add(controller)
    const current = () => !ctx.disposed && !controller.signal.aborted && ctx.accountEpoch === epoch && owner() === request.owner && workflowLaunchOf(read(id))?.id === request.id
    const publish = async (next: WorkflowLaunch, patch: Partial<RunCard["payload"]> = {}) => {
      if (!current()) return
      const card = read(id)!
      try {
        await save({ ...card, status: next.error ? "error" : "active", payload: { ...card.payload, ...patch,
          input: { ...next.input, _workflowLaunch: next } } })
      } catch { throw new RequestPersistenceError() }
    }
    // A new request for the same work replaces its earlier failure on the shared stack.
    const toastKey = `flow.request.${digest(canonicalStoredJsonValue([request.owner, request.repo, request.workspaceId ?? null, request.workflow, request.input]))}`
    const work = ctx.withToast(toastKey, request.workflow, `${request.workflow} completed`, async () => {
      let stage: NonNullable<WorkflowLaunch["error"]>["stage"] = "preparation"
      const fail = async (failure: Refusal) => {
        if (!current()) return TOAST_SUPERSEDED
        const error = { stage, code: failure.code ?? "launch_unavailable", message: failure.message }
        await publish({ ...request, error }, { phase: "failed", error: error.message })
        return error.message
      }
      try {
        if (request.runId === undefined) {
          const binding = { workspaceId: request.workspaceId }
          for (;;) {
            if (!current()) return TOAST_SUPERSEDED
            const retryAt = workflowLaunchOf(read(id))?.retryAt
            if (retryAt !== undefined) await pause(retryAt - Date.now(), controller.signal)
            if (!current()) return TOAST_SUPERSEDED
            stage = "preparation"
            const ready = await prepare(request.repo, binding, controller.signal)
            if (!current()) return TOAST_SUPERSEDED
            stage = ready === true ? "launch" : "preparation"
            const result = ready === true ? await ctx.gateway.launch(request.repo, request.workflow, request.input, binding,
              { idempotencyKey: request.id, stillCurrent: current }) : { status: "error" as const, ...ready }
            if (!current()) return TOAST_SUPERSEDED
            if (result.status === "ok") {
              request = { ...request, runId: result.value.runId, retryAt: undefined, error: undefined }
              const plan = planCardSnapshot(result.value)
              await publish(request, { runId: result.value.runId, phase: "running", error: undefined,
                ...(plan === undefined ? {} : { plan }) })
              break
            }
            if (result.code === "workspace_starting") {
              await publish({ ...request, retryAt: Date.now() + (result.retryAfterSeconds ?? ctx.workflowPollMs / 1000) * 1000 })
              continue
            }
            if (isFlowNotFound(result.code)) {
              const list = await ctx.gateway.listFlows(request.repo, binding)
              if (!current()) return TOAST_SUPERSEDED
              const names = list.status === "ok" ? list.value.filter(flow => runtimeFlowAvailable(flow.flowId, ctx.services.features)).slice(0, 8).map(flow => flow.flowId).join(", ") : ""
              return await fail({ ...result, message: `There's no flow called ${request.workflow} on ${request.repo}.${names ? ` The workspace has: ${names}.` : ""}` })
            }
            return await fail(result)
          }
        }
        if (!current()) return TOAST_SUPERSEDED
        void pump(id).catch(async () => {
          if (!current()) return
          const card = read(id)!
          await save({ ...card, payload: { ...card.payload, observationError: "The run could not be checked. Check again to reconnect." } })
        })
        // Read committed gateway receipts. A launched or quiet watcher is not a finished job.
        while (current()) {
          const card = read(id)!
          const summary = store.committedRuntimeRun(runtimeRunKey(card.payload))?.summary
          if (summary !== undefined && terminal.has(summary.status)) {
            if (summary.status === "completed") return true
            if (summary.status === "cancelled") return summary.verdict ?? "Run cancelled."
            return summary.verdict === "failed — no cause recorded in the journal"
              ? runFailureOf({ workflow: request.workflow, error: summary.verdict,
                events: store.committedRuntimeRun(runtimeRunKey(card.payload))?.events }).message
              : summary.verdict ?? "The run failed."
          }
          await pause(ctx.workflowPollMs, controller.signal)
        }
        return TOAST_SUPERSEDED
      } catch (error) {
        if (!current()) return TOAST_SUPERSEDED
        if (error instanceof RequestPersistenceError) stage = "persistence"
        const message = stage === "persistence" ? "The run request could not be saved. Try again." : "The workspace did not answer. Retry the request."
        const code = stage === "persistence" ? "request_persistence_failed" : "launch_unreachable"
        // Losing a local write after launch cannot change the remote verdict.
        if (request.runId !== undefined) return message
        try { return await fail({ code, message }) } catch { return message }
      }
    })
    inFlight.set(id, { epoch, controller, work })
    void work.finally(() => { if (inFlight.get(id)?.work === work) inFlight.delete(id); controllers.delete(controller) })
  }

  const resume = () => {
    for (const card of store.collections.cards.values()) {
      const request = workflowLaunchOf(card)
      if (request && !request.error) send(card.id, request)
    }
  }
  const retry = (id: string): boolean => {
    const card = read(id), request = workflowLaunchOf(card)
    if (!card || !request || request.runId !== undefined) return false
    if (owner() !== request.owner || persisting.has(id)) return true
    const active = inFlight.get(id)
    if (active) {
      if (request.error) void active.work.then(() => retry(id))
      return true
    }
    const next = { ...request, error: undefined, retryAt: undefined }
    const saving = save({ ...card, status: "active", payload: { ...card.payload, phase: "launching", error: undefined, input: { ...next.input, _workflowLaunch: next } } })
    persisting.set(id, saving)
    void saving.then(() => send(id, next), () => {}).finally(() => persisting.delete(id))
    return true
  }
  const start = async (args: { repo: string; binding: GatewayWorkspaceBinding; workflow: string; input: Record<string, unknown>; actor: Actor }): Promise<string | { value: string }> => {
    const login = owner()
    if (!login) return "Sign in with GitHub first: flows run on your own workspace."
    const input = JSON.parse(canonicalStoredJsonValue(args.input)) as Record<string, unknown>
    const key = canonicalStoredJsonValue([login, args.repo, args.binding.workspaceId ?? null, args.workflow, input])
    // Admission is serialized through persistence, shared by button, slash and agent bindings.
    while (persisting.has(key)) await persisting.get(key)
    const prior = [...store.collections.cards.values()].find(card => {
      const held = workflowLaunchOf(card)
      return held && canonicalStoredJsonValue([held.owner, held.repo, held.workspaceId ?? null, held.workflow, held.input]) === key &&
        (held.runId === undefined || (card.kind === "run-trace" && !terminal.has(card.payload.phase)))
    })
    if (prior) {
      const held = workflowLaunchOf(prior)!
      if (held.error) retry(prior.id)
      else send(prior.id, held)
      return { value: `run-requested workflow=${args.workflow} request=${held.id} repo=${args.repo}` }
    }
    const request: WorkflowLaunch = { version: 1, id: crypto.randomUUID(), owner: login, repo: args.repo, ...args.binding, workflow: args.workflow,
      input }
    const id = `flow-request-${request.id}`
    const saving = store.dispatch({ type: "card.upsert", actor: args.actor, card: { id, kind: "run-trace", title: `${args.workflow} · ${args.repo}`,
      status: "active", createdAt: Date.now(), ordinal: nextOrdinal(), payload: { repo: args.repo, ...args.binding, gatewayBindingVersion: 1,
        workflow: args.workflow, runId: `pending-${request.id}`, phase: "launching", steps: [], result: null, lastSeq: 0, liveTail: true,
        input: { ...request.input, _workflowLaunch: request } } } }).isPersisted.promise
    persisting.set(key, saving)
    try { await saving } catch { return "The run request could not be saved. Try again." } finally { persisting.delete(key) }
    send(id, request)
    return { value: `run-requested workflow=${args.workflow} request=${request.id} repo=${args.repo}` }
  }
  return { start, resume, retry }
})
