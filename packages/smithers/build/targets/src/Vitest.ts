/**
 * Non-watch Vitest runs.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Reference from "./Reference.ts"
import * as Runtime from "./Runtime.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link Vitest}.
 *
 * `cwd` is the workspace-relative directory the runner starts in and defaults
 * to the workspace root. The `config` path resolves from `cwd` when the tool
 * runs; a `//` config is workspace-rooted and is rendered relative to `cwd`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  /**
   * The interpreter the runner runs under, when it is not the workspace's.
   *
   * A declaration overrides the interpreter by naming it here rather than by
   * restating a package manager: Bun is its own manager, so
   * `runtime: S.Runtime.Bun({ ... })` is the whole override. Omitted, the
   * executor fills in the workspace runtime and the run goes through the
   * workspace package manager.
   */
  runtime: Schema.optional(Runtime.Runtime),
  tests: Schema.Array(Input.Declared),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  config: Schema.NullOr(Input.File),
  environment: Schema.NonEmptyString,
  passWithNoTests: Schema.Boolean,
  /** Whether this target requires explicit selection and runs alone in the executor. */
  exclusive: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  /**
   * Whether the run may compute coverage. `false` renders
   * `--coverage.enabled=false`, which a config with coverage enabled needs on a
   * host whose engine has no V8 inspector — Bun runs JavaScriptCore, and
   * `@vitest/coverage-v8` cannot attach there.
   *
   * @default true
   */
  coverage: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true))),
  /**
   * Stops the run once this many cases have failed, as `--bail`. Omitted,
   * every case runs. A run that passes is the same run either way, so the
   * executor sets it to 1 on a confined attempt whose failure it would
   * discard: a suite that cannot run confined then costs its first failure,
   * not its whole length.
   */
  bail: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  /**
   * `false` never reuses this target's result and runs it exactly as the
   * workspace declares, with no confined attempt. Declare it on a target
   * whose run must leave files behind, or whose cases depend on files it
   * does not declare.
   */
  cache: Schema.optional(Schema.Literal(false)),
  /**
   * The unit of work. `"target"` runs every test file in one run. `"file"`
   * makes each test file a unit that `smithers-build units` runs on its own:
   * a change reruns only the test files that reach a changed file. See the
   * test units concept page.
   *
   * @default "target"
   */
  units: Schema.Literals(["target", "file"]).pipe(Schema.withConstructorDefault(Effect.succeed("target" as const))),
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  ),
  /**
   * Variables set on the runner. The runner otherwise sees only the narrow
   * host bootstrap environment ({@link Exec.inheritedEnvironmentNames}), so a
   * value a case needs, such as a service's URL, is declared here rather than
   * exported by the caller.
   */
  env: Schema.optional(Attr.Env),
  /**
   * Service targets acquired, readiness-gated, before the run and released
   * after it, as for `Shell.Test`. A service requires an explicit `sandbox`.
   */
  services: Schema.optional(Attr.Services),
  /** The sandbox policy, as for `Shell.Test`. */
  sandbox: Schema.optional(Attr.Sandbox),
  /**
   * The host programs the suite starts by name that its packages do not
   * install: `[S.Host.bin("zig"), S.Host.bin("strace")]`. Each is found on `PATH` when
   * the run is planned and keyed by the bytes of the file it resolves to,
   * through any link or package-manager shim, so a program replaced in place
   * runs the suite again. A confined run is shown these and the system's own
   * programs; a program the suite starts that is not declared fails, naming
   * itself.
   */
  tools: Schema.optional(Schema.Array(Reference.HostBin)),
  /**
   * The hosts the suite runs on, as `process.platform` names them, as for
   * `Shell.Test`: `["linux", "darwin"]` for a suite whose program does not run
   * on Windows. A wildcard selection leaves the target out on another host,
   * and naming it there refuses it.
   */
  hosts: Schema.optional(Attr.HostPlatforms),
  /**
   * How long the run may take before the tool is killed.
   *
   * The exec default of ten minutes is measured against a developer machine
   * and leaves a large suite no headroom on a hosted runner. `packages/smithers`
   * takes 142 s here and 600.4 s on a two-core runner, which is 4.2 times
   * slower and exactly the ten-minute cap, so the target died rather than
   * reporting. Twenty minutes is above that with room and still bounds a hang,
   * which does not finish at any budget. A package that wants a tighter bound
   * sets its own.
   *
   * @default 1_200_000
   */
  timeoutMs: Exec.TimeoutMs.pipe(Schema.withConstructorDefault(Effect.succeed(1_200_000)))
})

/**
 * Attributes for {@link Vitest}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * The `vitest run` arguments of one target, after the tool's name.
 *
 * @category constructors
 * @since 1.0.0
 */
export const runArguments = (
  attrs: Pick<Attrs, "bail" | "config" | "cwd" | "environment" | "coverage" | "passWithNoTests">
): Array<string> => [
  "run",
  ...(attrs.config === null ? [] : ["--config", Input.rootRelative(attrs.cwd, attrs.config.path)]),
  "--environment",
  attrs.environment,
  ...(attrs.coverage ? [] : ["--coverage.enabled=false"]),
  ...(attrs.bail === undefined ? [] : [`--bail=${attrs.bail}`]),
  ...(attrs.passWithNoTests ? ["--passWithNoTests"] : [])
]

/**
 * The arguments that run one test file as a unit and write its results and
 * coverage to `blob`. The default reporter stays on, so a failed unit's
 * output names the test that failed. Thresholds are not judged here: one
 * file cannot meet a threshold set for the whole target, and its coverage
 * report is cut to a summary. {@link mergeArguments} judges the thresholds.
 *
 * `file`, `blob` and `reports` are paths the runner can open from `cwd`.
 * `reports` is a directory this run alone writes its coverage report into,
 * so units running side by side never share one.
 *
 * @category constructors
 * @since 1.0.0
 */
export const unitArguments = (
  attrs: Parameters<typeof runArguments>[0],
  unit: { readonly file: string; readonly blob: string; readonly reports: string }
): Array<string> => [
  ...runArguments(attrs),
  unit.file,
  "--reporter=default",
  "--reporter=blob",
  `--outputFile=${unit.blob}`,
  ...(attrs.coverage
    ? ["--coverage.thresholds=false", "--coverage.reporter=text-summary", `--coverage.reportsDirectory=${unit.reports}`]
    : [])
]

/**
 * The arguments that merge every unit's blob in `blobs` into one report and
 * judge the target's coverage thresholds over all of them.
 *
 * @category constructors
 * @since 1.0.0
 */
export const mergeArguments = (
  attrs: Parameters<typeof runArguments>[0],
  blobs: string
): Array<string> => [...runArguments(attrs), `--merge-reports=${blobs}`]

/**
 * Plans a non-watch `vitest run` test target.
 *
 * The body records one {@link Exec.Exec} node that runs
 * `pnpm exec vitest run` from `cwd` with the declared config, test
 * environment, `env` variables and empty-suite policy, under any declared
 * `services`. Test, source, and config declarations are the
 * target's inputs, so key material contains their digests plus dependency
 * target keys. The declaration asserts no cacheability of its own: the
 * executor reuses a green run only after one confined to the declared inputs,
 * with the installed runner and its plugins in the key. This models tevm's
 * `test:run` target and Vitest's deterministic run mode. Executing the plan
 * requires {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const Vitest = Target.make("Vitest", {
  attrs: Attrs,
  hosts: (attrs) => attrs.hosts,
  workspaceAttrs: ["packageManager", "runtime"],
  kinds: ["test"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) =>
    Exec.runTool({
      cwd: attrs.cwd,
      timeoutMs: attrs.timeoutMs,
      env: Runtime.environment(attrs.runtime, attrs.env),
      argv: PackageManager.exec(PackageManager.under(attrs.packageManager, attrs.runtime), [
        "vitest",
        ...runArguments(attrs)
      ])
    })
})
