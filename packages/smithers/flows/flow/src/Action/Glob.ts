/**
 * Bazel-style workspace-relative file glob declarations.
 *
 * @since 0.1.0
 */

import { FileSet } from "@smthrs/plan"

const { Glob, matchesGlob, matchesPattern, Pattern } = FileSet
type Glob = FileSet.Glob

export { Glob, matchesGlob, matchesPattern, Pattern }
export type { Glob as Type }
