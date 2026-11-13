/**
 * Biome lint and formatting checks.
 *
 * @since 0.1.0
 */

import type { Action } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Filegroup from "./Filegroup.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link BiomeCheck}.
 *
 * `cwd` is the workspace-relative directory the tool runs in and defaults to
 * the workspace root. The `config` path and every source path resolve from
 * `cwd` unless prefixed with `//`, which anchors them at the workspace root.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  config: Input.File,
  lint: Schema.Boolean,
  format: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link BiomeCheck}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Result of one Biome target: the exec result of each enabled check family,
 * `null` for a family the attrs disabled.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BiomeReport = Schema.Struct({
  check: Schema.NullOr(Exec.Result),
  format: Schema.NullOr(Exec.Result)
})

/**
 * Result of one Biome target.
 *
 * @category models
 * @since 0.1.0
 */
export type BiomeReport = typeof BiomeReport.Type

/**
 * Plans Biome lint and format checks without writing files.
 *
 * The body records one `biome lint` run when `lint` is enabled and one
 * `biome format` run in its default check mode when `format` is enabled,
 * both from `cwd` through the shared {@link Exec.Exec} action with the
 * declared configuration passed as `--config-path`. Tools resolve through
 * `pnpm exec`, matching the pnpm workspace install target. Key material
 * contains source and configuration digests, dependency keys, and the enabled
 * check families. Globs expand to exactly their declared files, including
 * exclusions; an empty expansion runs no checks. Executing a glob plan also
 * requires {@link Filegroup.ExpandFilegroupLive}, alongside {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const BiomeCheck = Target.make("BiomeCheck", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["lint"],
  success: BiomeReport,
  error: Schema.Union([Exec.ExecError, Filegroup.FilegroupError]),
  implementation: (attrs) => {
    if (!attrs.lint && !attrs.format) return Node.succeed({ check: null, format: null })
    const config = `--config-path=${Input.rootRelative(attrs.cwd, attrs.config.path)}`
    const lintPrefix = PackageManager.exec(attrs.packageManager, ["biome", "lint", config])
    const formatPrefix = PackageManager.exec(attrs.packageManager, ["biome", "format", config])
    const run = (
      lintArgv: Exec.CallPayload["argv"],
      formatArgv: Exec.CallPayload["argv"]
    ): Node.Node<BiomeReport, Exec.ExecError, Action.Requirement<"smithers-build/exec">> => {
      if (!attrs.lint) {
        return Exec.runTool({ cwd: attrs.cwd, argv: formatArgv })
          .pipe(Node.map((format) => ({ check: null, format })))
      }
      const checked = Exec.runTool({ cwd: attrs.cwd, argv: lintArgv })
      if (!attrs.format) return checked.pipe(Node.map((check) => ({ check, format: null })))
      return checked.pipe(
        Node.bindPlanned((check) =>
          Exec.runTool({ cwd: attrs.cwd, argv: formatArgv, after: check })
            .pipe(Node.bindPlanned((format) => Node.succeed({ check, format })))
        )
      )
    }
    const sources = attrs.sources.filter((source): source is Filegroup.Source =>
      source._tag === "File" || source._tag === "Glob"
    )
    if (!sources.some((source) => source._tag === "Glob")) {
      const paths = sources.map((source) => Input.rootRelative(attrs.cwd, (source as Input.File).path))
      const selected = paths.length === 0 ? ["."] : [...new Set(paths)]
      return run([...lintPrefix, ...selected], [...formatPrefix, ...selected])
    }
    return Filegroup.ExpandFilegroup.call({
      sources: Filegroup.sources({ srcs: sources, cwd: attrs.cwd }, {
        sourceFile: undefined,
        packageDirectory: undefined
      })
    }).pipe(
      Node.map(Node.capture({ cwd: attrs.cwd, lintPrefix, formatPrefix }, function(files: Filegroup.Files) {
        const paths = files.map((file) => Input.rootRelative(this.cwd, `//${file.path}`))
        return {
          empty: paths.length === 0,
          lintArgv: [...this.lintPrefix, ...paths],
          formatArgv: [...this.formatPrefix, ...paths]
        }
      })),
      Node.branch({
        if: (commands) => !commands.empty,
        then: (commands) => run(commands.lintArgv, commands.formatArgv),
        else: () => Node.succeed({ check: null, format: null })
      })
    )
  }
})
