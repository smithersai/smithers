/**
 * The import-rules macro: deterministic, model-free import and call rules a
 * package declares in its own PACKAGE.ts.
 *
 * A rule such as "no Effect in a `.tsx` component" is mechanical, so a lint
 * target holds it instead of a reviewer. A package lists its rules with a
 * `because` each, and the macro declares one target that checks them with the
 * TypeScript compiler API. See `ImportRulesCheck` for the rule kinds and what
 * each one sees.
 *
 * Rules that hold for every package, such as the ban on substitute durable
 * runtimes, are not declared here: the repository-wide dependency-boundary
 * gate (`contracts/check-dependency-boundaries.mjs`) enforces them, including
 * for packages with no PACKAGE.ts.
 *
 * @since 0.1.0
 */

import { Smithers } from "@smthrs/targets"
import type { ImportRule } from "./ImportRulesCheck.ts"
import { sourceExtensions, validateRules } from "./ImportRulesCheck.ts"

/**
 * Options accepted by {@link ImportRules}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The workspace-relative directory of the declaring package, for example
   * `apps/mvp`. Every rule's `files` glob resolves against it, and the check
   * runs in it.
   */
  readonly cwd: string
  /** The rules, in the order the report numbers them. */
  readonly rules: ReadonlyArray<ImportRule>
}

/**
 * The target {@link ImportRules} returns.
 *
 * @category models
 * @since 0.1.0
 */
export type ImportRulesTarget = ReturnType<typeof Smithers.NodeTest>

/** The program the target runs, and the modules it loads from this package. */
const program = [
  "//packages/repo-targets/scripts/import-rules.mjs",
  "//packages/repo-targets/src/ImportRulesCheck.ts",
  "//packages/repo-targets/src/ImportAnalysis.ts"
] as const

/**
 * Declares one `test` target that fails when a source in the package breaks
 * one of `rules`.
 *
 * The rules are checked when the declaration is made: an empty list, an
 * unknown kind or key, a missing `because`, or a `files` glob that is not
 * package-relative throws a `TypeError` naming the rule. At execution, every
 * rule must cover at least one source; otherwise the target exits 2, naming
 * every empty rule's index, kind, patterns and reason. The target runs
 * `packages/repo-targets/scripts/import-rules.mjs` in `cwd` with the rules as
 * JSON, keys on every source of the package and on the checking modules, and
 * is not cached, because the TypeScript parser it loads is not part of its
 * key. It prints one line per violation,
 * `- <cwd>/<file>:<line> <usage> (<kind>). <because>`, and exits 1; with none
 * it prints the rule and file counts and exits 0.
 *
 * It is a `test`-kind `NodeTest`, so `smithers-build test` and `ci` plan it.
 * A `lint`-kind `Shell.Diff` would copy the whole workspace into a scratch
 * directory on every check.
 *
 * @example
 * ```ts
 * import { ImportRules } from "@smthrs/repo-targets"
 * import type { ImportRule } from "@smthrs/repo-targets"
 *
 * const importRules: ReadonlyArray<ImportRule> = [{
 *   kind: "forbid",
 *   files: ["src/**\/*.tsx"],
 *   modules: ["effect", "effect/**"],
 *   because: "Components render; the machine runs Effect. See apps/mvp/AGENTS.md, \"State (flux)\"."
 * }]
 *
 * const imports = ImportRules({ cwd: "apps/mvp", rules: importRules })
 * ```
 *
 * @category macros
 * @since 0.1.0
 */
export const ImportRules = (options: Options): ImportRulesTarget => {
  const rules = validateRules(options.rules)
  const cwd = options.cwd
  if (cwd === "" || cwd.startsWith("/") || cwd.split("/").includes("..")) {
    throw new TypeError(`ImportRules cwd "${cwd}" must be a workspace-relative package directory`)
  }
  const [script, ...modules] = program
  return Smithers.NodeTest({
    runner: Smithers.entrypoint(Smithers.file(script), [cwd, JSON.stringify(rules)]),
    srcs: [
      Smithers.glob(`//${cwd}/**/*{${sourceExtensions.join(",")}}`),
      Smithers.file(script),
      ...modules.map((path) => Smithers.file(path))
    ],
    deps: [],
    cwd
  })
}
