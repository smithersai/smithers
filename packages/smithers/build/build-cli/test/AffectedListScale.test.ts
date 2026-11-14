/**
 * `affected --list` explains a selection in space that grows with the roots
 * plus the changed files, never with their product. On a 3,948-root
 * repository the old per-(root, file) records reached 432 MB for 120 files and
 * passed V8's 512 MB string limit from 160 files on, so `--list` crashed.
 */
import { expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import { type ListGraph, samePackageGraph, sharedDependencyGraph } from "./helpers/AffectedListGraph.ts"

const ROOTS = 1000
const FILES = 100

const measure = (graph: ListGraph): number => {
  const explained = Affected.select(graph.index, ["//..."], graph.paths, { explain: true })
  // The selection itself stays complete and exact: every root, nothing else.
  expect(explained.targets.map((target) => target.label)).toEqual(graph.labels)
  return JSON.stringify(explained).length
}

/**
 * Checks `size` against `bound` at (R,F), (2R,F), (R,2F) and (2R,2F), and
 * that the interaction term S(2R,2F) - S(2R,F) - S(R,2F) + S(R,F), which is
 * the coefficient of any roots-times-files term times R*F, stays under 5% of
 * S(R,F): linear output leaves only label-width noise there.
 */
const linear = (
  graph: (roots: number, files: number) => ListGraph,
  bound: (roots: number, files: number) => number
) => {
  const base = measure(graph(ROOTS, FILES))
  expect(base).toBeLessThan(bound(ROOTS, FILES))
  const moreFiles = measure(graph(ROOTS, 2 * FILES))
  const moreRoots = measure(graph(2 * ROOTS, FILES))
  const both = measure(graph(2 * ROOTS, 2 * FILES))
  expect(moreFiles).toBeLessThan(bound(ROOTS, 2 * FILES))
  expect(moreRoots).toBeLessThan(bound(2 * ROOTS, FILES))
  expect(both).toBeLessThan(bound(2 * ROOTS, 2 * FILES))
  expect(Math.abs(both - moreRoots - moreFiles + base)).toBeLessThan(base * 0.05)
}

/**
 * 1,024 bytes of envelope, 200 bytes per root (its target row, its source
 * row, and its edge or set reference), and 400 bytes per changed file (its
 * `files` entry and its one change record).
 */
const bound = (roots: number, files: number): number => 1024 + 200 * roots + 400 * files

it("explains 1,000 roots sharing one dependency over 100 changed files in linear space", () => {
  linear(sharedDependencyGraph, bound)
})

it("explains 1,000 roots in one package, each a direct source of every changed file, in linear space", () => {
  linear((roots, files) => samePackageGraph(roots, files), bound)
})

/**
 * Half the roots also declare an own changed file, so there are R/2 more
 * files and R/2 distinct per-root change sets. The bound adds 400 bytes per
 * own file (a `files` entry, its `package` change and its `declared-input`
 * change) and 32 bytes per root for that root's extra set: one integer index
 * in the source row and a one-integer set.
 */
const mixedBound = (roots: number, files: number): number => bound(roots, files) + 400 * (roots / 2) + 32 * roots

it("explains 1,000 same-package roots with distinct own changes per root in linear space", () => {
  linear((roots, files) => samePackageGraph(roots, files, true), mixedBound)
})
