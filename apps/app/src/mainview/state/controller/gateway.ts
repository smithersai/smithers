/*
 * The workspace gateway, as this app calls it.
 *
 * Every call goes to the product Worker's relay, which holds the per-user
 * gateway credential a browser can never hold and writes the gateway's own RPC
 * frame. The names here are the gateway's names — `Plan`, `Run`, `Cancel`,
 * `Resume`, `Steer`, `Signal`, `List`, `Projection.Snapshot`,
 * `Approval.Submit` — so there is one vocabulary between this file, the
 * Worker, and the engine.
 *
 * The row schemas are imported from `@smthrs/gateway`, and every projection
 * snapshot is decoded against them, so a change to a served projection fails
 * this app's typecheck AND a row the gateway never served fails here instead
 * of reaching a user as an undefined field.
 */
import { ControlEvent, type SteerMessage } from "@smthrs/control/ControlSchema"
import { ApprovalRow, NodeOutputRow, RunSummaryRow, TranscriptRow } from "@smthrs/gateway/GatewayProjection"
import { ProjectionCursor } from "@smthrs/gateway/GatewaySchema"
import { WORKFLOW_RPC_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { Option, Schema } from "effect"

/**
 * What one relayed call answered. A refusal carries the sentence the relay
 * wrote and, when the gateway raised a typed error, its `code` (ControlError's
 * `code` field, else the error's tag), so a caller can answer a known refusal
 * by shape rather than by matching prose.
 */
export type GatewayResult<A> =
  | { readonly status: "ok"; readonly value: A; readonly cursor?: ProjectionCursor }
  | { readonly status: "error"; readonly message: string; readonly code?: string }

/** ControlError.FlowNotFound on the wire: its `code` and its tag. */
export const FLOW_NOT_FOUND_CODE = "flow_not_found"
export const FLOW_NOT_FOUND_TAG = "/control/FlowNotFound"

/** Whether a refusal's code is the control plane's "no flow with this id is registered". */
export const isFlowNotFound = (code: string | undefined): boolean =>
  code === FLOW_NOT_FOUND_CODE || code === FLOW_NOT_FOUND_TAG

/** This seam's own refusal: a projection snapshot it could not read as the rows it asked for. */
export const INVALID_PROJECTION_CODE = "invalid_projection"

/** The rc.0 run statuses a card may render. */
export type RunStatus = RunSummaryRow["status"]

/** One discovered flow, as the flow list renders it. */
export interface FlowSummary {
  readonly flowId: string
  readonly description: string | null
}

export type { ApprovalRow, ControlEvent, NodeOutputRow, RunSummaryRow, TranscriptRow }

/** The owning Plue workspace; omission addresses the legacy repo gateway. */
export interface GatewayWorkspaceBinding {
  readonly workspaceId?: string
}

/** How the seam reaches the relay. */
export interface GatewayTransport {
  readonly baseUrl: string
  readonly bindingFor?: (repo: string, runId?: string) => GatewayWorkspaceBinding | { readonly error: string }
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  readonly errorMessageOf: (response: Response, fallback: string) => Promise<string>
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const map = <A, B>(result: GatewayResult<A>, project: (value: A) => B): GatewayResult<B> =>
  result.status === "ok" ? { ...result, value: project(result.value) } : result

/**
 * One projection snapshot's rows, decoded against the schema the gateway
 * serves for that selector.
 *
 * A snapshot whose `rows` is missing, is not an array, or carries a row the
 * served schema rejects is a malformed answer, not an empty workspace: it
 * crosses as a refusal coded `invalid_projection`, so no card renders a row
 * the wire never established. Only a valid empty array is an empty listing.
 */
const snapshotOf = <S extends Schema.Top>(row: S) => Schema.Struct({ rows: Schema.Array(row) })

// A legacy response may omit cursor metadata; its rows remain readable.
const decodeCursor = Schema.decodeUnknownOption(ProjectionCursor)

const rowsDecoder =
  <A>(decode: (input: unknown) => Option.Option<{ readonly rows: ReadonlyArray<A> }>) =>
  (result: GatewayResult<unknown>): GatewayResult<ReadonlyArray<A>> => {
    if (result.status !== "ok") return result
    const decoded = decode(result.value)
    const cursor = decodeCursor(asRecord(result.value).cursor)
    return Option.isSome(decoded)
      ? { status: "ok", value: decoded.value.rows, ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}) }
      : {
        status: "error",
        message: "The workspace answered with a projection I couldn't read.",
        code: INVALID_PROJECTION_CODE
      }
  }

/** The first decoded row of a snapshot, absent when the projection served none. */
const firstRowDecoder =
  <A>(rows: (result: GatewayResult<unknown>) => GatewayResult<ReadonlyArray<A>>) =>
  (result: GatewayResult<unknown>): GatewayResult<A | undefined> => map(rows(result), (all) => all[0])

const decodeRunSummaryRows = rowsDecoder(Schema.decodeUnknownOption(snapshotOf(RunSummaryRow)))
const decodeRunSummaryRow = firstRowDecoder(decodeRunSummaryRows)
const decodeApprovalRows = rowsDecoder(Schema.decodeUnknownOption(snapshotOf(ApprovalRow)))
const decodeNodeOutputRow = firstRowDecoder(rowsDecoder(Schema.decodeUnknownOption(snapshotOf(NodeOutputRow))))
const decodeTranscriptRows = rowsDecoder(Schema.decodeUnknownOption(snapshotOf(TranscriptRow)))
const decodeControlEventRows = rowsDecoder(Schema.decodeUnknownOption(snapshotOf(ControlEvent)))

/**
 * The typed error's code in a relayed failure's `detail` (the gateway's
 * cause, carried whole by the relay). Effect's RPC protocol encodes a failure
 * cause as an array of reasons, `[{ _tag: "Fail", error }]`, so the first
 * `Fail` reason's error is the typed refusal; a bare record is the error
 * itself when it carries a code or a `/control/...` tag, else the `error` it
 * wraps. The `code` field wins; a tag in the `/control/...` form is the
 * fallback; anything else names no code.
 */
const errorCodeOf = (detail: unknown): string | undefined => {
  const isTyped = (record: Record<string, unknown>): boolean =>
    typeof record.code === "string" || (typeof record._tag === "string" && record._tag.startsWith("/"))
  const typed = Array.isArray(detail)
    ? asRecord(detail.map(asRecord).find((reason) => reason._tag === "Fail")?.error)
    : isTyped(asRecord(detail))
    ? asRecord(detail)
    : asRecord(asRecord(detail).error)
  if (typeof typed.code === "string" && typed.code !== "") return typed.code
  return typeof typed._tag === "string" && typed._tag.startsWith("/") ? typed._tag : undefined
}

/**
 * The Plue floor, as this app's own seam: list flows and runs, launch, read a
 * run, list and decide approvals (one run's or the workspace inbox), resume,
 * steer, signal, read a node's output or a run's transcript and events,
 * explain a run, and cancel it.
 *
 * @param transport how to reach the relay
 */
export const createGatewaySeam = (transport: GatewayTransport) => {
  const { baseUrl, errorMessageOf } = transport

  /** One relayed gateway procedure. */
  const call = async (
    repo: string,
    procedure: string,
    payload: unknown,
    binding?: GatewayWorkspaceBinding
  ): Promise<GatewayResult<unknown>> => {
    const candidate = asRecord(payload)
    const runId = candidate.runId ?? asRecord(candidate.selector).runId ?? asRecord(candidate.target).runId
    const target = binding ?? transport.bindingFor?.(repo, typeof runId === "string" ? runId : undefined) ?? {}
    if ("error" in target) return { status: "error", message: target.error }
    let body: { ok?: unknown; payload?: unknown; error?: unknown; message?: unknown } | undefined
    try {
      const response = await transport.fetch(`${baseUrl}${WORKFLOW_RPC_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, procedure, payload, ...target })
      })
      if (!response.ok) {
        return { status: "error", message: await errorMessageOf(response, "The workspace didn't answer.") }
      }
      body = (await response.json().catch(() => undefined)) as typeof body
    } catch {
      return { status: "error", message: "The workspace didn't answer: the flow service is unreachable." }
    }
    if (body?.ok === true) return { status: "ok", value: body.payload }
    if (body?.ok === false) {
      const error = asRecord(body.error)
      const message = error.message
      const code = errorCodeOf(error.detail)
      return {
        status: "error",
        message: typeof message === "string" && message !== "" ? message : "The workspace refused the call.",
        ...(code === undefined ? {} : { code })
      }
    }
    if (typeof body?.message === "string") return { status: "error", message: body.message }
    return { status: "error", message: "The workspace answered in a shape I didn't understand." }
  }

  /** One projection snapshot, by selector. */
  const projection = (
    repo: string,
    selector: unknown,
    binding?: GatewayWorkspaceBinding,
    after?: ProjectionCursor
  ): Promise<GatewayResult<unknown>> =>
    call(repo, "Projection.Snapshot", { selector, ...(after === undefined ? {} : { after }) }, binding)

  return {
    call,

    /** Every flow the workspace has discovered. */
    listFlows: async (repo: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<ReadonlyArray<FlowSummary>>> =>
      map(await call(repo, "List", { _tag: "flows" }, binding), (value) => {
        const items = asRecord(value).items
        return (Array.isArray(items) ? items : [])
          .map((entry) => asRecord(entry))
          .filter((entry) => typeof entry.flowId === "string")
          .map((entry): FlowSummary => ({
            flowId: entry.flowId as string,
            description: typeof entry.description === "string" && entry.description.trim() !== ""
              ? entry.description
              : null
          }))
      }),

    /**
     * Start a flow: plan it, approve the plan, and run it.
     *
     * Three calls because they are three decisions, and the middle one is the
     * approval a human or a policy grants. The relay never replays a `Run`, so
     * a lost answer here is reported rather than retried into a second run.
     */
    launch: async (
      repo: string,
      flowId: string,
      input: Record<string, unknown>,
      requestedBinding?: GatewayWorkspaceBinding
    ): Promise<GatewayResult<{ readonly runId: string; readonly workspaceId?: string }>> => {
      const binding = requestedBinding ?? transport.bindingFor?.(repo) ?? {}
      if ("error" in binding) return { status: "error", message: binding.error }
      const planned = await call(repo, "Plan", { flowId, input }, binding)
      if (planned.status !== "ok") return planned
      const card = asRecord(planned.value)
      const planId = typeof card.planId === "string" ? card.planId : undefined
      const digest = typeof card.digest === "string" ? card.digest : undefined
      if (planId === undefined || digest === undefined) {
        return { status: "error", message: "The workspace planned the run but didn't name the plan." }
      }
      const approved = await call(repo, "Approval.Submit", {
        target: { _tag: "Plan", planId, digest, envelope: card.envelope },
        scope: "run",
        idempotencyKey: `approve:${planId}`,
        decision: "approve"
      }, binding)
      if (approved.status !== "ok") return approved
      const started = await call(repo, "Run", {
        _tag: "Plan",
        planId,
        digest,
        envelope: card.envelope,
        idempotencyKey: `run:${planId}`
      }, binding)
      if (started.status !== "ok") return started
      const runId = asRecord(started.value).runId
      return typeof runId === "string"
        ? { status: "ok", value: { runId, ...binding } }
        : { status: "error", message: "The run started but the workspace didn't name it — ask me to check." }
    },

    /** One run's summary, including its diagnosis. */
    run: async (repo: string, runId: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<RunSummaryRow | undefined>> =>
      decodeRunSummaryRow(await projection(repo, { _tag: "run-summary", runId }, binding)),

    /** Every gate this run has asked for, decided ones included. */
    approvals: async (repo: string, runId: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<ReadonlyArray<ApprovalRow>>> =>
      decodeApprovalRows(await projection(repo, { _tag: "approvals", runId }, binding)),

    /**
     * Decide one gate.
     *
     * The payload the projection published goes back unchanged, so the client
     * never reconstructs authority. One call records the decision AND resumes
     * the run it unblocked: there is no second resume for a lost answer to
     * strand.
     */
    submitApproval: (
      repo: string,
      approval: ApprovalRow["payload"],
      decision: "approve" | "deny",
      binding?: GatewayWorkspaceBinding
    ): Promise<GatewayResult<unknown>> => call(repo, "Approval.Submit", { ...approval, decision }, binding),

    /** What one node produced. */
    nodeOutput: async (
      repo: string,
      runId: string,
      nodeId: string,
      binding?: GatewayWorkspaceBinding
    ): Promise<GatewayResult<NodeOutputRow | undefined>> =>
      decodeNodeOutputRow(await projection(repo, { _tag: "node-output", runId, nodeId }, binding)),

    /** What happened to a run, in words: the run summary's diagnosis. */
    explain: async (repo: string, runId: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<string | undefined>> =>
      map(decodeRunSummaryRow(await projection(repo, { _tag: "run-summary", runId }, binding)), (row) => row?.verdict),

    /** Stop a run. Durable: the next read of it says cancelled. */
    cancel: (repo: string, runId: string, reason?: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<unknown>> =>
      call(repo, "Cancel", {
        runId,
        idempotencyKey: `cancel:${runId}`,
        reason: reason === undefined || reason.trim() === "" ? "the human stopped it" : reason
      }, binding),

    /*
     * Lane runs — the run lifecycle beyond launch and cancel.
     *
     * Every mutation mints one idempotency key per invocation from a fresh
     * `crypto.randomUUID()`, never the clock: the relay may replay a lost
     * answer with the same frame, and the engine deduplicates on the key, so a
     * repeat lands one effect and two deliberate clicks land two even inside
     * one millisecond (a second resume of a live run is the gateway's own
     * ClaimLost).
     */

    /** Restart a parked run (or tell the run's owner to). */
    resume: (repo: string, runId: string, reason?: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<unknown>> =>
      call(repo, "Resume", {
        runId,
        idempotencyKey: `resume:${runId}:${crypto.randomUUID()}`,
        ...(reason === undefined ? {} : { reason })
      }, binding),

    /** Deliver a named signal to a run parked on a wait. */
    signal: (repo: string, runId: string, name: string, payload: unknown, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<unknown>> =>
      call(repo, "Signal", {
        runId,
        signal: { name, payload: payload ?? {} },
        idempotencyKey: `signal:${runId}:${name}:${crypto.randomUUID()}`
      }, binding),

    /**
     * Steer a running agent. The steer envelope's principal is the server's
     * to stamp (`ControlServer` overwrites it with the authenticated one on
     * every steer that arrives over RPC), so the placeholder here never
     * reaches a journal as authority.
     */
    steer: (
      repo: string,
      runId: string,
      item:
        | { readonly kind: "Message"; readonly body: string }
        | { readonly kind: "Seat"; readonly seat: string }
        | { readonly kind: "Thinking"; readonly thinking: string }
        | { readonly kind: "Tools"; readonly toolNames: ReadonlyArray<string> },
      binding?: GatewayWorkspaceBinding
    ): Promise<GatewayResult<unknown>> => {
      const now = Date.now()
      const nonce = crypto.randomUUID()
      const envelope = {
        messageId: `steer-${runId}-${nonce}`,
        runId,
        principal: { id: "app-operator", kind: "user", stampedAt: now },
        createdAt: now
      }
      const message = (
        item.kind === "Message"
          ? { ...envelope, kind: "Message", body: item.body }
          : item.kind === "Seat"
          ? { ...envelope, kind: "Seat", seat: item.seat }
          : item.kind === "Thinking"
          ? { ...envelope, kind: "Thinking", thinking: item.thinking }
          : { ...envelope, kind: "Tools", toolNames: [...item.toolNames] }
      ) as SteerMessage
      return call(repo, "Steer", { runId, message, idempotencyKey: `steer:${runId}:${nonce}` }, binding)
    },

    /** Every run on the workspace, one summary row each (the run inbox's read). */
    workspaceRuns: async (repo: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<ReadonlyArray<RunSummaryRow>>> =>
      decodeRunSummaryRows(await projection(repo, { _tag: "workspace-runs" }, binding)),

    /** The approvals inbox: every pending gate across the workspace's runs. */
    approvalsInbox: async (repo: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<ReadonlyArray<ApprovalRow>>> =>
      decodeApprovalRows(await projection(repo, { _tag: "approvals" }, binding)),

    /** One run's turn-by-turn transcript. */
    transcript: async (repo: string, runId: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<ReadonlyArray<TranscriptRow>>> =>
      decodeTranscriptRows(await projection(repo, { _tag: "transcript", runId }, binding)),

    /** Journal rows after a cursor; omit it for full historical inspection. */
    runEvents: async (
      repo: string,
      runId: string,
      binding?: GatewayWorkspaceBinding,
      after?: ProjectionCursor
    ): Promise<GatewayResult<ReadonlyArray<ControlEvent>>> =>
      decodeControlEventRows(await projection(repo, { _tag: "run-events", runId }, binding, after))
  }
}

/** The gateway seam this app's controller holds. */
export type GatewaySeam = ReturnType<typeof createGatewaySeam>
