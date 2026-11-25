/**
 * Smithers PACKAGE.ts target factory wiring Filegroup, Shell.Test, Generate, and Materialize targets.
 *
 * @since 1.0.0
 */

import { Smithers } from "@smthrs/targets"
import type { Mode } from "./Config.ts"

/**
 * Options configuring generated Smithers PACKAGE.ts comment targets.
 *
 * @since 1.0.0
 * @category models
 */
export interface CommentTargetsOptions {
  readonly mode?: Mode
  readonly commentsDir?: string
  readonly include?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
  readonly virtualOutDir?: string
  readonly cwd?: string
}

/**
 * Builds incremental Smithers targets for comment linting and external virtual-file projection.
 *
 * @since 1.0.0
 * @category targets
 */
export const targets = (options: CommentTargetsOptions = {}) => {
  const mode = options.mode ?? "inline"
  const commentsDir = options.commentsDir ?? ".comments"
  const include = options.include ?? ["src/**/*"]
  const exclude = options.exclude ?? ["**/node_modules/**", "**/.git/**", "**/dist/**"]
  const virtualOutDir = options.virtualOutDir ?? ".smithers/comments-view"
  const cwd = options.cwd ?? "."

  const sources = Smithers.Filegroup({
    srcs: include.map((pattern) => Smithers.glob(pattern, { exclude: [...exclude] })),
    cwd
  })

  const sidecars = Smithers.Filegroup({
    srcs: [Smithers.glob(`${commentsDir}/**/*.md`)],
    cwd
  })

  const lint = Smithers.Shell.Test({
    shell: `smithers-comments check --mode ${mode} --dir ${commentsDir}`,
    data: [sources, sidecars]
  })

  const virtualFiles = Smithers.Generate({
    command: `smithers-comments render --mode ${mode} --dir ${commentsDir} --out ${virtualOutDir}`,
    data: [sources, sidecars],
    changes: [`${virtualOutDir}/**`]
  })

  const materialize = Smithers.Materialize(virtualFiles)

  return {
    sources,
    sidecars,
    lint,
    virtualFiles,
    materialize
  }
}
