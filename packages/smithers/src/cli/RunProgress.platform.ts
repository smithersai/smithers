/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import type { Writable } from "node:stream"
import { stripVTControlCharacters } from "node:util"

/**
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const stripControl = (value: string): string => stripVTControlCharacters(value)

/**
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const stderr = (): Writable => process.stderr

/**
 * The process environment and whether each standard stream is a terminal.
 *
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const terminal = () => ({
  env: process.env,
  stdin: process.stdin.isTTY === true,
  stdout: process.stdout.isTTY === true,
  stderr: process.stderr.isTTY === true
})
