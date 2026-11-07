/** Node HTTP adapter for the shared native gateway policy and protocol.
 * @since 1.0.0
 */

// The platform code of NodeGateway.vibe, which a .vibe file does not import as a value (EK4402).

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { createServer } from "node:http"
import * as NativeGateway from "../internal/NativeGateway.vibe"

/** Hosts the existing workspace gateway on Node's scoped HTTP server.
 * @since 1.0.0
 * @category layers
 */
export const layer = NativeGateway.makeLayer((options) => NodeHttpServer.layer(createServer, options))
