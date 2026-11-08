/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import type { Ownership } from "@smthrs/run-store"
import { hostname } from "node:os"

/**
 * @private
 * @since 1.0.0
 */
export const observer: Ownership.OwnerId = { hostId: hostname(), pid: process.pid, nonce: "cli-log-observer" }
