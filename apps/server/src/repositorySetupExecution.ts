import { Data, Effect } from "effect"
import { SetupOperationResponseSchema, type SetupReceipt } from "@smthrs/rpc/RepositorySetup"
import { callGateway, ensureGateway, fetchCloudToken, isGatewayWorkspaceId, type GatewaySessions } from "./gateway"
import { decodeGatewayResponse, encodeGatewayRequest, GATEWAY_PROCEDURE_MOUNTS, NON_REPLAYABLE_GATEWAY_PROCEDURES } from "./gatewayRpc"
import { discardBody, fetchWithDeadline, readBoundedJson, readBoundedText, type Transport } from "./Http"
import { ServerConfig } from "./Config"
import { SetupPlanSchema, SetupRequests, type SetupRecord } from "./repositorySetupStore"

class SetupExecutionError extends Data.TaggedError("SetupExecutionError")<{ readonly message: string }> {}
const failure = (message: string) => new SetupExecutionError({ message })
const recordOf = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
type Services = SetupRequests | GatewaySessions | Transport | ServerConfig
type Instant = "workspaceSelectedAt" | "workspaceReadyAt" | "gatewayReadyAt" | "plannedAt" | "approvedAt" | "runStartedAt"
/** A phase instant is written the first time its phase is reached and never again. */
const stamps = (record: SetupRecord, ...names: readonly Instant[]): Partial<Record<Instant, number>> =>
  Object.fromEntries(names.filter(name => record[name] === undefined).map(name => [name, Date.now()]))

/** Cloud deduplicates one compatible automation VM without replacing the user's existing primary. */
const setupWorkspace = (login: string, record: SetupRecord) => Effect.gen(function* () {
  const config = yield* ServerConfig
  const workspaceId = record.workspaceId ?? record.input.workspaceId
  const endpoint = new URL(`/api/repos/${record.input.repo}/workspaces${workspaceId ? `/${workspaceId}` : ""}`, config.cloudApiBaseUrl)
  const call = (token: string) => fetchWithDeadline("The repository workspace", endpoint, {
    method: workspaceId ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(workspaceId ? {} : { body: JSON.stringify({ kind: "vm", name: "Repository", required_capability: "repository-jobs/v1" }) })
  }, config.upstreamTimeoutMs)
  let token = yield* fetchCloudToken(login)
  if (token.status !== "ok") return yield* Effect.fail(failure(token.detail))
  let response = yield* call(token.token)
  if (response.status === 401) {
    yield* discardBody(response)
    token = yield* fetchCloudToken(login)
    if (token.status !== "ok") return yield* Effect.fail(failure(token.detail))
    response = yield* call(token.token)
  }
  const body = recordOf(yield* readBoundedJson(response, 16_000))
  // A cold primary is only a candidate. Keep selection pending until Cloud
  // proves its capability or chooses a different workspace within quota.
  if (response.status === 409 && body.code === "repository_workspace_pending") return { status: "pending" } as const
  if (!response.ok) return yield* Effect.fail(failure(typeof body.message === "string" ? body.message : `The repository workspace answered HTTP ${response.status}`))
  if (!isGatewayWorkspaceId(body.id) || (workspaceId !== undefined && body.id !== workspaceId)
    || (body.repo_full_name !== undefined && body.repo_full_name !== record.input.repo)) return yield* Effect.fail(failure("Cloud returned a different repository workspace"))
  if (body.status === "failed" || body.status === "deleted") return yield* Effect.fail(failure(typeof body.failure_message === "string" ? body.failure_message : "The repository workspace could not start"))
  if (!["running", "starting", "pending", "stopped", "stopping", "suspended"].includes(String(body.status))) return yield* Effect.fail(failure("Cloud returned an unknown workspace state"))
  return { status: "selected", id: body.id, ready: !["starting", "pending", "stopping"].includes(String(body.status)) } as const
})

/** Credentials stay in the existing gateway relay; the fixed caller chooses the procedure. */
const rpc = (login: string, record: SetupRecord, procedure: string, payload: unknown, observeOnly = false) => Effect.gen(function* () {
  const outcome = yield* callGateway(login, record.input.repo, GATEWAY_PROCEDURE_MOUNTS[procedure]!, {
    method: "POST", workspaceId: record.binding?.workspaceId ?? record.input.workspaceId, text: encodeGatewayRequest(procedure, payload),
    requiredCapability: "repository-jobs/v1",
    provision: !observeOnly,
    // A later durable retry retains the persisted key; this relay never
    // repeats a consequential Run within one attempt after losing its answer.
    replayable: !NON_REPLAYABLE_GATEWAY_PROCEDURES.includes(procedure)
  })
  if (outcome.status !== "ok") return yield* Effect.fail(failure(outcome.detail))
  const text = yield* readBoundedText(outcome.response, 240_000).pipe(
    Effect.mapError(() => failure("The workspace result could not be read")),
    Effect.timeoutOrElse({ duration: 15_000, orElse: () => Effect.fail(failure("The workspace result timed out")) })
  )
  if (!outcome.response.ok) return yield* Effect.fail(failure(`The workspace answered HTTP ${outcome.response.status}`))
  const frame = decodeGatewayResponse(text)
  if (!frame.ok) return yield* Effect.fail(failure(frame.error.message))
  return frame.payload
})

/**
 * Advance an already-persisted request. Crash/retry repeats the same Plan and
 * Run keys; the modern control journal joins them. No browser-supplied receipt
 * or completion boolean participates in approval or activation.
 */
const executeRepositorySetup = (login: string, requestId: string, observeOnly: boolean): Effect.Effect<void, never, Services> => Effect.gen(function* () {
  const requests = yield* SetupRequests
  let record = yield* requests.read(login, requestId)
  if (!record || record.result) return
  if (observeOnly && (!record.runId || !record.binding?.workspaceId)) return yield* Effect.fail(failure("The previous setup has no recorded run to reconnect. Its execution state is unknown."))
  if (!observeOnly && !record.binding) {
    const workspace = yield* setupWorkspace(login, record)
    if (workspace.status === "pending") {
      if (record.observationError) yield* requests.update(login, record, { ...record, observationError: undefined })
      return
    }
    const selected = { ...stamps(record, "workspaceSelectedAt"), ...(workspace.ready ? stamps(record, "workspaceReadyAt") : {}) }
    if (record.workspaceId !== workspace.id || Object.keys(selected).length) record = yield* requests.update(login, record, { ...record, workspaceId: workspace.id, ...selected })
    if (!workspace.ready) {
      if (record.observationError) yield* requests.update(login, record, { ...record, observationError: undefined })
      return
    }
    const gateway = yield* ensureGateway(login, record.input.repo, false, record.workspaceId, "repository-jobs/v1")
    if (gateway.status === "provisioning") {
      if (record.observationError) yield* requests.update(login, record, { ...record, observationError: undefined })
      return
    }
    if (gateway.status !== "ready") return yield* Effect.fail(failure(gateway.detail))
    record = yield* requests.update(login, record, { ...record, ...stamps(record, "gatewayReadyAt"), binding: { gatewayId: gateway.record.gatewayId, workspaceId: gateway.record.workspaceId } })
  }
  if (!observeOnly && !record.plan) {
    const planned = SetupPlanSchema.safeParse(yield* rpc(login, record, "Plan", {
      flowId: "repository/setup", input: { ...record.input, ...(record.binding?.workspaceId ? { workspaceId: record.binding.workspaceId } : {}) }, idempotencyKey: `setup:${requestId}:plan`
    }))
    if (!planned.success) return yield* Effect.fail(failure("The workspace did not return a source-bound repository setup plan"))
    record = yield* requests.update(login, record, { ...record, ...stamps(record, "plannedAt"), plan: planned.data, observationError: undefined })
  }
  if (!observeOnly && !record.runId && record.plan) {
    const { planId, digest, envelope } = record.plan
    yield* rpc(login, record, "Approval.Submit", { target: { _tag: "Plan", planId, digest, envelope },
      scope: "run", decision: "approve", idempotencyKey: `setup:${requestId}:approve` })
    const approved = stamps(record, "approvedAt")
    const started = recordOf(yield* rpc(login, record, "Run", { _tag: "Plan", planId, digest, envelope, idempotencyKey: `setup:${requestId}:run` }))
    if (typeof started.runId !== "string" || !started.runId) return yield* Effect.fail(failure("The workspace did not identify the setup run"))
    record = yield* requests.update(login, record, { ...record, ...approved, ...stamps(record, "runStartedAt"), runId: started.runId, observationError: undefined,
      receipt: { ...record.receipt, runId: started.runId, phase: "queued", updatedAt: Date.now(), evidence: [`run:${started.runId}`] } })
  }
  if (!record.runId) return
  const snapshot = recordOf(yield* rpc(login, record, "Projection.Snapshot", { selector: { _tag: "run-summary", runId: record.runId } }, observeOnly))
  const rows = snapshot.rows
  if (!Array.isArray(rows)) return yield* Effect.fail(failure("The workspace did not return the setup run projection"))
  const run = rows.map(recordOf).find(row => row.runId === record!.runId)
  if (!run || run.flowId !== "repository/setup") return yield* Effect.fail(failure("The workspace returned another run's projection"))
  if (run.status === "completed") {
    // Lifecycle completion can reach the projection before its typed output.
    // Keep observing the same run for a bounded, restart-safe interval; an
    // absent result is neither successful setup nor proof of failed execution.
    if (run.finalOutput === undefined) {
      const now = Date.now(), since = record.resultPendingSince ?? now
      if (now - since < 60_000) {
        yield* requests.update(login, record, { ...record, resultPendingSince: since, observationError: undefined,
          receipt: { ...record.receipt, phase: "running", updatedAt: now } })
        return
      }
      return yield* Effect.fail(failure("The setup run completed without a valid result receipt"))
    }
    let output: unknown
    try { output = typeof run.finalOutput === "string" ? JSON.parse(run.finalOutput) : undefined } catch { /* The typed refusal below keeps the run receipt intact. */ }
    const decoded = SetupOperationResponseSchema.safeParse(output)
    if (!decoded.success) return yield* Effect.fail(failure("The setup run completed without a valid result receipt"))
    const result = decoded.data
    const { input } = record
    if (result.requestId !== input.requestId || result.digest !== input.digest || result.revision !== input.revision
      || (result.workspaceId !== undefined && result.workspaceId !== record.binding?.workspaceId)
      || (result.inspection !== undefined && input.operation !== "inspect")
      || (input.operation === "inspect" && result.inspection === undefined)
      || (result.receipt !== undefined && (result.receipt.requestId !== input.requestId || result.receipt.digest !== input.digest || result.receipt.revision !== input.revision
        || result.receipt.operation !== input.operation || (result.receipt.runId !== undefined && result.receipt.runId !== record.runId)))) {
      return yield* Effect.fail(failure("The setup result belongs to a different candidate or operation"))
    }
    if (result.receipt && !["completed", "failed", "stopped"].includes(result.receipt.phase)) return yield* Effect.fail(failure("The completed run returned an unfinished setup receipt"))
    if (record.input.operation === "run" && (!result.receipt || (result.receipt.phase === "completed" && !result.receipt.jobRunId))) return yield* Effect.fail(failure("The manual work returned no verified job run"))
    const completed = result.receipt ? { ...result, receipt: { ...result.receipt, runId: record.runId } } : result
    yield* requests.update(login, record, { ...record, observationError: undefined, result: completed,
      receipt: completed.receipt ?? { ...record.receipt, phase: "completed", updatedAt: Date.now() } })
    return
  }
  const phase: SetupReceipt["phase"] | undefined = ({ accepted: "queued", queued: "queued", running: "running", "waiting-approval": "waiting", parked: "waiting", waiting: "waiting", failed: "failed", stopped: "stopped", cancelled: "stopped" } as Record<string, SetupReceipt["phase"]>)[String(run.status)]
  if (!phase) return yield* Effect.fail(failure("The workspace returned an unknown setup run state"))
  const receipt: SetupReceipt = { ...record.receipt, phase, updatedAt: typeof run.updatedAt === "number" ? run.updatedAt : Date.now(),
    ...(phase === "failed" || phase === "stopped" ? { error: typeof run.verdict === "string" ? run.verdict : `Setup ${phase}` } : {}) }
  const terminal = phase === "failed" || phase === "stopped"
  yield* requests.update(login, record, { ...record, receipt, observationError: undefined,
    ...(terminal ? { result: { requestId, revision: record.input.revision, digest: record.input.digest, receipt } } : {}) })
}).pipe(Effect.catch(error => Effect.gen(function* () {
  // Observation/transport failure cannot change the execution phase.
  const requests = yield* SetupRequests
  const record = yield* requests.read(login, requestId)
  if (record && !record.result) yield* requests.update(login, record, { ...record, observationError: error.message.slice(0, 1000) })
}).pipe(Effect.catch(() => Effect.void))))

/** Normal admission alone may provision, plan, approve and start its durable request. */
export const advanceRepositorySetup = (login: string, requestId: string) => executeRepositorySetup(login, requestId, false)

/** Recovered observers can only read the already recorded run, never replay admission. */
export const observeRepositorySetup = (login: string, requestId: string) => executeRepositorySetup(login, requestId, true)
