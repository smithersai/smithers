/**
 * The inert child process every in-memory transport suite spawns.
 *
 * A test that drives one seam of the transport has to leave the others silent:
 * a handle that is running, never exits, drains what is written to it and
 * produces nothing. Those defaults are the same in every suite, so they live
 * here and each case overrides only what it is about.
 *
 * @since 0.1.0
 */
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Effect, Layer, Sink, Stream } from "effect"
import type { Scope } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { makeHandle } from "effect/unstable/process/ChildProcessSpawner"

export type HandleOptions = Parameters<typeof makeHandle>[0]

/** A process handle with inert defaults; each case overrides only the seam it drives. */
export const fakeHandle = (overrides: Pick<HandleOptions, "pid"> & Partial<HandleOptions>) =>
  makeHandle({
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.never,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
    ...overrides
  })

/** A spawner that answers every spawn with one inert handle. */
export const fakeProcess = (
  overrides: Pick<HandleOptions, "pid"> & Partial<HandleOptions>
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  ChildProcessSpawner.makeNoop({
    spawn: (_command: ChildProcess.Command) => Effect.succeed(fakeHandle(overrides))
  })

export const provideSpawner = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
) => Effect.provide(effect, Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner))
