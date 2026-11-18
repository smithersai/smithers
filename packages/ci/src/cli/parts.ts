/**
 * The parts `smithers-ci` runs with, each imported from its own directory
 * through contract 10. A part that has not landed yet comes from
 * `Waiting.vibe` and fails with `unsupported`.
 *
 * @since 0.1.0
 */

import type { NodeHost } from "@smthrs/platform-node"
import { files } from "../generate/index.ts"
import { read } from "../inventory/index.ts"
import { html, text } from "../report/index.ts"
import type { Parts } from "./Cli.vibe"
import { rows, run, score } from "./Waiting.vibe"

/**
 * Every part, as the program calls them.
 *
 * @category parts
 * @since 0.1.0
 */
export const parts: Parts<NodeHost.NodeHost> = { read, files, run, text, html, rows, score }
