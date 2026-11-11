/**
 * The overridable flows the install ships as packaged defaults and the files
 * each one carries: its entry and the source modules beside it.
 *
 * `.smithers/flows/coding/build.mjs` compiles these bytes into the deployed host and
 * `provisionBuiltins` writes them under the host's policy root, so discovery
 * measures the same closure, and the same execution digest, on every host.
 */
export const builtinDefaults = ["todo", "learning", "review"] as const

/** Whether a POSIX path under a default's own directory ships with that default. */
export const shipsWithDefault = (relative: string): boolean =>
  relative === "flow.ts" || /^src\/(?:[\w.-]+\/)*[\w.-]+\.ts$/.test(relative)
