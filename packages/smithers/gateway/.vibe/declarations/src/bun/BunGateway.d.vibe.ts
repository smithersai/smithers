/** Bun HTTP adapter for the same authenticated workspace gateway protocol.
 * @since 1.0.0
 */
import { Layer } from "effect";
import type { HttpServer } from "effect/http/HttpServer";
import { GatewayError } from "../../../../src/GatewayError.ts";
import type * as GatewayServer from "../../../../src/GatewayServer.ts";
import * as NativeGateway from "../internal/NativeGateway.vibe";
export { bearerPrincipal, scopedPrincipal } from "../internal/NativeGateway.vibe";
/** TCP bind and existing gateway policy options supported by the Bun host.
 * @since 1.0.0
 * @category models
 */
export type ServerOptions = Pick<NativeGateway.ServerOptions, "host" | "port" | "allowedHosts" | "listen" | "credential" | "heartbeatMillis" | "maxRequestBodyBytes">;
/** Serves the existing HTTP/WebSocket gateway using Bun.serve in the caller's scope.
 * @since 1.0.0
 * @category layers
 */
export declare const layer: (health: GatewayServer.Health, options?: ServerOptions) => Layer.Layer<HttpServer, GatewayError | import("@smthrs/sync/SyncError").SyncError, import("@smthrs/control/Control").Control | import("../../../../src/Projections.ts").Projections | import("@smthrs/sync/SyncRpcs").SyncAuth | import("@smthrs/sync/SyncServer").SyncServer>;
