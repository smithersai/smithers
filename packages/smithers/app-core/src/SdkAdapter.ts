/**
 * The catalog as an SDK: an Effect service, and a Promise and `AsyncIterable`
 * facade over it for plain JavaScript.
 *
 * `call` takes any tag in the catalog, so a new flow needs no new method. The
 * principal is always a flow: the run whose credential the SDK was given.
 *
 * @since 1.0.0
 */

import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as Core from "./Core.ts"
import type * as Principal from "./Principal.ts"

/**
 * The SDK over one run's credential.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sdk {
  /** Every entry a flow may call or read. */
  readonly catalog: Effect.Effect<ReadonlyArray<Core.Entry>, Core.CoreError>
  /** Runs a flow, or reads a query, by tag. */
  readonly call: (tag: string, payload?: unknown) => Effect.Effect<Core.Requested | Core.Page, Core.CoreError>
  readonly read: (query: string, params?: unknown) => Effect.Effect<Core.Page, Core.CoreError>
  readonly changes: (query: string, after: string, params?: unknown) => Stream.Stream<Core.Change, Core.CoreError>
}

/**
 * The SDK service.
 *
 * @category services
 * @since 1.0.0
 */
export class SmithersSdk extends Context.Service<SmithersSdk, Sdk>()("@smthrs/app-core/SmithersSdk") {}

/**
 * Builds the SDK for one run.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: {
  readonly engine: Core.Engine
  readonly evidence: Principal.SdkEvidence
}): Effect.Effect<Sdk, Principal.AuthRefused> =>
  Effect.map(options.engine.openSdk(options.evidence), (core): Sdk => ({
    catalog: Effect.map(Core.entries(core), (all) => all.filter(Core.delegable)),
    call: (tag, payload) => Core.call(core, tag, payload),
    read: (query, params) => core.read({ query, params }),
    changes: (query, after, params) => core.changes({ query, params }, after)
  }))

/**
 * The SDK service for one run.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: {
  readonly engine: Core.Engine
  readonly evidence: Principal.SdkEvidence
}): Layer.Layer<SmithersSdk, Principal.AuthRefused> => Layer.effect(SmithersSdk, make(options))

/**
 * The SDK for code that does not use Effect. A refusal rejects with the
 * `CoreError` itself.
 *
 * @category models
 * @since 1.0.0
 */
export interface Promises {
  readonly catalog: () => Promise<ReadonlyArray<Core.Entry>>
  readonly call: (tag: string, payload?: unknown) => Promise<Core.Requested | Core.Page>
  readonly read: (query: string, params?: unknown) => Promise<Core.Page>
  readonly changes: (query: string, after: string, params?: unknown) => AsyncIterable<Core.Change>
}

const settle = async <A>(effect: Effect.Effect<A, Core.CoreError>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

/**
 * The Promise and `AsyncIterable` facade over an SDK.
 *
 * @category constructors
 * @since 1.0.0
 */
export const promises = (sdk: Sdk): Promises => ({
  catalog: () => settle(sdk.catalog),
  call: (tag, payload) => settle(sdk.call(tag, payload)),
  read: (query, params) => settle(sdk.read(query, params)),
  changes: (query, after, params) => Stream.toAsyncIterable(sdk.changes(query, after, params))
})
