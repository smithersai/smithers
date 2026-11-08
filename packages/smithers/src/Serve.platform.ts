/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import type * as GatewayServer from "@smthrs/gateway/GatewayServer"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { packageVersion } from "./Version.ts"

/**
 * The workspace this gateway belongs to, as a stable short hash of its root.
 * A supervisor that finds a gateway on a port asks `/health` whether it is
 * this workspace's before deciding to keep or replace it, so the answer has to
 * be derived from the workspace and from nothing else. The path itself is not
 * published: it names directories on the operator's machine.
 *
 * @private
 * @since 1.0.0
 */
export const workspaceHash = (root: string): string =>
  createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16)
/**
 * The identity `GET /health` answers with.
 *
 * @private
 * @since 1.0.0
 */
export const health = (root: string): GatewayServer.Health => ({
  workspaceHash: workspaceHash(root),
  gatewayId: `cli-${process.pid}`,
  protocolVersion: "1",
  version: packageVersion
})
