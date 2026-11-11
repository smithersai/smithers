/**
 * The observations the shared-mount contract makes of a `BrowserHost` bundle,
 * and what each must be. The Node contract runs them in-process over a real
 * ZenFS volume and a real just-bash bound to it; the browser suite runs the
 * same effects in a Chromium tab and ships the observations back. Both compare
 * against {@link expected}, so the contract has one statement.
 *
 * Every observation is plain data a tab can post to its test: strings and
 * exit codes as the backends returned them, and a boolean wherever the fact is
 * a relation between two values jj chose.
 */
import { Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"

/** The interpreter's own environment: the page constructs it, and every command can read it. */
export const ambient = { HOST_SECRET: "ambient-interpreter-value" }

/** The reason tag a filesystem operation fails with. */
const tagOf = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason._tag)

/**
 * FileSystem writes, the interpreter reads; the interpreter writes, FileSystem
 * and jj read. Three views of one volume, or the observations disagree.
 */
export const volume = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  const jj = yield* Jj

  yield* fileSystem.writeFileString("/repo/shared.txt", "first\n")
  const bashRead = yield* spawner.string(ChildProcess.make("cat", ["shared.txt"], { cwd: "/repo" }))
  const { changeId: firstChange, commitId: first } = yield* jj.snapshot("shared mount first")

  const written = yield* spawner.exitCode(
    ChildProcess.make("echo second > shared.txt", [], { shell: true, cwd: "/repo" })
  )
  const fsRead = yield* fileSystem.readFileString("/repo/shared.txt")
  const status = yield* jj.status()
  const { changeId: secondChange, commitId: second } = yield* jj.snapshot("shared mount second")
  const diff = yield* jj.diff(first, second)
  return {
    bashRead,
    written,
    fsRead,
    firstIsCommit: /^[a-z0-9]+$/.test(first),
    secondDiffers: second !== first,
    // Snapshots amend the same change; its parent still has no shared file.
    sameChange: secondChange === firstChange,
    statusAddsShared: status.includes("A shared.txt"),
    diffRemovesFirst: diff.includes("-first"),
    diffAddsSecond: diff.includes("+second")
  }
})

/**
 * The adapter asks the real interpreter for `replaceEnv` whenever the caller
 * supplies `env` without `extendEnv: true`. An interpreter that ignored or
 * renamed the option would show `HOST_SECRET` to the replaced command.
 */
export const environment = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  const show = (options: ChildProcess.CommandOptions) =>
    spawner.string(ChildProcess.make("echo PLAIN=$PLAIN HOST_SECRET=$HOST_SECRET", [], { shell: true, ...options }))
  return {
    replaced: yield* show({ env: { PLAIN: "visible" } }),
    extended: yield* show({ env: { PLAIN: "visible" }, extendEnv: true }),
    ambient: yield* show({})
  }
})

/**
 * The permit is held until the real interpreter settles after its
 * `AbortSignal` fires. A command that runs afterwards proves it did settle;
 * one that never did would leave the second command waiting for the permit.
 * Needs the live clock: a `TestClock` would stall the timeout.
 */
export const abort = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  const slow = yield* Effect.exit(Effect.timeout(spawner.exitCode(ChildProcess.make("sleep", ["30"])), 250))
  const next = yield* spawner.string(ChildProcess.make("echo", ["still", "running"]))
  return { slowFailed: Exit.isFailure(slow), next }
})

/** The volume's own error codes, as the `PlatformError` tags the adapter maps them to. */
export const errorTags = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.writeFileString("/repo/taken.txt", "taken\n")
  return {
    missing: yield* tagOf(fileSystem.readFileString("/repo/missing.txt")),
    exists: yield* fileSystem.exists("/repo/missing.txt"),
    directoryTwice: yield* tagOf(fileSystem.makeDirectory("/repo")),
    exclusive: yield* tagOf(fileSystem.writeFileString("/repo/taken.txt", "again\n", { flag: "wx" })),
    notDirectory: yield* tagOf(fileSystem.readDirectory("/repo/taken.txt"))
  }
})

/** What every observation above must be, over any bundle whose three views are one mount. */
export const expected = {
  volume: {
    bashRead: "first\n",
    written: 0,
    fsRead: "second\n",
    firstIsCommit: true,
    secondDiffers: true,
    sameChange: true,
    statusAddsShared: true,
    diffRemovesFirst: true,
    diffAddsSecond: true
  },
  environment: {
    replaced: "PLAIN=visible HOST_SECRET=\n",
    extended: "PLAIN=visible HOST_SECRET=ambient-interpreter-value\n",
    ambient: "PLAIN= HOST_SECRET=ambient-interpreter-value\n"
  },
  abort: { slowFailed: true, next: "still running\n" },
  errorTags: {
    missing: "NotFound",
    exists: false,
    directoryTwice: "AlreadyExists",
    exclusive: "AlreadyExists",
    notDirectory: "BadResource"
  }
} as const
