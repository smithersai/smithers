/**
 * Sends an execution whose placement the `Hosts` table binds to another
 * engine through that engine's served `FlowProxy` group.
 *
 * It sits inside the engine, not around it: a flow body reaches its children
 * through the `FlowRuntime` the driver provides, which is the engine itself,
 * so a decorator composed outside the engine would never see a `.child()`.
 *
 * @since 1.0.0
 */

import type * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { RpcClientError } from "effect/rpc/RpcClientError"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import * as FlowProxy from "../FlowProxy.ts"
import { type Binding, Hosts } from "../Hosts.ts"
import { requestedAuthority } from "./Authority.ts"

/**
 * A binding to another engine.
 *
 * @category models
 * @since 1.0.0
 */
export type Proxy = Extract<Binding, { readonly _tag: "Proxy" }>

/** The binding the table gives `flow`'s placement annotation. */
const bindingOf = (flow: Flow.Any): Effect.Effect<Binding> =>
  Effect.map(
    Hosts,
    (hosts) => hosts.resolve(Option.getOrUndefined(Context.getOption(flow.annotations, Flow.Placement)))
  )

/**
 * Whether the transport lost the call: a connection that failed or reset, not
 * a remote answer the client could not read, such as a refused bearer.
 */
const isTransport = (error: unknown): boolean =>
  error instanceof RpcClientError &&
  (error.reason._tag === "HttpError" ? error.reason.kind === "TransportError" : error.reason._tag.startsWith("Socket"))

/**
 * How long a caller keeps asking a remote engine that its transport lost: a
 * reset tunnel or an idle-timed-out connection mid-child. Each ask is under
 * the same id, so the remote engine joins the run it already has or answers
 * the result it recorded. About six minutes before the caller gives up.
 */
const transportRetry = Schedule.max([
  Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("1 minute")]),
  Schedule.recurs(12)
])

/**
 * Asks `ask` again while the transport loses it, for {@link transportRetry}.
 * Safe only for a request whose second ask under one id has the effect of
 * the first.
 */
const retryTransport = <A, E, R>(ask: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.retry(ask, { while: isTransport, schedule: transportRetry })

/** An RPC client for one flow's `FlowProxy` group, by operation address. */
type Client = Record<string, (request: object) => Effect.Effect<any, any>>

/**
 * Runs `use` against an RPC client for `flow`'s group. A transport failure
 * that outlives the caller's retries is a defect of this execution.
 */
const remote = <A, E>(
  binding: Proxy,
  flow: Flow.Any,
  use: (client: Client, operation: FlowProxy.OperationAddresses) => Effect.Effect<A, E, Scope.Scope>
): Effect.Effect<A, E> =>
  Effect.scoped(
    Effect.flatMap(
      binding.connect(FlowProxy.toRpcGroup([flow]) as never),
      (client) => use(client as never, FlowProxy.operationAddresses(flow._tag))
    )
  ).pipe(
    // Every client failure the retry did not absorb is a defect of this
    // execution: none of them is an answer the flow declared.
    Effect.catchIf((error): error is never => error instanceof RpcClientError, (error) => Effect.die(error))
  )

/** Asks the remote engine to cancel a run: best effort, bounded, and logged when it fails. */
const cancelRemote = (
  client: Client,
  operation: FlowProxy.OperationAddresses,
  flow: Flow.Any,
  executionId: string,
  capabilityCeilings: CapabilitySet.CapabilitySet["groups"]
) =>
  client[operation.interrupt]!({ executionId, capabilityCeilings }).pipe(
    Effect.interruptible,
    Effect.timeout("5 seconds"),
    Effect.ignore({ log: "Warn" }),
    Effect.annotateLogs({ flow: flow._tag, executionId })
  )

/**
 * Forwards the parent's cancellation to the remote run when the call's scope
 * closes on an interrupted parent: the remote engine has no lineage edge to
 * carry it.
 */
const forwardCancellation = (
  client: Client,
  operation: FlowProxy.OperationAddresses,
  flow: Flow.Any,
  executionId: string,
  capabilityCeilings: CapabilitySet.CapabilitySet["groups"],
  settlement: { completed: boolean }
) =>
  Effect.flatMap(Effect.serviceOption(FlowRuntime.FlowInstance), (parent) => {
    if (Option.isNone(parent)) return Effect.void
    return Effect.addFinalizer(() =>
      parent.value.interrupted && !settlement.completed
        ? cancelRemote(client, operation, flow, executionId, capabilityCeilings)
        : Effect.void
    )
  })

/**
 * Runs `flow` on the binding's engine under `request.executionId` and answers
 * its result, or the id for a discard, which answers nothing on the wire.
 *
 * A lost transport is asked again under the same id, so the remote engine
 * joins the run it has or answers the result it recorded. A parent
 * interrupted while the remote run goes on forwards the cancellation, because
 * the remote engine has no lineage edge to carry it; the forward is best
 * effort, bounded, and logged when it fails.
 *
 * @category constructors
 * @since 1.0.0
 */
export const callRemote = (
  binding: Proxy,
  flow: Flow.Any,
  request: { readonly executionId: string; readonly payload: unknown; readonly discard?: boolean | undefined }
): Effect.Effect<unknown, unknown> =>
  remote(binding, flow, (client, operation) =>
    Effect.gen(function*() {
      const capabilityCeilings = yield* requestedAuthority(flow)
      const settlement = { completed: false }
      yield* forwardCancellation(client, operation, flow, request.executionId, capabilityCeilings, settlement)
      const wire = { payload: request.payload, executionId: request.executionId, capabilityCeilings }
      const ask = request.discard === true
        ? Effect.as(client[operation.discard]!(wire), request.executionId)
        : client[operation.execute]!(wire)
      return yield* retryTransport(ask).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            settlement.completed = request.discard !== true
          })
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (!(error instanceof RpcClientError)) settlement.completed = true
          })
        )
      )
    }))

/**
 * `execute` for a placed flow: `inner` when it runs here; otherwise
 * {@link callRemote} under the caller's execution id.
 *
 * @category constructors
 * @since 1.0.0
 */
export const placeExecute = <Execute extends FlowRuntime.FlowRuntime["Service"]["execute"]>(inner: Execute): Execute =>
  ((flow: Flow.Any, options: { readonly executionId: string; readonly payload: unknown; readonly discard?: boolean }) =>
    Effect.flatMap(bindingOf(flow), (binding) =>
      binding._tag === "Here"
        ? inner(flow as never, options as never)
        : callRemote(binding, flow, options))) as never

/** Asks the binding's engine to resume a run, under the caller's authority. */
const resumeRemote = (
  binding: Proxy,
  flow: Flow.Any,
  executionId: string,
  options: FlowRuntime.ResumeOptions | undefined
) =>
  remote(binding, flow, (client, operation) =>
    Effect.flatMap(requestedAuthority(flow), (capabilityCeilings) => {
      const request = {
        executionId,
        capabilityCeilings,
        ...(options?.poll === undefined ? {} : { poll: options.poll })
      }
      return Effect.orDie(retryTransport(client[operation.resume]!(request)))
    }))

/**
 * `resume` for a placed flow: here, or the remote engine's resume. A lost
 * transport is asked again as {@link callRemote} asks, because a second
 * resume of one id re-drives the run the first one did.
 *
 * @category constructors
 * @since 1.0.0
 */
export const placeResume = (
  inner: FlowRuntime.FlowRuntime["Service"]["resume"]
): FlowRuntime.FlowRuntime["Service"]["resume"] =>
(flow, executionId, options) =>
  Effect.flatMap(bindingOf(flow), (binding) => {
    if (binding._tag === "Here") return inner(flow, executionId, options)
    // The remote resume API is the operator's own request. Forwarding a
    // delegated resume through it would promote it to recovery consent.
    if (options?.delegated === true) {
      return Effect.die(new Error(`A delegated resume of ${flow._tag} cannot cross a remote placement`))
    }
    return resumeRemote(binding, flow, executionId, options)
  })

/** Asks the binding's engine to cancel a run, under the caller's authority. */
const interruptRemote = (binding: Proxy, flow: Flow.Any, executionId: string) =>
  remote(binding, flow, (client, operation) =>
    Effect.flatMap(
      requestedAuthority(flow),
      (capabilityCeilings) => retryTransport(client[operation.interrupt]!({ executionId, capabilityCeilings }))
    ))

/**
 * `interrupt` for a placed flow: here, or the remote engine's interrupt. A
 * lost transport is asked again as {@link callRemote} asks, because a second
 * cancellation request of one id changes nothing the first did not.
 *
 * @category constructors
 * @since 1.0.0
 */
export const placeInterrupt = (
  inner: FlowRuntime.FlowRuntime["Service"]["interrupt"]
): FlowRuntime.FlowRuntime["Service"]["interrupt"] =>
(flow, executionId) =>
  Effect.flatMap(
    bindingOf(flow),
    (binding) => binding._tag === "Here" ? inner(flow, executionId) : interruptRemote(binding, flow, executionId)
  )

/**
 * `retryFrom` for a placed flow: `inner` when it runs here. A flow bound to
 * another engine is refused `unsupported`: a retry seeds the engine that holds
 * the source's history, and no remote operation carries that request.
 * @category constructors
 * @since 1.0.0
 */
export const placeRetryFrom = (
  inner: NonNullable<FlowRuntime.FlowRuntime["Service"]["retryFrom"]>
): NonNullable<FlowRuntime.FlowRuntime["Service"]["retryFrom"]> =>
(flow, options) =>
  Effect.flatMap(
    bindingOf(flow),
    (binding) =>
      binding._tag === "Here"
        ? inner(flow, options)
        : Effect.fail(
          new FlowRuntime.RetryFromRefused({ code: "unsupported", executionId: options.source, step: options.step })
        )
  )
