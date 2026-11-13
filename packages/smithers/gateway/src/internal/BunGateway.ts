/**
 * Maps the Bun server's startup failures through the shared gateway policy.
 *
 * @since 0.1.0
 */

import { Cause, Effect, Layer } from "effect"
import type { HttpServer } from "effect/http/HttpServer"
import type { ServeError } from "effect/http/HttpServerError"
import { GatewayError } from "../GatewayError.ts"
import * as NativeGateway from "./NativeGateway.ts"

/**
 * Supplies a server layer at the Bun host boundary.
 *
 * @private
 * @since 0.1.0
 */
export const makeBunLayer = (
  server: (options: { readonly hostname: string; readonly port: number }) => Layer.Layer<HttpServer, ServeError>
) =>
  NativeGateway.makeLayer((options) =>
    server({
      // Shared listenOptions has already supplied and admitted the bind host.
      hostname: options.host!,
      port: options.port!
    }).pipe(Layer.catchCause((cause): Layer.Layer<HttpServer, ServeError | GatewayError> => {
      const failure = Cause.squash(cause)
      const code = typeof failure === "object" && failure !== null && "code" in failure ? failure.code : undefined
      if (Cause.hasInterruptsOnly(cause) || !["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"].includes(String(code))) {
        return Layer.effectContext<HttpServer, ServeError | GatewayError, never>(Effect.failCause(cause))
      }
      // The errno is safe to keep: NativeGateway logs it for the operator and
      // strips it from the refusal every bearer holder sees.
      return Layer.effectContext<HttpServer, ServeError | GatewayError, never>(Effect.fail(
        new GatewayError({
          code: "bind_failed",
          message: "The gateway socket could not be bound",
          cause: { _tag: "BunServeError", code: String(code) }
        })
      ))
    }))
  )
