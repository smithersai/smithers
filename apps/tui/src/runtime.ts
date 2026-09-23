/** Agent-facing runtime UI and delegation use the harness's existing flow catalog. */
import * as SmithersPlugin from "@smthrs/agent/SmithersPlugin"
import { Flow } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import * as Agents from "./agents.ts"
import * as Panels from "./panels.ts"
import type { DelegateModel } from "./models.ts"
import type * as Monitors from "./monitors.ts"

export interface Ports {
  readonly publish: (panel: Panels.Panel) => void
  readonly delegate?: (request: { id: string; title: string; prompt: string; model?: DelegateModel; agent?: string }) => unknown
  readonly wait?: (ids: ReadonlyArray<string>) => Promise<unknown>
  readonly read?: (id: string) => unknown
  readonly list?: () => unknown
  readonly retry?: (id: string) => unknown
  /** Every active tab's and flow run's estimate; see `estimate.ts`. */
  readonly eta?: () => unknown
  /** The user's flow runs, served to cells by the Smithers plugin. */
  readonly flows?: SmithersPlugin.Ports
  readonly monitors?: Pick<Monitors.Monitors, "create" | "list" | "stop">
}
/** The plugins every turn runs with: Smithers, with the flow ports when the role has them. */
export const plugins = (ports?: Ports) => [SmithersPlugin.make(ports?.flows)]
const short = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))
/**
 * A thrown error's public text. A tagged error (`_tag`, optional `code`) keeps
 * its tag, so the cell reads `JevFailed (unreachable): ...` and not prose alone.
 */
export const publicError = (error: Error): string => {
  const { _tag: tag, code } = error as { _tag?: unknown; code?: unknown }
  if (typeof tag !== "string") return error.message
  return `${tag}${typeof code === "string" ? ` (${code})` : ""}: ${error.message}`
}
const bind = <I extends Flow.AnyStructSchema & Schema.ConstraintDecoder<unknown, never>>(
  name: string,
  description: string,
  input: I,
  handle: (input: I["Type"]) => unknown,
  /** Consequential capabilities the approval gate asks for; see `Approvals.requests`. */
  capabilities: ReadonlyArray<string> = []
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
      capabilities,
      effects: { reads: [], writes: [], tier: "irreversible", mode: "expected", onConflict: "serialize" }
    },
    handler: (input) => {
      // A typed refusal keeps its code: `unknown_agent: No agent named x`.
      const caught = (cause: unknown) =>
        cause instanceof Agents.AgentError
          ? new Error(`${cause.code}: ${cause.message}`)
          : cause instanceof Error
          ? cause
          : new Error("Runtime request failed")
      // Optional fields arrive as `undefined`, which a cell result cannot carry.
      const clean = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as unknown
      return Effect.flatMap(Effect.try({ try: () => handle(input), catch: caught }), (value) =>
        value instanceof Promise
          ? Effect.tryPromise({ try: async () => clean(await value), catch: caught })
          : Effect.try({ try: () => clean(value), catch: caught }))
    },
    publicError
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
    ...(ports.monitors === undefined ? [] : [
      bind(
        "monitor.create",
        "Watch a source and tell the user only when something notable happens; returns immediately. Jev judges each change against watch; Luna writes the one-line update. source is {kind:\"tab\",id} (a worker tab), {kind:\"run\",id} (a smithers.run id) or {kind:\"shell\",command}. trigger is {kind:\"events\"} (default for tab and run) or {kind:\"interval\",seconds} (10 to 86400; required for shell, default 60). Reuse id to deduplicate or restart a stopped or failed monitor.",
        Schema.Struct({
          id: short,
          title: short,
          watch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
          source: Schema.Union([
            Schema.Struct({ kind: Schema.Literal("tab"), id: short }),
            Schema.Struct({ kind: Schema.Literal("run"), id: short }),
            Schema.Struct({ kind: Schema.Literal("shell"), command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)) })
          ]),
          trigger: Schema.optional(Schema.Union([
            Schema.Struct({ kind: Schema.Literal("events") }),
            Schema.Struct({ kind: Schema.Literal("interval"), seconds: Schema.Number })
          ]))
        }),
        (input) => ports.monitors!.create(input),
        // A shell source runs its command every tick: the gate asks, per call.
        ["proc:spawn:*"]
      ),
      bind(
        "monitor.list",
        "List monitors: id, title, status, update count and any failure.",
        Schema.Struct({}),
        () => ports.monitors!.list()
      ),
      bind(
        "monitor.stop",
        "Stop a monitor.",
        Schema.Struct({ id: short }),
        (input) => ports.monitors!.stop(input.id)
      )
    ]),
    ...(ports.eta === undefined ? [] : [
      bind(
        "tab.eta",
        "Estimated remaining minutes and tokens for every active tab and flow run, from past runs and scored earlier estimates. Use it to answer ETA questions.",
        Schema.Struct({}),
        () => ports.eta!()
      )
    ]),
    ...(ports.delegate === undefined ? [] : [
      bind(
        "agent.delegate",
        "Request background work in a separate agent tab and return immediately. Six run at once by default; more queue FIFO. Reuse id to deduplicate. agent names one of the Agents in your context to run with its own prompt, model and flows. Workers may wait with agent.wait; the coordinator must not wait.",
        Schema.Struct({
          id: short,
          title: short,
          prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)),
          model: Schema.optional(Schema.Literals(["cerebras", "luna", "sol", "astra"])),
          agent: Schema.optional(short)
        }),
        (input) => ports.delegate!(input)
      ),
      bind(
        "tab.read",
        "Read a background agent's status, summary and recent cells. Does not wait. Do not poll in a loop; return to the user while it runs.",
        Schema.Struct({ id: short }),
        (input) => ports.read!(input.id)
      ),
      ...(ports.retry === undefined ? [] : [
        bind(
          "tab.retry",
          "Run a failed or stopped background tab or flow run again, with its original task and model, when the user asks for it. Returns its new status at once; requested or queued is not started.",
          Schema.Struct({ id: short }),
          (input) => ports.retry!(input.id)
        )
      ]),
      bind(
        "tab.list",
        "List the background agent tabs and their actual status. Does not wait. Do not poll; the UI shows progress.",
        Schema.Struct({}),
        () => ports.list!()
      ),
      ...(ports.wait === undefined ? [] : [bind(
        "agent.wait",
        "Wait for child tabs to settle. Pass child request ids; returns each id, status, answer or message. Waiting releases this worker's pool slot.",
        Schema.Struct({ ids: Schema.Array(short).check(Schema.isMinLength(1)) }),
        (input) => ports.wait!(input.ids)
      )])
    ])
  ])
export const coordinatorTeaching =
  `You are the fast coordinator. For long-running or multi-agent work, delegate one root worker with agent.delegate, then publish one ui.publish panel with placement:"main" and bind:{tree:rootId}. Keep rows only for information you will update; the bound tree updates itself. End the same cell with ctx.done and a brief honest acknowledgement. Never wait for a worker; completions arrive in a later turn. Use distinct ids for distinct tasks and repeat an id only to deduplicate. Workers share the repository, so include constraints in the prompt. Use smithers.run for a user's matching flow. When one of the Agents in your context fits the task, delegate with agent.delegate and its agent name. Available worker seat: `

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
