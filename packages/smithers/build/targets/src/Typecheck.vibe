/**
 * TypeScript semantic checks.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link Typecheck}.
 *
 * `cwd` is the workspace-relative package directory `vibelang` runs in and
 * defaults to the workspace root, so `tsconfig` stays package-relative. A
 * `//` tsconfig is workspace-rooted and is rendered relative to `cwd` before
 * `vibelang` sees it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  srcs: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  tsconfig: Input.File,
  buildMode: Schema.Boolean,
  incremental: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link Typecheck}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Builds the checking argv from decoded attrs at plan time.
 *
 * The compiler resolves through `pnpm exec`, matching the pnpm workspace
 * install target. Plain mode runs `vibelang -p <tsconfig> --noEmit`, adding
 * `--incremental` when requested. Build mode runs `vibelang -b <tsconfig>`
 * for project references, adding `--force` when `incremental` is false so the
 * check never trusts stale build info.
 */
const checkArgv = (attrs: Attrs): ReadonlyArray<string> =>
  attrs.buildMode
    ? PackageManager.exec(attrs.packageManager, [
      "vibelang",
      "-b",
      Input.rootRelative(attrs.cwd, attrs.tsconfig.path),
      ...(attrs.incremental ? [] : ["--force"])
    ])
    : PackageManager.exec(attrs.packageManager, [
      "vibelang",
      "-p",
      Input.rootRelative(attrs.cwd, attrs.tsconfig.path),
      "--noEmit",
      ...(attrs.incremental ? ["--incremental"] : [])
    ])

/**
 * Checks a package with `vibelang --noEmit` or in TypeScript build mode.
 *
 * `vibelang` is VibeLang's compiler: TypeScript 7's checker, which also reads
 * `.vibe` files, so a package that imports a workspace package's VibeLang
 * source checks it as part of its own program, with that package's VibeLang
 * settings. On plain TypeScript it is TypeScript 7 `tsc`, with the same
 * arguments. The plan runs it in `cwd` through the shared {@link Exec.Exec} action.
 * Success carries the {@link Exec.Result} run summary; the target declares no
 * output directories. Source and tsconfig digests are declared through the
 * attrs, and dependency target keys, build-mode policy, and incremental
 * policy complete the key material. This models tevm's `typecheck` target
 * and TypeScript project references.
 *
 * @category targets
 * @since 0.1.0
 */
export const Typecheck = Target.make("Typecheck", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["build"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) => Exec.runTool({ cwd: attrs.cwd, argv: checkArgv(attrs) })
})
