/**
 * Targets for the shared agent contract: the typecheck and the unit suite.
 *
 * Both apps import this package. The suite uses the same Vitest runner and
 * test directory convention as the other contract packages.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/rpc"

/** The contract sources both apps import. */
const sources = Smithers.glob("//packages/rpc/src/**/*.ts")

/**
 * plue's failure registry as this package vendors it, plus the script that
 * refreshes it. Declared as sources so a refreshed artifact invalidates the
 * suite that checks it: the drift test reads the JSON off disk and imports the
 * script's digest function, neither of which the `*.ts` glob above sees.
 */
const failureCodes = [
  Smithers.glob("//packages/rpc/src/plue-failure-codes.json"),
  Smithers.glob("//packages/rpc/scripts/*.mjs")
]

/**
 * Checks the contract against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: [sources, Smithers.glob("test/**/*.ts"), ...failureCodes],
  deps: [],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The unit suite: everything under `test/`.
 *
 * @since 0.1.0
 * @category test
 */
const unitTests = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [sources, ...failureCodes],
  deps: [],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

const lint = Smithers.EsLint({
  sources: [sources],
  configs: [Smithers.file("eslint.config.js"), Smithers.file("//eslint.jsdoc.js")],
  deps: [],
  maxWarnings: 0,
  fix: false,
  cwd
})
const fmt = Smithers.Dprint({
  sources: [Smithers.glob("**/*.{ts,json,md,js}")],
  config: Smithers.file("dprint.json"),
  deps: [],
  fix: false,
  cwd
})

/**
 * Build, lint, formatting, and test gates for the public wire contracts.
 *
 * @since 1.0.0
 * @category packages
 */
export const Package = Smithers.Package({
  targets: { check, unitTests, lint, fmt }
})
