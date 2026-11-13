/** Bun HTTP adapter for the same authenticated workspace gateway protocol.
 * @since 1.0.0
 */

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import type * as GatewayServer from "../GatewayServer.ts"
import { makeBunLayer } from "../internal/BunGateway.ts"
import * as NativeGateway from "../internal/NativeGateway.ts"

export { bearerPrincipal, scopedPrincipal } from "../internal/NativeGateway.ts"

/** TCP bind and existing gateway policy options supported by the Bun host.
 * @since 1.0.0
 * @category models
 */
export type ServerOptions = Pick<
  NativeGateway.ServerOptions,
  "host" | "port" | "allowedHosts" | "listen" | "credential" | "heartbeatMillis" | "maxRequestBodyBytes"
>

const native = makeBunLayer(BunHttpServer.layerServer)

/** Serves the existing HTTP/WebSocket gateway using Bun.serve in the caller's scope.
 * @since 1.0.0
 * @category layers
 */
export const layer = (health: GatewayServer.Health, options: ServerOptions = NativeGateway.defaultServerOptions) =>
  native(health, options)
