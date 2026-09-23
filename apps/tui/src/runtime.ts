/** Agent-facing runtime UI and delegation use the harness's existing flow catalog. */
import * as SmithersPlugin from "@smthrs/agent/SmithersPlugin"
import { Flow } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import * as Panels from "./panels.ts"
import type { DelegateModel } from "./models.ts"

export interface Ports {
  readonly publish: (panel: Panels.Panel) => void
  readonly delegate?: (request: { id: string; title: string; prompt: string; model?: DelegateModel }) => unknown
  readonly read?: (id: string) => unknown
  readonly list?: () => unknown
  /** The user's flow runs, served to cells by the Smithers plugin. */
  readonly flows?: SmithersPlugin.Ports
}
/** The plugins every turn runs with: Smithers, with the flow ports when the role has them. */
export const plugins = (ports?: Ports) => [SmithersPlugin.make(ports?.flows)]
const short = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))
const bind = <I extends Flow.AnyStructSchema & Schema.ConstraintDecoder<unknown, never>>(
  name: string,
  description: string,
  input: I,
  handle: (input: I["Type"]) => unknown
): FlowBinding.Binding => {
  const flow = Flow.make(name, {
    description,
    payload: input,
    success: Schema.Unknown,
    body: () => Node.succeed(undefined)
  })
  return FlowBinding.make({
    flow: {
      ...flow,
      name: flow._tag,
      input,
      output: flow.successSchema,
      capabilities: [],
      effects: { reads: [], writes: [], tier: "irreversible", mode: "expected", onConflict: "serialize" }
    },
    handler: (input) =>
      Effect.try({
        // Optional fields arrive as `undefined`, which a cell result cannot carry.
        try: () => JSON.parse(JSON.stringify(handle(input) ?? null)) as unknown,
        catch: (cause) => new Error(cause instanceof Error ? cause.message : "Runtime request failed")
      }),
    publicError: (error) => error.message
  })
}
export const source = (ports: Ports): FlowBinding.Source =>
  FlowBinding.source("tui/runtime", [
    bind(
      "ui.publish",
      "Create or update a custom terminal panel; returns immediately. Same id replaces the view without stealing focus. Use one sentence and concise rows with expandable code, tables, text or diffs.",
      Panels.Panel,
      (input) => {
        const panel = Panels.decode(input)
        ports.publish(panel)
        return { id: panel.id, status: "published" }
      }
    ),
    ...(ports.delegate === undefined ? [] : [
      bind(
        "agent.delegate",
        "Request background work in a separate agent tab and return immediately. Three run at once; more return status queued and start automatically, oldest first, when one settles. Never wait for a seat. Reuse id to deduplicate; title is short human English; prompt must be self-contained. Requested or queued is not started or completed. Read with tab.read.",
        Schema.Struct({
          id: short,
          title: short,
          prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)),
          model: Schema.optional(Schema.Literals(["quince", "cerebras", "chat", "gpt", "luna", "sol", "astra"]))
        }),
        (input) => ports.delegate!(input)
      ),
      bind(
        "tab.read",
        "Read a background agent's status, summary and recent cells. Does not wait. Do not poll in a loop; return to the user while it runs.",
        Schema.Struct({ id: short }),
        (input) => ports.read!(input.id)
      ),
      bind(
        "tab.list",
        "List the background agent tabs and their actual status. Does not wait. Do not poll; the UI shows progress.",
        Schema.Struct({}),
        () => ports.list!()
      )
    ])
  ])
export const coordinatorTeaching =
  `You are the fast conversational coordinator. Your final answer is normally ONE short sentence, for example "Requested the investigation." Do not narrate flow names, ids, JSON, or the absence of code changes. When one of the user's flows (smithers.flows) does the task, request it with smithers.run instead of a worker. Keep chat instant: request research, planning, implementation and tests with agent.delegate, then resolve this turn with a brief honest acknowledgement. Every turn ends with ctx.done(acknowledgement) in the cell that makes the request; console.log does not end it. Never wait, retry, or re-check tab.list for a worker within a turn: each cell spends one of a few frames, the UI shows progress, and completions reach your next turn. If a request fails, end the turn saying it was not made and why. Workers run in separate tabs and their real completion arrives in your context. Reuse request ids for repeated launches, and use a distinct id for distinct tasks. Delegate self-contained tasks with the user's constraints and relevant context. Workers share the repository: avoid overlapping writes and delegate dependent work together. You have no filesystem or shell flows in this role; use a worker. Read tab.read when its evidence is needed. Prefer a custom UI over a long reply. A requested or queued receipt means only requested or queued: never say launched, started, running, done, or promise a follow-up unless that exact status is observed. This applies to panel details as well as replies. A running task is never completed. Available worker seat: `

/** Requests the coordinator makes; a failed one is work the user asked for that nobody took. */
export const requestFlows: Readonly<Record<string, string>> = { "agent.delegate": "Not delegated", "smithers.run": "Not run" }

/** A failed call's reason in the flow's own words, without the harness's prefix. */
export const failureReason = (message: string | undefined): string =>
  (message ?? "failed").replace(/^Flow \S+ failed: /, "")

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * Rewrites a coordinator turn's budget-exhausted answer into what happened.
 *
 * The harness ends a run whose frames ran out with a generic sentence about
 * its last transition. The coordinator's frames are few, and a turn that
 * spends them re-trying a refused delegation left the user reading "a request
 * to continue" while the work was never handed to anyone. The ledger reads the
 * turn's own journaled calls, so the answer names each request whose last
 * attempt failed, and each one a worker took.
 *
 * A turn that completed, which the cell says with a `complete` transition,
 * keeps its own answer only when no request's last attempt failed. A small
 * seat writes `ctx.done("Delegated …")` in the cell that makes the request,
 * before the result exists, and says it again after the harness hands the
 * claim back with the failure. The receipts decide what was requested; the
 * model's sentence does not.
 */
export const ledger = (maxFrames: number): (event: AgentEvent.AgentEvent) => AgentEvent.AgentEvent => {
  const started = new Map<string, { readonly verdict: string; readonly id: string; readonly title: string }>()
  const failed = new Map<string, string>()
  const requested = new Map<string, string>()
  let completed = false
  const key = (identity: { readonly frame: number; readonly cell: string; readonly ordinal: number }) =>
    `${identity.frame}:${identity.cell}:${identity.ordinal}`
  return (event) => {
    switch (event._tag) {
      case "cell-call-started": {
        const verdict = requestFlows[event.call.flowName]
        if (verdict === undefined) return event
        const input = record(event.call.input)
        const id = String(input.id ?? "")
        const title = String(input.title ?? input.flow ?? id)
        started.set(key(event.call.identity), { verdict, id, title })
        return event
      }
      case "cell-call-settled": {
        const request = started.get(key(event.identity))
        if (request === undefined) return event
        const label = `${request.verdict}::${request.id}`
        if (event.result.outcome === "success") {
          failed.delete(label)
          requested.set(request.id, request.title)
        } else {
          failed.set(label, `${request.verdict}: ${request.title} (${failureReason(event.result.message)})`)
        }
        return event
      }
      case "transition-applied":
        completed = event.transition._tag === "complete"
        return event
      case "resolved": {
        if (completed && failed.size === 0) return event
        const lines = [
          ...(completed ? [] : [`Stopped after ${maxFrames} frames.`]),
          ...failed.values(),
          ...[...requested.values()].map((title) => `Requested: ${title}`)
        ]
        return new AgentEvent.Resolved({
          eventType: event.eventType,
          message: ModelRequest.Message.assistant(lines.join("\n"), { stopReason: "stop" })
        })
      }
      default:
        return event
    }
  }
}
