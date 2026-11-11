/**
 * A markdown flow a cell calls, run as a nested run of the caller's own loop.
 *
 * `Agent` builds the runner for a run whose host set `Agent.Options.children`.
 * The runner adds no loop of its own: it derives the child's options from the
 * caller's and runs them through the same `Agent` implementation, with the
 * caller's run services, inside the caller's durable call boundary. The
 * boundary is what makes the child durable: a settled call is served from its
 * record on replay, and a child cut off by a crash runs again from its own
 * sealed model steps, which are keyed under the child's session.
 *
 * @since 1.0.0-rc.17
 */

import * as Capability from "@smthrs/capability/Capability"
import type { FlowRuntime } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import type * as CellCalls from "@smthrs/harness/CellCalls"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Registry from "@smthrs/registry/Registry"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { Child, Children, Options, Service } from "../Agent.ts"
import * as Budget from "../Budget.ts"
import type * as QuotaPolicy from "../QuotaPolicy.ts"
import { agentOutcome } from "./AgentOutcome.ts"
import { callId } from "./CallIdentity.ts"
import { declaredEffort } from "./Effort.ts"

/**
 * The run services a child runs with: the caller's own. Steering is not among
 * them: the caller's queue is drained by the caller.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Services =
  | FlowRuntime.FlowRuntime
  | FlowRuntime.FlowInstance
  | Sandbox.Sandbox
  | Budget.Budget
  | QuotaPolicy.QuotaClassifier
  | Evaluator.Evaluator

/** The longest failure message a child's call result carries. */
const maxMessage = 2_048

/**
 * The registry a run with children shows its cells: the discovered one, less
 * the markdown flow the run is itself, in the catalog and at the boundary.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const withoutSelf = (discovered: Registry.Registry, self: string | undefined): Registry.Registry => {
  if (self === undefined) return discovered
  const offered = (entry: { readonly name: string; readonly body: { readonly _tag: string } }): boolean =>
    entry.name !== self || entry.body._tag !== "Markdown"
  return {
    ...discovered,
    visible: () => Effect.map(discovered.visible(), (entries) => entries.filter(offered)),
    getOption: (name) => Effect.map(discovered.getOption(name), Option.filter(offered))
  }
}

/**
 * The options one child runs under: the caller's, with what a child must not
 * inherit replaced. See `Agent.Children`.
 */
const childOptions = (
  parent: Options,
  children: Children,
  child: Child,
  prompt: CellCalls.Prompt,
  seats: ReadonlyArray<Options["seat"]>
): Options => {
  const effort = declaredEffort(prompt.descriptor) ?? parent.modelParams?.reasoningEffort
  return {
    ...parent,
    session: child.session,
    seat: seats[0]!,
    fallbackSeats: seats.slice(1),
    prompt: prompt.text,
    modelParams: ModelRequest.GenerationParams.make({
      ...parent.modelParams,
      ...(effort === undefined ? {} : { reasoningEffort: effort })
    }),
    flows: children.flows,
    // What the flow declares, which the call boundary has already checked is
    // within the caller's envelope: a child never holds more than its caller.
    capabilityEnvelope: prompt.descriptor.capabilities.flatMap((declared) =>
      Option.toArray(Capability.parsePattern(declared))
    ),
    // One level deep: a run with neither shows no markdown flow.
    promptRunner: undefined,
    children: undefined,
    // Nothing a child does may park its caller.
    authorize: undefined,
    approvalChannel: false,
    capacity: { ...parent.capacity, park: false },
    memory: undefined,
    output: undefined,
    // The caller's banks, monitors and stance; a child mines nothing into memory.
    supervisor: { ...parent.supervisor, remember: false }
  }
}

/** A failed child, as the resolved failure its caller's cell reads. */
const failed = (flow: string, reason: string): Cell.CallResult =>
  Cell.CallResult.new({
    outcome: "failure",
    value: null,
    code: "flow_failed",
    message: `The child run of ${flow} failed: ${reason}`.slice(0, maxMessage)
  })

/**
 * The prompt runner that runs each markdown call as a child of `parent`.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const runner = (input: {
  /** The options the caller runs under. */
  readonly parent: Options
  readonly children: Children
  /** The caller's run services, captured where its run started. */
  readonly services: Context.Context<Services>
  /** The loop the caller runs on, and so the one its children run on. */
  readonly run: Service["run"]
}): CellCalls.PromptRunner =>
(prompt) =>
  Effect.gen(function*() {
    const id = callId(prompt.call.identity)
    const child: Child = {
      callId: id,
      flow: prompt.call.flowName,
      session: `${input.parent.session}/child/${id}`
    }
    const declared = Option.getOrUndefined(prompt.descriptor.model)
    const ids = declared === undefined ? [] : typeof declared === "string" ? [declared] : declared
    const outcome = yield* Effect.gen(function*() {
      const seats = ids.length === 0
        ? [input.parent.seat, ...(input.parent.fallbackSeats ?? [])]
        : yield* Effect.forEach(ids, (seat) => input.children.seats.resolve(seat, ids[0]))
      return yield* agentOutcome(
        input.run(childOptions(input.parent, input.children, child, prompt, seats)),
        (event) => input.children.observe(child, event)
      )
    }).pipe(
      Effect.provideContext(input.services),
      Effect.provideService(Steering.Source, Steering.makeNoop()),
      // The caller's observer checkpoints the caller's events, not these.
      Effect.provideService(AgentEvent.Observer, () => Effect.void),
      // A budget the child spends fails the child; the caller parks on it at
      // its own next model call, where an operator's raise is meant for.
      Effect.updateContext((context: Context.Context<never>) => Context.omit(Budget.Parking)(context)),
      Effect.result
    )
    if (outcome._tag === "Failure") return failed(child.flow, outcome.failure.message)
    if (outcome.success._tag === "FramesExhausted") {
      return failed(child.flow, `it ended ${outcome.success.frames} frames without calling ctx.done`)
    }
    return Cell.CallResult.new({ outcome: "success", value: outcome.success.output })
  })
