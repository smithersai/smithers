/**
 * The toolchain declaration shared by target tests.
 *
 * Every tool-running target takes a package manager, and the targets that evaluate
 * an inline program take a runtime. Tests assert on the argv a target produces, so
 * they need one fixed declaration rather than one per file: two files declaring
 * different versions would produce different argv for the same target and hide a
 * regression behind a fixture difference.
 */
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"

/** The runtime every test target runs under. */
export const runtime = Runtime.Node({ version: ">=26.4.0" })

/** The package manager every test target runs its tool through. */
export const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime })
