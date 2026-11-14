/**
 * The synthetic graphs behind the `affected --list` scale suite and benchmark,
 * built from real targets into a real {@link PackageIndex} over an absent root.
 */
import { Smithers as S } from "@smthrs/targets"
import type * as Target from "@smthrs/targets/Target"
import * as Path from "node:path"
import { PackageIndex } from "../../src/PackageIndex.ts"

export interface ListGraph {
  readonly index: PackageIndex
  /** The changed paths. */
  readonly paths: ReadonlyArray<string>
  /** Every label `//...` selects, in the index's order. */
  readonly labels: ReadonlyArray<string>
}

const workspace = S.Workspace("affected-list", {
  repository: "git+https://example.invalid/affected-list.git",
  cache: S.Cache({ directory: ".flows" })
})

/** An index over `packages`, each a package path and its targets by key. */
export const indexOf = (packages: ReadonlyMap<string, Record<string, Target.AnyTarget>>): PackageIndex =>
  PackageIndex.make({
    root: Path.resolve("test/fixtures/affected-list-absent"),
    workspace,
    factory: undefined,
    packages: [...packages].map(([packagePath, targets]) => ({
      file: packagePath === "" ? "PACKAGE.ts" : `${packagePath}/PACKAGE.ts`,
      packagePath,
      value: S.Package({ targets })
    }))
  })

const listGraph = (packages: ReadonlyMap<string, Record<string, Target.AnyTarget>>, paths: ReadonlyArray<string>) => {
  const index = indexOf(packages)
  return { index, paths, labels: index.resolve("//...").map((row) => row.label) }
}

/**
 * `roots` packages each hold one Filegroup that depends on a single shared
 * Filegroup, whose glob owns every changed file. Every root is selected by
 * every file through the same dependency.
 */
export const sharedDependencyGraph = (roots: number, files: number): ListGraph => {
  const shared = S.Filegroup({ srcs: [S.glob("//shared/**")] })
  const packages = new Map<string, Record<string, Target.AnyTarget>>([["shared", { srcs: shared }]])
  for (let root = 0; root < roots; root++) {
    packages.set(`pkg${root}`, { root: S.Filegroup({ srcs: [S.file(`//pkg${root}/own.txt`), shared] }) })
  }
  return listGraph(packages, Array.from({ length: files }, (_, file) => `shared/src/file${file}.ts`))
}

/**
 * `roots` Shell.Test targets in one package, the shape of a compiler suite
 * with one test per case. A changed file under the package directory selects
 * every root directly with a `package` cause, so every root is a source.
 * With `mixed`, each even root also declares its own file, which changes too.
 */
export const samePackageGraph = (roots: number, files: number, mixed = false): ListGraph => {
  const targets: Record<string, Target.AnyTarget> = {}
  const owned: Array<string> = []
  for (let root = 0; root < roots; root++) {
    targets[`t${root}`] = S.Shell.Test({ shell: "true", data: [S.file(`own/${root}.txt`)] })
    if (mixed && root % 2 === 0) owned.push(`cases/own/${root}.txt`)
  }
  return listGraph(
    new Map([["cases", targets]]),
    [...Array.from({ length: files }, (_, file) => `cases/src/file${file}.ts`), ...owned]
  )
}
