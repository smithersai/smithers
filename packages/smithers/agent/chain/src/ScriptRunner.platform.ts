/**
 * The host-realm script compiler behind the in-process interpreter.
 *
 * @since 0.1.0
 */

/**
 * Builds the factory that starts a script body. The factory's body is
 * `return (async () => {...})()`, so invoking it never throws synchronously:
 * every script error lands in the rejection.
 *
 * @since 0.1.0
 */
export const compileScript = (text: string): (
  ctx: unknown,
  done: unknown,
  to: unknown,
  park: unknown
) => unknown =>
  new Function(
    "ctx",
    "done",
    "to",
    "park",
    `"use strict"\nreturn (async () => {\n${text}\n})()`
  ) as (ctx: unknown, done: unknown, to: unknown, park: unknown) => unknown
