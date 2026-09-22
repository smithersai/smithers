/**
 * Targets for the terminal UI: the typecheck and the transcript suite.
 *
 * The suite replays a recorded cell run through the transcript fold, so a
 * change to `AgentEvent` that the screen no longer understands fails here.
 * It runs under Bun because the renderer, `@opentui/core`, requires Bun.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "apps/tui"

/** The app, its recorded fixture, and the suite beside them. */
const sources = [
  Smithers.glob("//apps/tui/src/**/*.ts"),
  Smithers.glob("//apps/tui/src/**/*.tsx"),
  Smithers.glob("//apps/tui/test/**/*")
]

/**
 * Checks the app and its suite against the package tsconfig.
 *
 * @since 1.0.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The transcript suite.
 *
 * @since 1.0.0
 * @category test
 */
// Coverage policy: assertion-only for the Bun suite until a whole-source
// denominator is measured. See scripts/repo-contract/README.md.
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["test"]),
  srcs: sources,
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, unitTests }
})
