/**
 * Non-watch Vitest benchmark runs.
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
 * Attributes for {@link VitestBench}.
 *
 * `cwd` is the workspace-relative directory the runner starts in and defaults
 * to the workspace root. `benches` declares the benchmark files (`*.bench.ts`
 * or `*.bench.vibe`), `sources` declares the package sources and helpers they
 * exercise, and `deps` declares upstream workspace dependencies (such as
 * `WorkspaceSources` file groups) so changes to a dependency re-key and
 * re-select every dependent benchmark while leaving unaffected packages cached
 * and skipped.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  /**
   * The interpreter the runner runs under, when it is not the workspace's.
   */
  runtime: Schema.optional(Runtime.Runtime),
  benches: Schema.Array(Input.Declared),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  config: Schema.NullOr(Input.File),
  environment: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("node"))),
  passWithNoTests: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  /** Whether this target requires explicit selection and runs alone in the executor. */
  exclusive: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  /**
   * Replays a green benchmark run from the action-result cache when its
   * declared inputs, workspace dependencies, and toolchain have not changed.
   * Set `cache: true` only when `benches`, `sources`, and `deps` cover every
   * file the benchmarks read.
   */
  cache: Schema.optional(Schema.Boolean),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("."))),
  env: Schema.optional(Attr.Env),
  services: Schema.optional(Attr.Services),
  sandbox: Schema.optional(Attr.Sandbox),
  tools: Schema.optional(Schema.Array(Reference.HostBin)),
  hosts: Schema.optional(Attr.HostPlatforms),
  timeoutMs: Exec.TimeoutMs.pipe(Schema.withConstructorDefault(Effect.succeed(600_000)))
})

/**
 * Attributes for {@link VitestBench}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Renders the `vitest bench` arguments for one target, after the tool's name.
 *
 * @category constructors
 * @since 0.1.0
 */
export const benchArguments = (
  attrs: Pick<Attrs, "config" | "cwd" | "environment" | "passWithNoTests">
): Array<string> => [
  "bench",
  "--run",
  "--coverage.enabled=false",
  "--reporter=verbose",
  ...(attrs.config === null ? [] : ["--config", Input.rootRelative(attrs.cwd, attrs.config.path)]),
  "--environment",
  attrs.environment,
  ...(attrs.passWithNoTests ? ["--passWithNoTests"] : [])
]

/**
 * Plans a non-watch `vitest bench --run` performance benchmark target.
 *
 * Participates in the `bench` verb (`smthrs bench` and `smthrs affected bench`).
 * Coverage is always disabled so measurements reflect real execution cost rather
 * than V8 instrumentation overhead. When `cache: true` is declared with
 * complete `sources` and `deps`, unchanged benchmarks replay from cache and
 * `affected bench` skips packages whose dependency closure did not change.
 *
 * @category targets
 * @since 0.1.0
 */
export const VitestBench = Target.make("VitestBench", {
  attrs: Attrs,
  hosts: (attrs) => attrs.hosts,
  workspaceAttrs: ["packageManager", "runtime"],
  kinds: ["bench"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: (attrs) => attrs.cache === true,
  implementation: (attrs) =>
    Exec.runTool({
      cwd: attrs.cwd,
      timeoutMs: attrs.timeoutMs,
      env: Runtime.environment(attrs.runtime, attrs.env),
      argv: PackageManager.exec(PackageManager.under(attrs.packageManager, attrs.runtime), [
        "vitest",
        ...benchArguments(attrs)
      ])
    })
})
