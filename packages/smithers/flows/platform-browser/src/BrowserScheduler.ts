/**
 * Effect's fiber scheduler for a browser tab or worker.
 *
 * Effect's default scheduler hands queued fiber work to the event loop with
 * `setImmediate` where the global has one (Node, Bun) and with
 * `setTimeout(f, 0)` where it has not, as in every browser. A browser holds a
 * `setTimeout` nested more than five deep to at least 4 ms (the HTML
 * standard's timer nesting rule), and fiber work that resumes fiber work
 * nests: each statement a durable engine runs on its one SQLite connection
 * resumes the fiber waiting for the next. A browser engine that registers 500
 * flows waited out about 900 ms of those 4 ms holds on a cold start while its
 * worker sat idle.
 *
 * {@link make} gives the same scheduler, `MixedScheduler`, with a message on
 * a `MessageChannel` in place of the timer: a task the event loop runs at
 * once, as React's scheduler and `setImmediate` polyfills do, never clamped.
 * Where the global has `setImmediate` it keeps Effect's default.
 *
 * ```ts
 * import { BrowserScheduler } from "@smthrs/platform-browser"
 *
 * Effect.runFork(program, { scheduler: BrowserScheduler.make() })
 * ```
 *
 * `BrowserRuntime.run` and `BrowserLanguageServer.serve` run their workers'
 * programs on it.
 *
 * @since 1.0.0
 */

import * as Scheduler from "effect/Scheduler"

/**
 * The slice of `MessageChannel` {@link immediate} uses: a port that hears
 * what the other posts.
 *
 * @category models
 * @since 1.0.0
 */
export interface ChannelLike {
  readonly port1: { onmessage: ((event: unknown) => void) | null }
  readonly port2: { postMessage(message: unknown): void }
}

/**
 * What {@link make} reads off the global: `setImmediate`, whose presence keeps
 * Effect's default, and the `MessageChannel` constructor.
 *
 * @category models
 * @since 1.0.0
 */
export interface Environment {
  readonly setImmediate?: unknown
  readonly MessageChannel?: (new() => ChannelLike) | undefined
}

/**
 * A `setImmediate` over `channel`: each task is one message, run in the order
 * posted, and the function it returns cancels it before it runs. It takes
 * `channel`'s first port's `onmessage`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const immediate = (channel: ChannelLike): (task: () => void) => () => void => {
  const queue: Array<{ readonly run: () => void; cancelled: boolean }> = []
  channel.port1.onmessage = () => {
    const next = queue.shift()
    if (next !== undefined && !next.cancelled) next.run()
  }
  return (run) => {
    const task = { run, cancelled: false }
    queue.push(task)
    channel.port2.postMessage(undefined)
    return () => {
      task.cancelled = true
    }
  }
}

/**
 * The scheduler for a program in `environment`, the global by default:
 * Effect's `MixedScheduler` dispatching over a `MessageChannel` of its own
 * ({@link immediate}), or Effect's default `MixedScheduler` where the
 * environment has `setImmediate` or no `MessageChannel`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (environment: Environment = globalThis as Environment): Scheduler.Scheduler =>
  environment.setImmediate !== undefined || environment.MessageChannel === undefined
    ? new Scheduler.MixedScheduler()
    : new Scheduler.MixedScheduler("async", immediate(new environment.MessageChannel()))
