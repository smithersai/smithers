/*
 * Reading a flow's measured history into the collection that predicts with it.
 *
 * The `flow-durations` projection folds every run of one flow, so it is read
 * at the two moments its answer can have moved: when a plan card draws that
 * flow's graph, and when a run of it turns terminal and adds a sample. Never
 * inside the pump loop — a prediction that re-read on every poll would cost
 * one relay call per second to tell the reader the same number.
 *
 * Silence is the contract for every refusal. This projection is the newest
 * one the gateway serves, so a box whose selector union predates it refuses
 * the call at its own RPC boundary; the card then shows no duration text,
 * which is exactly what a flow with no history shows. A toast for a
 * prediction nobody asked for would be an error message about an enhancement.
 */
import type { ControllerContext } from "./context"
import type { GatewayWorkspaceBinding } from "./gateway"

/** Reads one flow's measured durations and writes them to the collection. */
export type FlowDurationsReader = (
  repo: string,
  flowId: string,
  binding?: GatewayWorkspaceBinding
) => Promise<void>

/**
 * The reader, with the guard that keeps two reads of one flow in order.
 *
 * Every read takes a turn number, and an answer writes only while its turn is
 * the newest one started. Two reads of the same flow can be in flight — a
 * plan card opening while a run of it settles — and the older answer carries
 * the older history, so applying it last would move the numbers backwards.
 */
export const createFlowDurationsReader = (ctx: ControllerContext): FlowDurationsReader => {
  const turns = new Map<string, number>()
  return async (repo, flowId, binding) => {
    /* D-038: with the flow builder off nothing reads this projection, so the
     * app makes exactly the calls it made before the lane. */
    if (ctx.services.features?.flowBuilder !== true) return
    const key = `${repo}\u0000${flowId}`
    const turn = (turns.get(key) ?? 0) + 1
    turns.set(key, turn)
    const durations = await ctx.gateway.flowDurations(repo, flowId, binding)
    if (ctx.disposed || turns.get(key) !== turn) return
    if (durations.status !== "ok") return
    await ctx.store.dispatch({
      type: "flow-durations.loaded",
      actor: "system",
      repo,
      flowId,
      rows: durations.value.map((row) => ({
        actionTag: row.actionTag,
        samples: row.samples,
        p50Ms: row.p50Ms,
        p90Ms: row.p90Ms
      }))
    }).isPersisted.promise
  }
}
