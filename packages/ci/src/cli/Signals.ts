/**
 * What `smithers-ci` hears of its process: the signals that ask it to stop,
 * the errors nothing caught, and the moment nothing is left that could wake
 * it.
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
 * What Node emits when nothing is left that could wake the program: no
 * process it waits for, no timer, no open file. A program that still waits
 * for an answer then will never get one, and Node would end it with an exit
 * code of Node's own and no line.
 *
 * @category constants
 * @since 0.1.0
 */
export const idle = "beforeExit"

/**
 * What Node emits for an error nothing caught: one thrown outside every
 * part of the program, and a promise that failed with nobody waiting. The
 * listener is given the error.
 *
 * @category constants
 * @since 0.1.0
 */
export const uncaught = ["uncaughtException", "unhandledRejection"] as const

/**
 * What the program listens for.
 *
 * @category models
 * @since 0.1.0
 */
export type Heard = Signal | typeof idle | typeof uncaught[number]

/**
 * Calls `listener` the first time `event` comes, with what came with it. The
 * function it returns stops listening.
 *
 * @category models
 * @since 0.1.0
 */
export type Listen = (event: Heard, listener: (...given: ReadonlyArray<unknown>) => void) => () => void

/**
 * Hears what `source` emits; the executable passes its `process`. After the
 * first signal the listener is gone, so a second one ends the process at
 * once, as it does a program that listens to nothing.
 *
 * @throws {never}
 * @category constructors
 * @since 0.1.0
 */
export const listenTo = (source: Pick<EventEmitter, "once" | "removeListener">): Listen => (event, listener) => {
  source.once(event, listener)
  return () => void source.removeListener(event, listener)
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
