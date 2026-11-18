/**
 * The signals that ask `smithers-ci` to stop, and how it hears them.
 *
 * @since 0.1.0
 */

import type { EventEmitter } from "node:events"

/**
 * Each signal the program stops for, with the exit code a shell reports for
 * a program that signal ended: 128 plus the signal's number.
 *
 * @category constants
 * @since 0.1.0
 */
export const exitCodes = { SIGINT: 130, SIGTERM: 143 } as const

/**
 * A signal the program stops for.
 *
 * @category models
 * @since 0.1.0
 */
export type Signal = keyof typeof exitCodes

/**
 * Calls `listener` the first time `signal` arrives. The function it returns
 * stops listening.
 *
 * @category models
 * @since 0.1.0
 */
export type Listen = (signal: Signal, listener: () => void) => () => void

/**
 * Hears the signals `source` emits; the executable passes its `process`.
 * After the first signal the listener is gone, so a second one ends the
 * process at once, as it does a program that listens to nothing.
 *
 * @throws {never}
 * @category constructors
 * @since 0.1.0
 */
export const listenTo = (source: Pick<EventEmitter, "once" | "removeListener">): Listen => (signal, listener) => {
  source.once(signal, listener)
  return () => void source.removeListener(signal, listener)
}

/**
 * Hears nothing: for a program run inside another process, which owns its
 * signals.
 *
 * @throws {never}
 * @category constructors
 * @since 0.1.0
 */
export const deaf: Listen = () => () => undefined
