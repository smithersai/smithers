/**
 * Contract 7: what a person types.
 *
 * The commands, flags and exit codes of `smithers-ci`. The docs describe this
 * surface and the command-line program implements it; neither adds a command
 * or flag that is not here.
 *
 * @since 0.1.0
 */

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
  out: { on: ["", "replay"], default: "", help: "Also write the report as an HTML file here." },
  json: { on: ["", "inventory", "replay"], default: "false", help: "Print the document as JSON." }
} as const

/**
 * Exit codes.
 *
 * @category constants
 * @since 0.1.0
 */
export const exitCodes = {
  ok: 0,
  mismatch: 1,
  usage: 2,
  unsupported: 3
} as const
