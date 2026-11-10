/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0-rc.0
 */

import type { Writable } from "node:stream"
import { Writable as WritableStream } from "node:stream"
import { stripVTControlCharacters } from "node:util"

/**
 * @private
 * @since 1.0.0-rc.0
 * @throws {never}
 */
export const stripControl = (line: string): string => stripVTControlCharacters(line)

/**
 * A stream that hands every chunk written to it to `onChunk`.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const memorySink = (onChunk: (chunk: string) => void): Writable =>
  new WritableStream({
    write(chunk, _encoding, callback) {
      onChunk(String(chunk))
      callback()
    }
  })

/**
 * @private
 * @since 1.0.0-rc.0
 * @throws {never}
 */
export const stdout = (): typeof process.stdout => process.stdout

/**
 * @private
 * @since 1.0.0-rc.0
 * @throws {never}
 */
export const stderr = (): Writable => process.stderr

/**
 * @private
 * @since 1.0.0-rc.0
 * @throws {never}
 */
export const stdin = (): typeof process.stdin => process.stdin

/**
 * @private
 * @since 1.0.0-rc.0
 * @throws {never}
 */
export const environment = (): NodeJS.ProcessEnv => process.env

/**
 * @private
 * @since 1.0.0
 */
export type Timer = ReturnType<typeof setTimeout>

/**
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const setTimer = (callback: () => void, milliseconds: number): Timer => setTimeout(callback, milliseconds)

/**
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const clearTimer = (timer: Timer | undefined): void => clearTimeout(timer)
