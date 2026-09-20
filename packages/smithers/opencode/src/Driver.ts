/**
 * The seam between the protocol server and whatever runs a turn.
 *
 * The routes, the store, the hub, and the projection never see an engine.
 * They see this service: start a turn and receive its `AgentEvent`s through
 * a sink, interrupt it, answer a permission, steer text into it, and re-drive
 * whatever was parked when the process last stopped. `ScriptedDriver`
 * implements it by replaying a recording; the durable engine driver
 * implements it over `Agent.run` on the flow engine without touching
 * `Routes`, `Turns`, or `Projection`.
 *
 * @since 1.0.0
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as HarnessError from "@smthrs/harness/HarnessError"
import { Context, type Effect, Schema } from "effect"
import type * as Protocol from "./Protocol.ts"

/**
 * What starts a turn: the session, the assistant message id that is also the
 * execution id, and the prompt.
 *
 * @category models
 * @since 1.0.0
 */
export interface StartInput {
  readonly sessionID: string
  readonly messageID: string
  /** The text the person sent. */
  readonly prompt: string
  /**
   * The conversation before this prompt, rendered for the model, when the
   * session already had turns. The driver carries it in the task; the
   * projection never shows it.
   */
  readonly history?: string | undefined
  readonly agent?: string | undefined
  readonly model?: Protocol.ModelRef | undefined
}

/**
 * How a turn's body ended when its stream did not say: interrupted by the
 * operator, failed with a cause, or parked on a permission.
 *
 * @category models
 * @since 1.0.0
 */
export type Outcome =
  | { readonly _tag: "completed" }
  | { readonly _tag: "interrupted" }
  | { readonly _tag: "suspended" }
  | {
    readonly _tag: "failed"
    readonly message: string
    readonly provider?: ProviderFailure | undefined
    readonly harness?: HarnessStop | undefined
  }

/**
 * The harness ending a run on one of its own codes: a cap it enforces, a
 * judgement it could not get, a claim it refused.
 *
 * It is carried beside {@link ProviderFailure} and not folded into it because
 * the two are different things to fix. A provider failure is the seat's, and
 * the operator fixes it at the provider. This one is the harness's, and what
 * the operator does about it is named by the code: raise the cap, mend the
 * gateway key, re-prompt with the missing part.
 *
 * Only the code travels. The sentence is already on the outcome's `message`,
 * verbatim, and the house rule is that the code is the contract and the
 * sentence is prose (`@smthrs/model/ModelError`, and `Health.limitReached`
 * restating it).
 *
 * @category models
 * @since 1.0.0
 */
export interface HarnessStop {
  /** The code the harness raised, off `HarnessError.code`. */
  readonly code: HarnessError.HarnessErrorCode
}

/**
 * A model call the seat's provider refused: what the person needs to fix
 * the seat, with the provider's own words untouched.
 *
 * @category models
 * @since 1.0.0
 */
export interface ProviderFailure {
  /** The seat the turn ran on, as `provider:model`. */
  readonly seat: string
  readonly providerID: string
  /** The normalized failure code: `authentication`, `quota_exceeded`, `rate_limited`, and the rest of `ModelErrorCode`. */
  readonly code: string
  readonly status?: number | undefined
  /** The provider's message, verbatim. */
  readonly message: string
}

/**
 * Where a running turn reports.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sink {
  /** One harness event, in stream order. Never fails: a projection error would fail the run. */
  readonly event: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
  /** The body's exit. Called once per drive; a resumed execution calls it again. */
  readonly closed: (outcome: Outcome) => Effect.Effect<void>
}

/**
 * A permission answer routed to the turn that asked.
 *
 * @category models
 * @since 1.0.0
 */
export interface PermissionInput {
  readonly sessionID: string
  readonly permissionID: string
  readonly response: Protocol.PermissionReply
}

/**
 * The failures a driver reports.
 *
 * @category errors
 * @since 1.0.0
 */
export class DriverError extends Schema.TaggedError<DriverError>()("@smthrs/opencode/DriverError", {
  code: Schema.Literals(["busy", "unknown_session", "unknown_permission", "engine_failed"]),
  message: Schema.String
}) {}

/**
 * What a driver does.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  /**
   * Runs one turn, delivering every event to the sink and the body's exit to
   * `sink.closed`. Returns when the turn settles or parks; the caller forks
   * it. Fails with `busy` when the session already has a running turn.
   */
  readonly start: (input: StartInput, sink: Sink) => Effect.Effect<void, DriverError>
  /** Interrupts the session's running turn. True when there was one. */
  readonly interrupt: (sessionID: string) => Effect.Effect<boolean>
  /**
   * Records a parked permission's answer and hands back the resume that
   * carries it into the turn: `once` and `always` resume the same execution,
   * `reject` resumes it with the call refused.
   *
   * The two halves are separate because the answer has to outlive the card.
   * The card comes down on the reply the caller publishes, and a caller that
   * published first lost the answer of anyone whose server stopped in
   * between and charged them a second one. So everything that makes the
   * answer durable happens before this returns, and the resume the caller
   * forks afterwards adds nothing the person would have to give again.
   */
  readonly permission: (input: PermissionInput) => Effect.Effect<Effect.Effect<void>, DriverError>
  /** Queues text for the session's running turn to drain at its next frame boundary. True when it was queued. */
  readonly steer: (sessionID: string, text: string) => Effect.Effect<boolean>
  /**
   * Re-drives every execution that was running or parked when the process
   * last stopped, opening a sink per session through `open`. A sink that
   * cannot be opened is a defect of the boot, not of the driver.
   */
  readonly resumeOnBoot: (
    open: (input: StartInput) => Effect.Effect<Sink, unknown>
  ) => Effect.Effect<void, DriverError>
}

/**
 * The driver service.
 *
 * @category services
 * @since 1.0.0
 */
export class Driver extends Context.Service<Driver, Service>()("@smthrs/opencode/Driver") {}
