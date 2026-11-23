/**
 * Standalone JavaScript benchmark programs as declared targets.
 *
 * Used for packages and apps whose benchmarks run directly under Node or Bun
 * rather than Vitest (for example, CLI scripts, TUI benchmarks, or counter
 * gates). Participates in the `bench` verb and supports incremental selection
 * and caching on the same contract as {@link NodeTest}.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as NodeTest from "./NodeTest.ts"
import * as Runtime from "./Runtime.ts"
import * as Shell from "./Shell.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link NodeBench}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  runtime: Schema.optional(Runtime.Runtime),
  entry: Input.File,
  args: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(NodeTest.maximumArguments)).pipe(
    Schema.withConstructorDefault(Effect.succeed([]))
  ),
  timeout: Schema.optional(Shell.Duration),
  srcs: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Dependency),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed({}))
  ),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("."))),
  exclusive: Schema.optional(Schema.Boolean),
  cache: Schema.optional(Schema.Boolean)
})

/**
 * Attributes for {@link NodeBench}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Builds the run argv for {@link NodeBench} from decoded attrs at plan time.
 *
 * @category rendering
 * @since 0.1.0
 */
export const runArgv = (attrs: Attrs): ReadonlyArray<string> =>
  Runtime.run(attrs.runtime, [Input.rootRelative(attrs.cwd, attrs.entry.path), ...attrs.args])

/**
 * Runs one declared JavaScript benchmark program under the workspace runtime
 * (or an explicit Bun/Node runtime override).
 *
 * @category targets
 * @since 0.1.0
 */
export const NodeBench = Target.make("NodeBench", {
  attrs: Attrs,
  workspaceAttrs: ["runtime"],
  kinds: ["bench"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: (attrs) => attrs.cache === true,
  implementation: (attrs) =>
    Exec.runTool({
      cwd: attrs.cwd,
      argv: runArgv(attrs),
      env: Runtime.environment(attrs.runtime, attrs.env),
      ...(attrs.timeout === undefined ? {} : { timeoutMs: Shell.durationMs(attrs.timeout) })
    })
})
