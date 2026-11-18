/**
 * Contract 7: what a person types.
 *
 * The commands, flags and exit codes of `smithers-ci`. The docs describe this
 * surface and the command-line program implements it; neither adds a command
 * or flag that is not here.
 *
 * @since 0.1.0
 */

import type { Failure, GeneratedFile } from "./Parts.ts"

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
  jobs: {
    on: ["", "replay"],
    default: "",
    help: "Most jobs to run at once, in the baseline and in each mode; the default is this machine's core count."
  },
  cache: {
    on: ["", "replay", "apply"],
    default: "",
    help: "URL of a shared cache, with no user name or password; its token is read from SMITHERS_CACHE_TOKEN."
  },
  targets: {
    on: ["", "replay"],
    default: "",
    help:
      "Smithers build patterns to replay, separated by commas, on a repository that already builds with Smithers build; the default is what its CI runs."
  },
  "no-trial": {
    on: ["", "replay"],
    default: "false",
    help: "Replay every job, without first running the CI once to leave out the jobs that fail on this machine."
  },
  "no-apply-check": {
    on: ["", "replay"],
    default: "false",
    help:
      "Skip the run of the newest commit with the files apply writes committed, which finds a step that fails over one of them."
  },
  cold: {
    on: ["", "replay"],
    default: "false",
    help:
      "Count from an empty cache: skip the run before the first counted commit that fills the caches a CI run finds."
  },
  reruns: {
    on: ["", "replay"],
    default: "1",
    help: "How many times a failed step runs again to tell a flaky failure from a broken one; 0 turns it off."
  },
  "stall-minutes": {
    on: ["", "replay"],
    default: "10",
    help: "Stop a step whose processes use no CPU and print nothing for this many minutes; it counts as failed."
  },
  out: { on: ["", "replay"], default: "", help: "Also write the report as an HTML file here." },
  json: { on: ["", "inventory", "replay"], default: "false", help: "Print the document as JSON." },
  "allow-root": {
    on: ["", "replay"],
    default: "false",
    help: "Replay even when run as root, where a past commit's commands could change this machine."
  },
  check: {
    on: ["apply"],
    default: "false",
    help: "Write nothing; name each file apply would change, and exit 1 if there is one."
  },
  "allow-docker": {
    on: ["", "replay", "apply"],
    default: "false",
    help:
      "Take the jobs that run docker or podman too, and let a replayed step reach a container daemon, which can read and write every file of this machine."
  }
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
  mismatch:
    "A replayed target's verdict in a mode differs from its baseline verdict, or `apply --check` found a file `apply` would change. A flaky target, which passed on a rerun, agrees with a pass and does not make the exit code 1.",
  usage:
    "The command line was wrong: an unknown command or flag, a bad value, or a replay as root without --allow-root.",
  unsupported:
    "The repository cannot be replayed: it is not a Git repository with a commit, it uses something Smithers CI cannot run, or its CI does not pass on this machine.",
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
  "not-a-repository": 3,
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
  value:
    "A flag's value is the next argument, as in `--commits 5`. `--no-trial`, `--no-apply-check`, `--cold`, `--json`, `--allow-root`, `--check` and `--allow-docker` take no value.",
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
  PATH: "Where the program finds Node.js to run Smithers build, and `claude` for fast mode.",
  HOME: "Where fast mode finds this machine's Claude Code and Codex logins.",
  SMITHERS_CACHE_TOKEN: "The token sent to the shared cache that `--cache` names.",
  AI_GATEWAY_API_KEY:
    "The key for the model that predicts which tests a change cannot break. Without it, fast mode uses the model this machine is signed in to.",
  AI_GATEWAY_API_KEY_FILE: "A file that holds that key, read when `AI_GATEWAY_API_KEY` is empty.",
  ANTHROPIC_API_KEY: "When set, fast mode does not use this machine's Claude Code login. Unset it to use that login.",
  ANTHROPIC_API_KEY_FILE: "A file that holds that key, read when `ANTHROPIC_API_KEY` is empty.",
  CLAUDE_CONFIG_DIR: "Where Claude Code keeps its login, when that is not its default directory.",
  CODEX_HOME: "Where Codex keeps its login, when that is not `~/.codex`.",
  SMITHERS_OPENAI_AUTH: "`chatgpt` lets fast mode use this machine's Codex login.",
  OPENROUTER_API_KEY: "A key for OpenRouter, which fast mode uses when no subscription can answer.",
  OPENROUTER_API_KEY_FILE: "A file that holds that key, read when `OPENROUTER_API_KEY` is empty.",
  SMITHERS_ACCOUNT_POOL_URL: "The address of a Smithers account pool, which fast mode can use.",
  SMITHERS_ACCOUNT_POOL_KEY: "The key for that account pool.",
  SMITHERS_ACCOUNT_POOL_PROVIDERS: "The providers that account pool serves, separated by commas.",
  SMITHERS_EVALUATOR_BASE_URL: "Another address for the model, in place of the AI Gateway.",
  SMITHERS_MODEL_PROXY_URL: "A proxy that carries fast mode's requests to its model.",
  SMITHERS_MODEL_PROXY_PROVIDERS: "The providers that proxy carries, separated by commas.",
  HTTP_PROXY: "The proxy for fast mode's HTTP requests; `http_proxy` also works.",
  HTTPS_PROXY: "The proxy for fast mode's HTTPS requests; `https_proxy` also works.",
  NO_PROXY: "The hosts fast mode reaches without a proxy; `no_proxy` also works."
} as const

/**
 * Where a repository's own Smithers workspace is, in the order Smithers build
 * looks. `apply` exits `unsupported` and writes nothing when one exists: the
 * repository's CI is already its targets, and there is nothing to convert.
 *
 * `apply` checks every path before it writes any, and a refusal leaves
 * nothing written. It replaces a file only when the file is absent or is one
 * `smithers-ci` generated: it starts with the generated mark. That holds for
 * every generated path, the workflow included. It removes the files an
 * earlier version wrote at `PACKAGE.ts`, `.smithers/WORKSPACE.ts`,
 * `.smithers/ci-targets.json` and `.smithers/ci/NOT-REPRODUCED.md` when it
 * generated them, and refuses beside a root `PACKAGE.ts`, `PACKAGE.vibe` or
 * `.smithers/WORKSPACE.ts` the owner wrote. It also refuses a path whose real
 * location is outside the repository: a link in the path.
 *
 * @category constants
 * @since 0.1.0
 */
export const applyRefuses = [".smithers/WORKSPACE.ts", ".smithers/WORKSPACE.smithers", "WORKSPACE.ts"] as const

/**
 * The generated file Smithers build reads as the workspace declaration: the
 * written one at a place a workspace declaration has (`applyRefuses`), or
 * `undefined` when the files hold none, as for a repository with a workspace
 * of its own. A replay writes this one file beside its copy of the
 * repository, never into it, and names it to Smithers build, so the copy
 * holds the commit's files and nothing else.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const declarationOf = (files: ReadonlyArray<GeneratedFile>): GeneratedFile | undefined =>
  files.find((file) => file.written !== false && (applyRefuses as ReadonlyArray<string>).includes(file.path))

/**
 * Lines `apply` adds to the repository's root `.gitignore`: none. Smithers
 * build keeps its cache outside the checkout, so nothing of Smithers CI is
 * there to ignore, and `apply` leaves the file as the repository has it.
 *
 * @category constants
 * @since 0.1.0
 */
export const applyIgnores: ReadonlyArray<string> = []
