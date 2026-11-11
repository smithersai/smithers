/**
 * Source groups shared by repository test declarations without importing the
 * CLI's build and review configuration.
 *
 * @since 1.0.0
 */

import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/build/build-cli"
const declaration = Smithers.file("SourceInputs.ts")

/**
 * CLI source identities used by in-process protocol consumers.
 *
 * @category build
 * @since 1.0.0
 */
export const sourceFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("src/**/*.ts"), Smithers.glob("src/**/*.js"), declaration],
  cwd
})

/**
 * Real workspace fixtures imported by integration suites.
 *
 * @category test
 * @since 1.0.0
 */
export const testHelpers = Smithers.Filegroup({
  srcs: [Smithers.glob("test/helpers/**/*.ts"), declaration],
  cwd
})
