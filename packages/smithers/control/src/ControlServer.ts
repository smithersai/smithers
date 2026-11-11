/**
 * RPC server layers for the control service.
 *
 * @since 0.1.0
 */

import { Cause, Context, Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { RpcServer } from "effect/rpc"
import { Control } from "./Control.ts"
import { Unauthorized } from "./ControlError.ts"
import { ControlPrincipal, ControlRpcs, RunVisibility } from "./ControlRpcs.ts"
import type { Principal } from "./ControlSchema.ts"

/**
 * Logs a content-free diagnostic for a failed RPC handler, and nothing for
 * a typed failure or an interruption. Causes may contain credentials or user
 * content, so neither their values nor their stacks enter the log.
 * Pass it to `Effect.tapCause` or `Stream.tapCause` around a handler.
 *
 * @category logging
 * @since 1.0.0
 */
export const logDefect = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Cause.hasDies(cause) ? Effect.logError("A control RPC handler died") : Effect.void

/**
 * The authoritative external scheme, including behind a TLS-terminating host.
 * A TLS host or trusted TLS-terminating proxy supplies `https:`; a plain HTTP
 * host supplies `http:`. Forwarding headers are not trusted automatically.
 * Without an absolute URL or this service, browser origins fail closed.
 *
 * @category services
 * @since 1.0.0
 */
export const RequestScheme = Context.Reference<"http:" | "https:" | undefined>(
  "/control/RequestScheme",
  { defaultValue: () => undefined }
)

const logged = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.tapCause(effect, logDefect)

// A loopback listener without its session token authenticates every caller as
// `loopback`/`anonymous`, so any local process, an agent's own shell included,
// arrives as that principal. It reads and drives runs; it decides nothing a
// person must decide (#1783, #4928).
const operatorOnly = (principal: Principal): Effect.Effect<void, Unauthorized> =>
  principal.id === "loopback" && principal.kind === "anonymous"
    ? Effect.fail(new Unauthorized({ message: "An operator credential is required" }))
    : Effect.void

/**
 * Control RPC handlers delegating to the transport-independent service.
 *
 * Every mutation that records who asked reads `ControlPrincipal` and stamps
 * it, rather than forwarding whatever the client sent. The identity the
 * middleware authenticated is the only one the server can stand behind, and it
 * is what reaches the journal, `RunSummary.cancellation`, and a steer's
 * notification provenance.
 *
 * `List`, `Watch` and every run mutation read it too: a principal
 * `ControlRpcs.RunVisibility` does not make an operator reads and mutates only
 * the runs it launched; any other run answers `RunNotFound`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = ControlRpcs.toLayer(
  Effect.gen(function*() {
    const control = yield* Control
    // A reader that is not an operator is restricted to the runs its own
    // principal launched. `reader` is not on the wire, so only this stamp sets
    // it. The authentication middleware provides the rule with the principal.
    const reader = Effect.gen(function*() {
      const principal = yield* ControlPrincipal
      const visibility = yield* RunVisibility
      return visibility.seesAllRuns(principal) ? {} : { reader: principal }
    })
    return ControlRpcs.of({
      Plan: Effect.fn("Control.plan")((input) => control.plan(input), logged),
      Run: Effect.fn("Control.run")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.run({ ...input, principal, ...yield* reader })
        }), logged),
      Approve: Effect.fn("Control.approve")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          yield* operatorOnly(principal)
          return yield* control.approve({ ...input, principal })
        }), logged),
      Deny: Effect.fn("Control.deny")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          yield* operatorOnly(principal)
          return yield* control.deny({ ...input, principal })
        }), logged),
      Steer: Effect.fn("Control.steer")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          // A steer carries a principal on the wire because an in-process
          // caller names one that is not an operator: `agent/send` attributes
          // a child's steer to the parent flow. A remote client may not, so
          // the authenticated identity replaces whatever arrived. It reaches
          // the notification's `sourceActor` and the run transcript, which is
          // exactly where a spoofed name would be read as truth.
          const { attribution: _attribution, ...message } = input.message
          return yield* control.steer({ ...input, message: { ...message, principal }, ...yield* reader })
        }), logged),
      Signal: Effect.fn("Control.signal")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          // A signal may answer a person's question: `HumanTask` parks on a
          // wait a signal of its name completes, and an answer is a person's
          // decision exactly as an approval is. Admission cannot tell which
          // signal will answer one, because an admitted signal is replayed
          // into whichever wait opens under its name later, so every signal
          // needs the credential an approval needs.
          yield* operatorOnly(principal)
          return yield* control.signal({ ...input, principal, ...yield* reader })
        }), logged),
      Cancel: Effect.fn("Control.cancel")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.cancel({ ...input, principal, ...yield* reader })
        }), logged),
      Resume: Effect.fn("Control.resume")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.resume({ ...input, principal, ...yield* reader })
        }), logged),
      List: Effect.fn("Control.list")(
        (input) => Effect.flatMap(reader, (restriction) => control.list({ ...input, ...restriction })),
        logged
      ),
      Watch: (input) =>
        Stream.tapCause(
          Stream.unwrap(Effect.map(reader, (restriction) => control.watch({ ...input, ...restriction }))),
          logDefect
        )
    })
  })
)

/**
 * Whether a request's `Origin` may reach the control mounts.
 *
 * Non-browser clients send no `Origin`. A browser always sends one, on POST
 * and on the WebSocket upgrade, and a cross-site page cannot forge it. Refusing
 * any `Origin` whose scheme or authority differs from the endpoint stops a page on another site
 * from riding a credential that a proxy or cookie attaches on the victim's
 * behalf (cross-site WebSocket hijacking of the `Watch` stream).
 */
const sameOrigin = (
  request: HttpServerRequest.HttpServerRequest,
  scheme: "http:" | "https:" | undefined
): boolean => {
  const headers = request.headers
  const origin = headers.origin
  if (origin === undefined) return true
  const host = headers.host
  const parsed = URL.parse(origin)
  // Effect 4.1 Node adapters retain an absolute transport URL too. A host
  // behind TLS termination explicitly supplies its external scheme; that
  // configuration takes precedence over the internal connection URL.
  const protocol = scheme ?? URL.parse(request.originalUrl)?.protocol
  return host !== undefined && parsed !== null &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.protocol === protocol && parsed.origin === origin && parsed.host === host.toLowerCase()
}

/**
 * Route middleware on the two control mounts only, so the router's own path
 * matching decides what it guards, and a host's stricter global policy (the
 * gateway's ingress) still answers first with its own typed refusal.
 */
const originGuard = Layer.unwrap(
  Effect.map(RequestScheme, (scheme) =>
    HttpRouter.middleware((httpEffect) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (sameOrigin(request, scheme)) return yield* httpEffect
        return HttpServerResponse.text("The browser Origin must match the control server scheme and Host", {
          status: 403
        })
      })
    ).layer)
)

const server = RpcServer.layer(ControlRpcs, {
  disableFatalDefects: true
})

const http = server.pipe(
  Layer.provide(layer),
  Layer.provideMerge(RpcServer.layerProtocolHttp({ path: "/rpc" }).pipe(Layer.provide(originGuard))),
  Layer.fresh
)

const websocket = server.pipe(
  Layer.provide(layer),
  Layer.provideMerge(RpcServer.layerProtocolWebsocket({ path: "/rpc/ws" }).pipe(Layer.provide(originGuard))),
  Layer.fresh
)

/**
 * Mounts control RPC on the ambient `HttpRouter`: unary procedures over POST
 * `/rpc` and the `watch` stream over WebSocket `/rpc/ws`. Both protocols are
 * mounted together because `ControlClient` projects the same `Control` vtable
 * across the two transports.
 *
 * A request carrying a browser `Origin` that does not match its scheme and `Host` is
 * refused with 403 before authentication, so a page on another site cannot
 * open the socket or post to `/rpc` with a credential a proxy attaches.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHttp = Layer.mergeAll(
  http,
  websocket
)
