/**
 * The parts `smithers-ci` runs with, each imported from its own directory
 * through contract 10. A part that has not landed yet comes from
 * `Waiting.vibe` and fails with `unsupported`.
 *
 * @since 0.1.0
 */

import { files } from "../generate/index.ts"
import { read } from "../inventory/index.ts"
import { html, text } from "../report/index.ts"
import { rows, score } from "../select/index.ts"
import type { Parts } from "./Cli.vibe"
import type { Host } from "./Host.vibe"
import { run } from "./Waiting.vibe"

/**
 * Every part, as the program calls them.
 *
 * @category parts
 * @since 0.1.0
 */
export const parts: Parts<Host> = { read, files, run, text, html, rows, score }
