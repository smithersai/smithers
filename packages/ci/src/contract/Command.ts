/**
 * Contract 7: what a person types.
 *
 * The commands, flags and exit codes of `smithers-ci`. The docs describe this
 * surface and the command-line program implements it; neither adds a command
 * or flag that is not here.
 *
 * @since 0.1.0
 */

import type { Failure } from "./Parts.ts"

/**
 * The program's name on npm and on the command line.
 *
 * @category constants
 * @since 0.1.0
 */
export const name = "smithers-ci"

/**
 * Every command. The empty name is what `smithers-ci` runs with no command:
 * a read-only report that writes nothing to the repository.
 *
 * @category constants
 * @since 0.1.0
 */
export const commands = {
  "": "Measure today's CI, replay past commits, and print the speedup. Writes nothing to the repository.",
  apply: "Write the Smithers workspace, target files and CI workflow the report was measured with.",
  inventory: "Print what the repository's CI does today.",
  replay: "Replay past commits and print the replay report."
} as const

/**
 * Every flag, with the commands that accept it and its default.
 *
 * @category constants
 * @since 0.1.0
 */
export const flags = {
  commits: { on: ["", "replay"], default: "20", help: "How many past commits to replay." },
  mode: { on: ["", "replay"], default: "normal", help: "normal, fast, or both." },
  jobs: { on: ["", "replay"], default: "", help: "Most targets to run at once; the default is the machine's." },
  cache: { on: ["", "replay", "apply"], default: "", help: "URL of a shared cache." },
  targets: {
    on: ["", "replay"],
    default: "",
    help:
      "Smithers build patterns to replay, separated by commas, on a repository that already builds with Smithers build; the default is what its CI runs."
  },
  out: { on: ["", "replay"], default: "", help: "Also write the report as an HTML file here." },
  json: { on: ["", "inventory", "replay"], default: "false", help: "Print the document as JSON." }
} as const

/**
 * Exit codes. `failed` is a step that could not finish; it is never reported
 * as `mismatch`.
 *
 * @category constants
 * @since 0.1.0
 */
export const exitCodes = {
  ok: 0,
  mismatch: 1,
  usage: 2,
  unsupported: 3,
  failed: 4
} as const

/**
 * What each exit code means.
 *
 * @category constants
 * @since 0.1.0
 */
export const exitCodeHelp = {
  ok: "The command finished.",
  mismatch: "A replayed target's verdict in a mode differs from its baseline verdict.",
  usage: "The command line was wrong: an unknown command or flag, or a bad value.",
  unsupported: "The repository uses something Smithers CI cannot run yet.",
  failed: "A step of the command could not finish."
} as const satisfies Record<keyof typeof exitCodes, string>

/**
 * The exit code for each reason a part fails.
 *
 * @category constants
 * @since 0.1.0
 */
export const failureExitCodes = {
  unsupported: 3,
  "not-a-repository": 2,
  "command-failed": 4,
  "invalid-document": 4,
  "model-unavailable": 4
} as const satisfies Record<Failure["code"], number>

/**
 * Rules that hold for every command.
 *
 * @category constants
 * @since 0.1.0
 */
export const syntax = {
  value: "A flag's value is the next argument, as in `--commits 5`. `--json` takes no value.",
  help: "`--help` and `-h` are accepted on every command and print its commands and flags."
} as const

/**
 * The contract document `--json` prints, for each command that accepts it.
 *
 * @category constants
 * @since 0.1.0
 */
export const documents = {
  "": "ReplayReport",
  inventory: "Inventory",
  replay: "ReplayReport"
} as const

/**
 * Environment variables the program reads. A value is never printed.
 *
 * @category constants
 * @since 0.1.0
 */
export const environment = {
  SMITHERS_CACHE_TOKEN: "The token sent to the shared cache that `--cache` names.",
  AI_GATEWAY_API_KEY:
    "The key for Jev, the judge fast mode asks. Without it, fast mode asks the model this machine is signed in to."
} as const

/**
 * Where a repository's own Smithers workspace is, in the order Smithers build
 * looks. `apply` exits `unsupported` and writes nothing when one exists: the
 * repository's CI is already its targets, and there is nothing to convert.
 * `apply` also never writes over a build file it did not generate.
 *
 * @category constants
 * @since 0.1.0
 */
export const applyRefuses = [".smithers/WORKSPACE.ts", "WORKSPACE.ts"] as const

/**
 * Lines `apply` adds to the repository's `.gitignore` when they are absent:
 * where Smithers build keeps its local cache.
 *
 * @category constants
 * @since 0.1.0
 */
export const applyIgnores = [".flows"] as const
