/**
 * Verification: whether a migrated unit is real.
 *
 * Five questions, in the order that makes a failure cheap to read: does it
 * install, is it formatted, does it typecheck, do its tests pass, and does the
 * registry list the flow it was supposed to produce. Discovery is last and it
 * is the one that cannot be argued with — it is the same scan the CLI runs, so
 * a flow discovery will not list is a flow nobody can run.
 *
 * Every command reports rather than throws. A non-zero exit is an answer, and
 * the answer is what the repair round is given: the command line, the exit
 * code, how long it took, and the last 12 KB of each stream.
 *
 * Every command is confined. The rewrite agent owns `package.json`, the test
 * files, and the tool configuration these commands load, so an install or a
 * test run executes text the agent wrote: a lifecycle script, a test, a
 * plugin. Each command therefore goes through the host's
 * `@smthrs/kernel` `ProcessConfinement` with a profile that opens the project
 * and nothing else, and seals the paths the operator's own tools trust. A host
 * that provides no confinement runs no command: the refusal is the command's
 * result, and `ProcessConfinement.layerNoop` is the explicit choice to run
 * unconfined.
 *
 * @since 1.0.0-rc.0
 */

import { Action } from "@smthrs/flow"
import * as Redaction from "@smthrs/journal/Redaction"
import * as ProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { systemError } from "effect/PlatformError"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Schema from "effect/Schema"
import * as Checks from "../Checks.ts"
import { MigrateError } from "../MigrateError.ts"
import * as Report from "../Report.ts"
import * as Contract from "./Contract.ts"
import * as Exec from "./internal/Exec.ts"

/**
 * How long an install may take before it is cut off.
 *
 * Installs are slower than everything else and fail differently — a cold
 * registry is not a broken migration — so they get their own, longer budget.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const installTimeoutMs = 10 * 60_000

/**
 * How long every other verification command may take.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const commandTimeoutMs = 15 * 60_000

/**
 * The verification step.
 *
 * `irreversible` because it runs the project's own commands, and an install
 * writes `node_modules`. Nothing here may replay another run's result. The
 * commands run confined to the project; see {@link run}.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const action = Action.make("smithers/migrate-v1/Verify", {
  payload: {
    root: Schema.String,
    commands: Contract.Commands,
    /**
     * What the rewrite says it changed.
     *
     * It decides nothing — every command still runs, because an agent's own
     * account of what it touched is exactly the thing a verification exists to
     * check. It is here for two other reasons. It is the plan's ordering
     * constraint: a plan orders what depends on something, so without a value
     * taken from the rewrite the engine would be free to verify beside it
     * rather than after it. And it is journaled, so a reader can compare what
     * the rewrite claimed against what the checkpoint diff found.
     */
    changedFiles: Schema.optional(Schema.Array(Schema.String)),
    /**
     * Whether a flow is supposed to exist by the time this unit verifies.
     *
     * The dependency unit adds packages and creates no flow, so demanding that
     * the registry discover one would fail every project on its first unit.
     * Absent means yes, which is the answer for every unit that writes a flow
     * and for the project unit that follows them.
     */
    expectFlows: Schema.optional(Schema.Boolean),
    /**
     * Paths under the root the commands may read and never write, beside the
     * version-control metadata that is always sealed: the run's report
     * directory, whose backups and recovery record a restore trusts.
     */
    sealed: Schema.optional(Schema.Array(Schema.String))
  },
  success: Report.VerificationResult,
  error: MigrateError,
  tier: "irreversible"
})

const skipped = (reason: string): Report.CommandResult => ({
  command: "",
  exitCode: 0,
  durationMs: 0,
  stdoutTail: "",
  stderrTail: "",
  skipped: reason
})

/**
 * A captured stream after the journal's shared redaction rules, the same net
 * `smthrs bug` applies before upload. The tail lands in `report.json`, which
 * the operator commits, and a failing 0.x install or test suite can print a
 * registry token or a value read from `.env`.
 */
const redact = (text: string): string => Redaction.redact(text) as string

/**
 * Sealed for every run. Version-control metadata runs as the operator later:
 * a hook or a config alias a command planted there would execute outside the
 * confinement, on the next `git` or `jj` the checkpoint or the operator runs.
 */
const sealedAlways: ReadonlyArray<string> = [".git", ".jj"]

/** A path the host could not probe is treated as present, which is the closed answer everywhere it is asked. */
const assumePresent = (): boolean => true

/** The version-control metadata that exists at the project root. */
const metadataAt = (root: string): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const present: Array<string> = []
    for (const name of sealedAlways) {
      if (yield* Effect.orElseSucceed(fs.exists(path.resolve(root, name)), assumePresent)) present.push(name)
    }
    return present
  })

type Confine = NonNullable<Exec.Options["prepare"]>

/**
 * The wrapper every command of one run starts through.
 *
 * The profile opens the project tree for reading and writing and nothing
 * outside it, and re-closes the sealed paths that exist: a mechanism cannot
 * seal a path that is not there, and a path outside the root is already
 * closed. The network stays open because an install has to reach a registry.
 * The host's confinement decides the rest, the environment included.
 */
const confinementFor = (
  root: string,
  sealed: ReadonlyArray<string>
): Effect.Effect<Confine, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const host = yield* Effect.serviceOption(ProcessConfinement.ProcessConfinement)
    if (Option.isNone(host)) {
      const refuse: Confine = () =>
        Effect.fail(systemError({
          _tag: "NotFound",
          module: "ProcessConfinement",
          method: "confine",
          description:
            "process confinement is required to run a verification command; provide ProcessConfinement.layerNoop to explicitly run unconfined"
        }))
      return refuse
    }
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const workspaceRoot = path.resolve(root)
    const readOnly: Array<string> = []
    for (const candidate of new Set([...sealedAlways, ...sealed])) {
      const relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, candidate))
      const inside = relative !== "" && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== ".."
      // A path the host could not probe is sealed as if it exists: the
      // mechanism then refuses the command rather than leave the path open.
      if (inside && (yield* Effect.orElseSucceed(fs.exists(path.join(workspaceRoot, relative)), assumePresent))) {
        readOnly.push(relative.split(path.sep).join("/"))
      }
    }
    const profile: ProcessConfinement.Profile = {
      workspaceRoot,
      reads: ["."],
      writes: ["."],
      readOnly,
      network: "open"
    }
    const confine: Confine = (command) => host.value.confine(command, profile)
    return confine
  })

const one = (
  root: string,
  command: Contract.VerificationCommand,
  timeoutMs: number,
  prepare: Confine
): Effect.Effect<Report.CommandResult, never, ChildProcessSpawner> =>
  Effect.gen(function*() {
    const started = yield* Clock.currentTimeMillis
    const line = Contract.commandLine(command)
    const run = typeof command === "string"
      ? Exec.run(command, { cwd: root, timeoutMs, prepare })
      : Exec.run(command.executable, { args: command.args, cwd: root, timeoutMs, prepare })
    return yield* run.pipe(
      Effect.map((result): Report.CommandResult => ({
        command: line,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutTail: redact(Exec.tail(result.stdout)),
        stderrTail: redact(Exec.tail(result.stderr))
      })),
      // A command that could not start, that the host refused to confine, or
      // that ran out of time, is a failing command rather than a failing
      // tool: the repair round has to see it.
      Effect.catch((failure) =>
        Effect.map(Clock.currentTimeMillis, (finished): Report.CommandResult => ({
          command: line,
          exitCode: failure.reason === `exceeded ${timeoutMs}ms` ? 124 : 127,
          durationMs: Math.max(0, finished - started),
          stdoutTail: "",
          stderrTail: failure.reason
        }))
      )
    )
  })

const discoveryResult = (
  root: string,
  flowsDir: string
): Effect.Effect<Report.CommandResult, never, FileSystem.FileSystem | Path.Path> =>
  Checks.discovery(root, flowsDir).pipe(
    Effect.map((check): Report.CommandResult => ({
      command: `discovery ${flowsDir}`,
      exitCode: check.ok ? 0 : 1,
      durationMs: 0,
      stdoutTail: check.findings.map((finding) => `${finding.file}: ${finding.message}`).join("\n"),
      stderrTail: ""
    })),
    Effect.catch((error) =>
      Effect.succeed<Report.CommandResult>({
        command: `discovery ${flowsDir}`,
        exitCode: 1,
        durationMs: 0,
        stdoutTail: "",
        stderrTail: error.message
      })
    )
  )

/**
 * Per-command wall-clock budgets. The defaults are
 * {@link installTimeoutMs} and {@link commandTimeoutMs}; a caller overrides
 * them only to make a test's clock finite.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Budgets {
  readonly install?: number | undefined
  readonly command?: number | undefined
}

/**
 * Runs every verification command for one unit.
 *
 * Each command starts through the `ProcessConfinement` in the context: it may
 * read and write the project, may write neither `.git`, `.jj`, nor a
 * `sealed` path, and reaches nothing else on the host that the confinement
 * does not open. Without that service every command reports exit 127 and the
 * reason, and nothing is spawned.
 *
 * A project with no `.git` or `.jj` has none after the commands either: one
 * that a command created is removed, and the result carries a failing
 * `version-control metadata` entry among the typechecks.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const run = (payload: {
  readonly root: string
  readonly commands: Contract.Commands
  readonly changedFiles?: ReadonlyArray<string> | undefined
  readonly expectFlows?: boolean | undefined
  readonly sealed?: ReadonlyArray<string> | undefined
}, budgets: Budgets = {}): Effect.Effect<
  Report.VerificationResult,
  MigrateError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> =>
  Effect.gen(function*() {
    const { commands, root } = payload
    const installBudget = budgets.install ?? installTimeoutMs
    const commandBudget = budgets.command ?? commandTimeoutMs
    const confine = yield* confinementFor(root, payload.sealed ?? [])
    const metadata = yield* metadataAt(root)
    const install = commands.install === undefined
      ? skipped("no lockfile names an install command")
      : yield* one(root, commands.install, installBudget, confine)
    const format = commands.format === undefined
      ? skipped("the project configures no formatter")
      : yield* one(root, commands.format, commandBudget, confine)
    const typecheck: Array<Report.CommandResult> = []
    for (const command of commands.typecheck) {
      typecheck.push(yield* one(root, command, commandBudget, confine))
    }
    const tests = commands.test === undefined
      ? skipped("the project declares no test command")
      : yield* one(root, commands.test, commandBudget, confine)
    // A mechanism cannot seal a path that is not there, so a command can
    // create `.git` or `.jj` where the project had none. The next checkpoint
    // would read its configuration and run what it names as the operator.
    const planted = (yield* metadataAt(root)).filter((name) => !metadata.includes(name))
    if (planted.length > 0) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      for (const name of planted) yield* Effect.orDie(fs.remove(path.resolve(root, name), { recursive: true }))
      typecheck.push({
        command: "version-control metadata",
        exitCode: 1,
        durationMs: 0,
        stdoutTail: "",
        stderrTail: `a verification command created ${
          planted.join(" and ")
        } at the project root, and the host removed it: a checkpoint would run what its configuration names`
      })
    }
    const discovery = payload.expectFlows === false
      ? skipped(`this unit writes no flow, so there is nothing under ${commands.flowsDir}/ to discover yet`)
      : yield* discoveryResult(root, commands.flowsDir)
    return { install, format, typecheck, tests, discovery }
  })

const failing = (result: Report.CommandResult | undefined): boolean =>
  result !== undefined && result.skipped === undefined && result.exitCode !== 0

/**
 * Whether every command that ran said yes.
 *
 * A skipped command is not a failure: a project with no formatter has nothing
 * to format, and the report says so rather than inventing a verdict.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const verdict = (result: Report.VerificationResult): "pass" | "fail" =>
  failing(result.install) ||
    failing(result.format) ||
    result.typecheck.some(failing) ||
    failing(result.tests) ||
    failing(result.discovery)
    ? "fail"
    : "pass"

/**
 * The failing commands, as one line each. What a report's summary shows.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const failures = (result: Report.VerificationResult): ReadonlyArray<string> =>
  [
    ...(failing(result.install) ? [result.install!] : []),
    ...(failing(result.format) ? [result.format!] : []),
    ...result.typecheck.filter(failing),
    ...(failing(result.tests) ? [result.tests!] : []),
    ...(failing(result.discovery) ? [result.discovery!] : [])
  ].map((command) => `\`${command.command}\` exited ${command.exitCode}`)

/**
 * The verification action's implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = action.toLayer((payload) => run(payload))
