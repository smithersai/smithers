/**
 * The unit suite's preload: refuses a Bun or Node below the root `engines`
 * floors before any test runs, so an old toolchain reads as one line instead
 * of test failures.
 */
import { requireToolchain } from "../../../scripts/require-toolchain.mjs"

requireToolchain()
