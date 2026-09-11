/**
 * Runs the sandbox session conformance suite.
 *
 * @since 0.1.0
 */
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Stream from "effect/Stream"
import { boundedCheck } from "../internal/boundedCheck.ts"
import { defaultCheckTimeout } from "../internal/deadline.ts"
import { describeExit } from "../internal/describeExit.ts"
import * as check_ from "../ProviderConformance/check.ts"
import type { Commands } from "../ProviderConformance/Commands.ts"
import type { Violation } from "../ProviderConformance/Violation.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { commandProvider } from "../Sandbox/commandProvider.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"
import { uniquePosixCommands } from "./posixCommands.ts"

/**
 * Runs one check against a fresh session, so a check that leaves a session
 * unusable cannot decide the next one, and under a deadline, so a provider
 * that hangs (a dropped stdin leaves `cat` waiting forever) is convicted
 * rather than hanging the suite with it.
 */
const inSession = <A>(
  provider: Provider,
  session: string,
  deadline: Duration.Input,
  body: (session: Session) => Effect.Effect<A, unknown, never>
): Effect.Effect<Exit.Exit<A, unknown>> =>
  boundedCheck(Effect.scoped(Effect.flatMap(provider.acquire(session), body)), deadline)

/** Standard output as text plus the exit status, the shape most checks compare. */
const output = (process: RemoteProcess): Effect.Effect<string, ProviderError> =>
  Effect.map(
    Effect.all(
      [Stream.mkString(Stream.decodeText(process.stdout)), process.exitCode],
      { concurrency: "unbounded" }
    ),
    ([stdout, code]) => `${stdout}#${code}`
  )

/** Both output streams as one text, for a check that asks only whether text arrived at all. */
const everything = (process: RemoteProcess): Effect.Effect<string, ProviderError> =>
  Effect.map(
    Effect.all(
      [
        Stream.mkString(Stream.decodeText(process.stdout)),
        Stream.mkString(Stream.decodeText(process.stderr)),
        process.exitCode
      ],
      { concurrency: "unbounded" }
    ),
    ([stdout, stderr, code]) => `${stdout}${stderr}#${code}`
  )

const run = (live: Session, command: string, options: Parameters<Session["spawn"]>[1] = {}) =>
  Effect.scoped(Effect.flatMap(live.spawn(command, options), output))

const conformanceBytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 7])

/**
 * A deterministic 64 KiB payload: larger than any single command line a
 * transport could carry inline, so a provider that moves files through its
 * shell has to slice, and full of every byte value, so a text path cannot
 * hide.
 */
const largeBytes = (() => {
  const bytes = new Uint8Array(64 * 1024)
  let state = 0x2545f491
  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
})()

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/**
 * Names the suite's session key and declared capabilities.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckOptions {
  /** The session key every check acquires. Default `sandbox-conformance`. */
  readonly session?: string | undefined
  /** The command fixture for the delegated spawn checks. Default {@link uniquePosixCommands}. */
  readonly commands?: Commands | undefined
  /**
   * How long any single check may take, machine acquisition included, before
   * it is convicted as hung. Default 10 seconds. Raise it explicitly for slow
   * machine provisioning and size the test budget for the whole suite.
   */
  readonly checkTimeout?: Duration.Input | undefined
  /** Capabilities the provider's sessions are declared to have. */
  readonly provides?: {
    readonly kill?: boolean | undefined
    readonly ping?: boolean | undefined
  } | undefined
}

/**
 * Checks one provider against the `Sandbox` session contract.
 *
 * A provider package runs this in its own test suite and asserts the result
 * is empty, the way `ProviderConformance` is run for spawn-only transports.
 *
 * The file checks state the contract's own obligations: byte round-trips of
 * a small binary payload, an empty file, and a 64 KiB one; `not_found` for
 * absence; parent creation; the workdir default and a relative `cwd`;
 * environment delivery; deletion of inherited HOME or a typed refusal;
 * refusal of an environment name a guest shell would drop; standard input delivery; standard error delivery; and a working
 * session after release and reacquire. Two checks look across
 * surfaces on purpose. A session that served `readFile` from somewhere other
 * than the machine its processes run on would pass every file check and
 * every process check separately, so one check writes through `writeFile`
 * and measures the file with a process, and another produces a file with a
 * process and reads it back through `readFile`. The spawn checks are the
 * delegated `ProviderConformance` suite over `commandProvider`, so a session
 * provider is held to everything a spawn transport is, including that a
 * declared `kill` ends the command's work and not just its shell.
 *
 * @category constructors
 * @since 0.1.0
 */
export const check = (
  provider: Provider,
  options: CheckOptions = {}
): Effect.Effect<ReadonlyArray<Violation>> =>
  Effect.gen(function*() {
    const session = options.session ?? "sandbox-conformance"
    const deadline = options.checkTimeout ?? defaultCheckTimeout
    const roundTrips = yield* inSession(provider, session, deadline, (live) =>
      Effect.gen(function*() {
        const path = `${live.workdir}/conformance-bytes.bin`
        yield* live.writeFile(path, conformanceBytes)
        return yield* live.readFile(path)
      }))
    const empty = yield* inSession(provider, session, deadline, (live) =>
      Effect.gen(function*() {
        const path = `${live.workdir}/conformance-empty.bin`
        yield* live.writeFile(path, new Uint8Array())
        return yield* live.readFile(path)
      }))
    const large = yield* inSession(provider, session, deadline, (live) =>
      Effect.gen(function*() {
        const path = `${live.workdir}/conformance-large.bin`
        yield* live.writeFile(path, largeBytes)
        return yield* live.readFile(path)
      }))
    const absent = yield* inSession(provider, session, deadline, (live) =>
      Effect.flip(live.readFile(`${live.workdir}/conformance-absent`)))
    const parents = yield* inSession(provider, session, deadline, (live) =>
      Effect.gen(function*() {
        const path = `${live.workdir}/conformance/deep/tree/leaf.txt`
        yield* live.writeFile(path, conformanceBytes)
        return yield* live.readFile(path)
      }))
    const workdir = yield* inSession(provider, session, deadline, (live) =>
      Effect.map(run(live, "pwd"), (answer) => ({ answer, expected: `${live.workdir}\n#0` })))
    const relativeCwd = yield* inSession(provider, session, deadline, (live) =>
      Effect.gen(function*() {
        yield* run(live, "mkdir -p conformance-sub")
        const answer = yield* run(live, "pwd", { cwd: "conformance-sub" })
        return { answer, expected: `${live.workdir}/conformance-sub\n#0` }
      }))
    const environment = yield* inSession(provider, session, deadline, (live) =>
      run(live, `printf '%s' "$SANDBOX_CONFORMANCE"`, { env: { SANDBOX_CONFORMANCE: "delivered" } }))
    const deletedEnvironment = yield* inSession(provider, session, deadline, (live) =>
      Effect.gen(function*() {
        // HOME comes from the guest, never from a command default. Check its
        // presence first so deleting an already-absent variable cannot pass.
        const before = yield* run(live, `printf '%s' "\${HOME+present}"`)
        const after = yield* Effect.scoped(Effect.matchEffect(
          live.spawn(`printf '%s' "\${HOME+present}"`, { env: { HOME: undefined } }),
          {
            onFailure: (error) =>
              Effect.succeed(error),
            onSuccess: output
          }
        ))
        return { before, after }
      }))
    const unusableEnvironment = yield* inSession(provider, session, deadline, (live) =>
      Effect.flip(run(live, "true", { env: { "not-a-shell-name": "x" } })))
    const stdin = yield* inSession(provider, session, deadline, (live) =>
      Effect.gen(function*() {
        // Compared through a file, not through stdout: a transport whose
        // process output is a pseudo-terminal cannot carry these bytes back
        // on stdout, and that is a documented property of output, not a
        // failure of input.
        const status = yield* run(live, "cat > conformance-stdin.bin", { stdin: conformanceBytes })
        const copied = yield* live.readFile(`${live.workdir}/conformance-stdin.bin`)
        return { status, copied }
      }))
    const stderr = yield* inSession(provider, session, deadline, (live) =>
      Effect.scoped(Effect.flatMap(live.spawn(`printf 'to-stderr' >&2`, {}), everything)))
    const fileToProcess = yield* inSession(provider, session, deadline, (live) =>
      Effect.gen(function*() {
        yield* live.writeFile(`${live.workdir}/conformance-cross.bin`, conformanceBytes)
        // BSD `wc` pads its count, so whitespace is not part of the answer.
        return (yield* run(live, "wc -c < conformance-cross.bin")).replaceAll(/\s+/g, "")
      }))
    const processToFile = yield* inSession(provider, session, deadline, (live) =>
      Effect.gen(function*() {
        yield* run(live, "printf 'from-process' > conformance-produced.txt")
        return new TextDecoder().decode(yield* live.readFile(`${live.workdir}/conformance-produced.txt`))
      }))
    const reacquired = yield* boundedCheck(
      Effect.andThen(
        Effect.scoped(Effect.asVoid(provider.acquire(session))),
        Effect.scoped(Effect.flatMap(provider.acquire(session), (live) =>
          run(live, "printf 'again'")))
      ),
      deadline
    )
    // The delegated suite gets the same deadline. It used to be called outside
    // every race this generator sets up, so a provider that hung on spawn hung
    // both public entry points despite `checkTimeout` promising otherwise.
    const spawnChecks = yield* check_.check(
      commandProvider(provider, {
        session,
        ...options.provides === undefined ? {} : { provides: options.provides }
      }),
      options.commands ?? uniquePosixCommands(),
      { checkTimeout: deadline }
    )
    const found: Array<Violation | undefined> = [
      Exit.isSuccess(roundTrips) && sameBytes(roundTrips.value, conformanceBytes) ? undefined : {
        check: "round-trips-binary-bytes",
        expected: "the written bytes back, unchanged",
        actual: describeExit(roundTrips)
      },
      Exit.isSuccess(empty) && empty.value.length === 0 ? undefined : {
        check: "round-trips-an-empty-file",
        expected: "an empty file back, empty",
        actual: describeExit(empty)
      },
      Exit.isSuccess(large) && sameBytes(large.value, largeBytes) ? undefined : {
        check: "round-trips-a-large-file",
        expected: "64 KiB back, unchanged",
        actual: Exit.isSuccess(large) ? `${large.value.length} bytes, or different bytes` : describeExit(large)
      },
      Exit.isSuccess(absent) && absent.value instanceof ProviderError && absent.value.code === "not_found"
        ? undefined
        : {
          check: "reports-an-absent-file",
          expected: "a ProviderError with code not_found",
          actual: describeExit(absent)
        },
      Exit.isSuccess(parents) ? undefined : {
        check: "creates-parent-directories",
        expected: "a write below missing directories to land",
        actual: describeExit(parents)
      },
      Exit.isSuccess(workdir) && workdir.value.answer === workdir.value.expected ? undefined : {
        check: "runs-in-its-workdir",
        expected: "a bare spawn's working directory to be the session workdir",
        actual: describeExit(workdir)
      },
      Exit.isSuccess(relativeCwd) && relativeCwd.value.answer === relativeCwd.value.expected ? undefined : {
        check: "roots-a-relative-cwd",
        expected: "a relative cwd to be taken under the session workdir",
        actual: describeExit(relativeCwd)
      },
      Exit.isSuccess(environment) && environment.value === "delivered#0" ? undefined : {
        check: "delivers-the-environment",
        expected: `stdout "delivered" from the spawn's env`,
        actual: describeExit(environment)
      },
      Exit.isSuccess(deletedEnvironment) && deletedEnvironment.value.before === "present#0" &&
        (deletedEnvironment.value.after === "#0" ||
          (deletedEnvironment.value.after instanceof ProviderError &&
            deletedEnvironment.value.after.code === "spawn_error"))
        ? undefined
        : {
          check: "deletes-inherited-environment-or-refuses",
          expected: "guest HOME present before deletion, then absent or spawn refused with ProviderError spawn_error",
          actual: describeExit(deletedEnvironment)
        },
      Exit.isSuccess(unusableEnvironment) && unusableEnvironment.value instanceof ProviderError
        ? undefined
        : {
          check: "refuses-an-unusable-environment-name",
          expected: "a ProviderError for an env name the guest shell would drop",
          actual: describeExit(unusableEnvironment)
        },
      Exit.isSuccess(stdin) && stdin.value.status === "#0" && sameBytes(stdin.value.copied, conformanceBytes)
        ? undefined
        : {
          check: "delivers-standard-input",
          expected: "the bytes given as stdin to reach the command unchanged",
          actual: describeExit(stdin)
        },
      Exit.isSuccess(stderr) && stderr.value.startsWith("to-stderr") ? undefined : {
        check: "delivers-standard-error",
        expected: "text a command writes to stderr to arrive on one of its output streams",
        actual: describeExit(stderr)
      },
      Exit.isSuccess(fileToProcess) && fileToProcess.value === `${conformanceBytes.length}#0` ? undefined : {
        check: "files-reach-processes",
        expected: `a process to measure ${conformanceBytes.length} bytes in a file writeFile put there`,
        actual: describeExit(fileToProcess)
      },
      Exit.isSuccess(processToFile) && processToFile.value === "from-process" ? undefined : {
        check: "processes-reach-files",
        expected: "readFile to return what a process wrote",
        actual: describeExit(processToFile)
      },
      Exit.isSuccess(reacquired) && reacquired.value === "again#0" ? undefined : {
        check: "reacquires-its-session",
        expected: "a working session after release and reacquire",
        actual: describeExit(reacquired)
      }
    ]
    return [
      ...found.filter((violation): violation is Violation =>
        violation !== undefined
      ),
      ...spawnChecks
    ]
  })
