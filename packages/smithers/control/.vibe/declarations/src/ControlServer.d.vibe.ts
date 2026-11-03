/**
 * RPC server layers for the control service.
 *
 * @since 0.1.0
 */
import { Cause, Context, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { RpcServer } from "effect/rpc";
import { Control } from "../../../src/Control.ts";
/**
 * Logs a content-free diagnostic for a failed RPC handler, and nothing for
 * a typed failure or an interruption. Causes may contain credentials or user
 * content, so neither their values nor their stacks enter the log.
 * Pass it to `Effect.tapCause` or `Stream.tapCause` around a handler.
 *
 * @category logging
 * @since 1.0.0
 */
export declare const logDefect: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
/**
 * The effective external scheme. A TLS host or trusted TLS-terminating proxy
 * supplies `https:`; a plain HTTP host supplies `http:`. When set, it decides
 * over the request URL's scheme, which is the socket's (Node) or the platform's
 * (web adapters) and is wrong behind a TLS-terminating proxy. Forwarding headers
 * are not trusted automatically. Without this service or an absolute URL,
 * browser origins fail closed.
 *
 * @category services
 * @since 1.0.0
 */
export declare const RequestScheme: Context.Reference<"http:" | "https:" | undefined>;
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
export declare const layer: Layer.Layer<import("effect/rpc/Rpc").Handler<"Approve"> | import("effect/rpc/Rpc").Handler<"Cancel"> | import("effect/rpc/Rpc").Handler<"Deny"> | import("effect/rpc/Rpc").Handler<"List"> | import("effect/rpc/Rpc").Handler<"Plan"> | import("effect/rpc/Rpc").Handler<"Resume"> | import("effect/rpc/Rpc").Handler<"Run"> | import("effect/rpc/Rpc").Handler<"Signal"> | import("effect/rpc/Rpc").Handler<"Steer"> | import("effect/rpc/Rpc").Handler<"Watch">, never, Control>;
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
export declare const layerHttp: Layer.Layer<RpcServer.Protocol, never, Control | import("./ControlRpcs.vibe").ControlAuth | HttpRouter.HttpRouter | import("effect/rpc/RpcSerialization").RpcSerialization>;
