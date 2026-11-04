/**
 * The port a durable chat producer observes its journal callbacks through.
 *
 * A callback that never answers is a transport fault, and which phase it
 * stopped in — a request the dispatcher never took, a connection that never
 * came up, bytes the journal took and never answered — can only be read from
 * the runtime's own HTTP stack. That reading is platform-specific, so this
 * package declares the port and the host composition supplies the observer:
 * the Node model host passes `FetchTransport.observe` from
 * `@smthrs/platform-node`, which reads Node's `undici` diagnostics channels.
 * A producer given no observer adds no transport field it cannot stand behind.
 *
 * @since 1.0.0-rc.1
 */

import type { HostDiagnosticFields } from "./HostDiagnostics.vibe"

/**
 * One callback attempt as its observer saw it.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface CallbackAttempt {
  /** Runs one request so the observer attributes its records to this attempt. */
  readonly run: <A>(action: () => Promise<A>) => Promise<A>
  /** Closes the attempt and reports what it reached, as diagnostic fields. */
  readonly fields: () => HostDiagnosticFields
}

/**
 * Where a producer gets an attempt from.
 *
 * @category services
 * @since 1.0.0-rc.1
 */
export interface CallbackTransport {
  readonly begin: () => CallbackAttempt
}

/**
 * A transport observer bound to one turn, which stops observing when closed.
 *
 * @category services
 * @since 1.0.0-rc.1
 */
export interface ObservedCallbackTransport extends CallbackTransport {
  /**
   * The runtime build the observed callbacks go through, as short version
   * tokens; empty when the observer names none. A turn records it before its
   * first callback, so a stalled turn's log already says which build it ran.
   */
  readonly runtime: HostDiagnosticFields
  readonly close: () => void
}

/**
 * Opens an observer over one turn's callback origin. The host composition
 * supplies it; the Node model host passes `FetchTransport.observe` from
 * `@smthrs/platform-node`.
 *
 * @category services
 * @since 1.0.0
 */
export type CallbackTransportObserver = (callbackBaseUrl: string) => ObservedCallbackTransport

/**
 * A transport that observes nothing: the default, so a producer driven by a
 * caller's own fetch adds no transport fields it cannot stand behind.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const inertCallbackTransport: CallbackTransport = {
  begin: () => ({ run: (action) => action(), fields: () => ({}) })
}
