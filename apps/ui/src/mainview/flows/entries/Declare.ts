/*
 * What every flow module declares with: the `flow` constructor that pairs a
 * declaration with its handler, the shared payload schemas, and the controller
 * surface a handler acts on. Flows.ts re-exports the public half.
 */
import * as Flow from "@smthrs/core/Flow"
import type * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Effect, Schema } from "effect"
import { FlowCancellation } from "../FlowCancellation"
import type { RuntimeCapability } from "@smthrs/rpc/AppBootstrap"
import type { AppController } from "../../state/AppController"
import type { CommandState, FlowEntry, FlowMetadata } from "../registry"

/**
 * What a flow handler resolves: nothing, an honest error string, or a success
 * VALUE (`{ value }`) — the payload an invocation hands back to its caller
 * (e.g. the browser flow's extracted text). Agent tool payloads never render
 * raw in the transcript (DESIGN.md §3, trigger axis); the controller may
 * surface a HUMAN caller's value as that command's embedded answer.
 */
export type CommandResult = void | string | { readonly value: string }

/**
 * The controller actions flows bind to. This is the AppController surface minus
 * the dispatch members themselves, so the registry never calls back through its
 * own run path.
 */
export type CommandActions =
  & Omit<
    AppController,
    | "store"
    | "storageRecoveryState"
    | "nativeAgentAvailable"
    | "nativeRepositoriesAvailable"
    | "slashCommands"
    | "slashItems"
    | "slashTree"
    | "runCommand"
    | "commands"
    | "tappedFetch"
    // Feature flags and the download URL are the composition root's configuration, never an action.
    | "features"
    | "downloadUrl"
    // The scope close is the composition root's act, never a flow's.
    | "dispose"
  >
  & {
    readonly snapshot: () => CommandState
  }

/**
 * The success schema every app flow shares.
 *
 * These flows act on the app rather than compute a result, so the honest
 * success payload is "it ran", optionally carrying the one string the agent
 * boundary hands back to the model.
 */
export const Ack = Schema.Struct({ value: Schema.optional(Schema.String) })

/** The default claim: acting on the app the human is already looking at. */
const APP_ACT: ReadonlyArray<string> = ["app:act"]

/**
 * Runs a controller call as the flow's handler.
 *
 * The controller's string return is its honest refusal, so it becomes the
 * typed error channel — which `FlowBinding` renders as a catchable `failure`
 * call result rather than a harness failure. Thrown host errors use the opaque
 * default; only explicitly returned refusal strings are public.
 */
const act = (
  run: (signal: AbortSignal) => CommandResult | Promise<CommandResult>
): Effect.Effect<{ readonly value?: string }, string | { readonly cause: unknown }> =>
  Effect.suspend(() => {
    let pending: Promise<CommandResult> | undefined
    return Effect.tryPromise({
      try: async (signal) => {
        pending = Promise.resolve(run(signal))
        return pending
      },
      // Preserve diagnostics for host-side error taps, including thrown strings.
      catch: (cause) => ({ cause })
    }).pipe(
      // Abort is cooperative. A controller that cannot abort must finish before
      // its binding exits, so no abandoned promise can mutate after Stop returns.
      Effect.onInterrupt(() => Effect.promise(async () => { await pending?.catch(() => {}) })),
      Effect.flatMap((result) =>
        typeof result === "string"
          ? Effect.fail(result)
          : Effect.succeed(
            typeof result === "object" && result !== null ? { value: result.value } : {}
          ))
    )
  })

/**
 * The payload schemas a flow may declare: anything that decodes from unknown
 * without asking the host for a service, which is the contract `FlowBinding`
 * needs in order to decode a call's input on its own.
 */
type Payload = Schema.Top & Schema.ConstraintDecoder<unknown, never>

/** Everything one registered flow declares, in one literal. */
export interface Declaration<I extends Payload> extends FlowMetadata {
  readonly name: string
  readonly input: I
  /** The call identity is available for destination-side idempotency. */
  readonly handler: (payload: I["Type"], signal: AbortSignal, call: Cell.Call) => CommandResult | Promise<CommandResult>
  /** Capability claims; the free `app:act` default when omitted. */
  readonly capabilities?: ReadonlyArray<string>
  /**
   * The human's alone: never disclosed to, or callable by, the model. An
   * enumerated exception under the three-door law (AGENTS.md) for a gesture
   * that is physically the human's or an answer only they may give — never
   * for an act that is merely consequential (that is `confirm`). Every
   * `userOnly` flow states its `userOnlyReason`; flows/agent-parity.test.ts
   * enumerates them.
   */
  readonly userOnly?: boolean
  /** Bootstrap capabilities required for this flow to exist in the registry. */
  readonly runtime?: ReadonlyArray<RuntimeCapability>
}

/**
 * Declares one flow and binds it to its handler.
 *
 * The declaration's description is the catalog line the MODEL reads, so it
 * carries the argument hint; `metadata.summary` stays the human's catalog copy.
 */
export const flow = <I extends Payload>(declaration: Declaration<I>): FlowEntry => {
  const { name, input, handler, capabilities, userOnly, ...metadata } = declaration
  const described = metadata.args === undefined ? metadata.summary : `${metadata.summary} (args: ${metadata.args})`
  return {
    cooperativeCancellation: true,
    binding: FlowBinding.make({
      flow: Flow.make({
        name,
        description: described,
        input,
        output: Ack,
        capabilities: capabilities ?? APP_ACT
      }),
      modelInvocable: userOnly !== true,
      publicError: (message) => typeof message === "string" ? message : undefined,
      handler: (payload, call) => Effect.flatMap(FlowCancellation, (cancellation) =>
        act((signal) => handler(payload, cancellation ?? signal, call)))
    }),
    metadata,
    input
  }
}

/** The payload of a flow that takes nothing. */
export const NoPayload = Schema.Struct({})
/** An optional trailing `owner/repo` target. */
export const RepoTarget = Schema.Struct({ repo: Schema.optional(Schema.String) })
/** A card id, the handle every id-scoped card act takes. */
export const CardTarget = Schema.Struct({ cardId: Schema.String })
/** A Smithers target: the repository it belongs to, its detected workspace, and its label. */
export const TargetRef = Schema.Struct({ repoId: Schema.String, label: Schema.String, workspace: Schema.optional(Schema.String) })
/** A positive issue or pull-request number beside its optional repo. */
export const NumberedTarget = Schema.Struct({
  number: Schema.Number,
  repo: Schema.optional(Schema.String)
})
/** A 1-based position in a repository file (`<path>:<line>:<col> [owner/repo]`, docs/code-intel/PLAN.md §4). */
export const CodePosition = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  repo: Schema.optional(Schema.String)
})
