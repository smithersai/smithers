/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import type { Ownership } from "@smthrs/run-store"
import { hostname } from "node:os"

/**
 * Whether a listing should say a run is waiting for an executor.
 * This is a rendering heuristic over the listing's own fields, not a durable
 * verdict: the durable one is the `control.run.pending` event the status card
 * reads from the run's journal. For a same-host owner it uses the same
 * fail-closed PID probe as run recovery. A foreign-host owner cannot be
 * inspected and is never declared absent here.
 *
 * @private
 * @since 1.0.0
 */
export const statusObserver: Ownership.OwnerId = Object.freeze({
  hostId: hostname(),
  pid: process.pid,
  nonce: "cli-status-observer"
})
