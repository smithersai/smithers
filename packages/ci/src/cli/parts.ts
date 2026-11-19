/**
 * The parts `smithers-ci` runs with, each imported from its own directory
 * through contract 10.
 *
 * @since 0.1.0
 */

import { split } from "../decompose/index.ts"
import { files } from "../generate/index.ts"
import { read, readHere } from "../inventory/index.ts"
import * as Native from "../native/index.ts"
import { run } from "../replay/index.ts"
import { html, text } from "../report/index.ts"
import { asked, rows, score } from "../select/index.ts"
import type { Parts } from "./Cli.vibe"
import type { Host } from "./Host.vibe"

/**
 * Every part, as the program calls them.
 *
 * @category parts
 * @since 0.1.0
 */
export const parts: Parts<Host> = {
  read,
  readHere,
  decompose: split,
  files,
  run: Native.run<Host>(run),
  text,
  html,
  rows,
  score,
  asked
}
