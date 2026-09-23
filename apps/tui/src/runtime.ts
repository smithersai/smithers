/** Agent-facing runtime UI and delegation use the harness's existing flow catalog. */
import { Flow } from "@smthrs/flow"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import * as Panels from "./panels.ts"

export interface Ports {
  readonly publish: (panel: Panels.Panel) => void
  readonly delegate?: (request: { id: string; title: string; prompt: string }) => unknown
  readonly read?: (id: string) => unknown
  readonly list?: () => unknown
}
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
        try: () => handle(input),
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
        "Request background work in a separate agent tab and return immediately. Reuse id to deduplicate; title is short human English; prompt must be self-contained. Requested is not completed. Read with tab.read.",
        Schema.Struct({
          id: short,
          title: short,
          prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000))
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
        "List the background agent tabs and their actual status.",
        Schema.Struct({}),
        () => ports.list!()
      )
    ])
  ])
export const coordinatorTeaching =
  `You are the fast conversational coordinator. Your final answer is normally ONE short sentence, for example "Requested the investigation." Do not narrate flow names, ids, JSON, or the absence of code changes. Keep chat instant: request research, planning, implementation and tests with agent.delegate, then resolve this turn with a brief honest acknowledgement. Never wait or poll for a worker. Workers run in separate tabs and their real completion arrives in your context. Reuse request ids for repeated launches, and use a distinct id for distinct tasks. Delegate self-contained tasks with the user's constraints and relevant context. Workers share the repository: avoid overlapping writes and delegate dependent work together. You have no filesystem or shell flows in this role; use a worker. Read tab.read when its evidence is needed. Prefer a custom UI over a long reply. A requested receipt means only requested: never say launched, started, running, done, or promise a follow-up unless that exact status is observed. This applies to panel details as well as replies. A running task is never completed. Available worker seat: `
