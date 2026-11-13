/**
 * Named reusable filesystem declaration groups.
 *
 * @since 0.1.0
 */

import { FileSet } from "@smthrs/plan"

const { Filegroup, makeFilegroup } = FileSet
type Filegroup = FileSet.Filegroup
export { Filegroup }
export type { Filegroup as Type }
/**
 * Creates a named filegroup.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = makeFilegroup
