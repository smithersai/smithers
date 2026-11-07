/** Node HTTP adapter for the shared native gateway policy and protocol.
 * @since 1.0.0
 */
import * as NativeGateway from "../internal/NativeGateway.vibe";
export { bearerPrincipal, bindRefusal, defaultServerOptions, ingressOptions, isLoopbackHost, layerAuth, listenOptions, scopedPrincipal, scopedTokenPaths } from "../internal/NativeGateway.vibe";
/** Node socket and shared gateway policy options.
 * @since 1.0.0
 * @category models
 */
export type ServerOptions = NativeGateway.ServerOptions;
export { layer } from "../../../../src/node/NodeGateway.platform.ts";
