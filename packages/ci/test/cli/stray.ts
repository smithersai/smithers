/** An error thrown where no part of the program can catch it. */

/**
 * Throws an error with `message` from a timer, after the caller has gone on.
 *
 * @throws {never}
 */
export const throwLater = (message: string): void => {
  setTimeout(() => {
    throw new Error(message)
  }, 0)
}
