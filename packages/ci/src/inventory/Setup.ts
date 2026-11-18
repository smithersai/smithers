/**
 * The rule that reads a setup action: an action whose job is to put a tool
 * on the CI machine.
 *
 * Such a step means "this job needs `<tool>`, at this version when one is
 * given". Nothing is downloaded for it: where the job is replayed the tool is
 * looked for on the machine, the job runs when it is there, and the job is
 * listed with the tool to install when it is not.
 *
 * An action is a setup action when its name, the last part of its path with
 * a closing `-action` left off, has one of these forms:
 *
 * | Name               | Example                                   | Tool     |
 * | ------------------ | ----------------------------------------- | -------- |
 * | `setup-<tool>`     | `actions/setup-node`, `ruby/setup-ruby`   | `<tool>` |
 * | `<tool>-setup`     | `bufbuild/buf-setup-action`               | `<tool>` |
 * | `install-<tool>`   | `snok/install-poetry`                     | `<tool>` |
 * | `<tool>-installer` | `DeterminateSystems/nix-installer-action` | `<tool>` |
 * | `<tool>-toolchain` | `dtolnay/rust-toolchain`                  | `<tool>` |
 *
 * A `<tool>` that names nothing (`action`, `cli`) is the owner of the
 * action: `pnpm/action-setup` sets up `pnpm`. Four actions set a tool up
 * under another name and are listed in `otherNames`.
 *
 * The version is the input `<tool>-version`, `<tool>_version`, `version` or
 * `toolchain`, whichever comes first.
 *
 * @since 0.1.0
 */

import { asScalar, isRecord } from "./Values.ts"

/**
 * One tool a setup action puts on the machine. `version` is the text of the
 * input that asks for one, as written.
 *
 * @category models
 * @since 0.1.0
 */
export interface SetupTool {
  readonly name: string
  readonly version?: string
}

/**
 * What a setup action stands for. `command` is what it also runs when an
 * input asks for it, such as installing the packages a lockfile names.
 * `problem` says what it does that was not read; a job with one is not run.
 *
 * @category models
 * @since 0.1.0
 */
export interface Setup {
  readonly tools: ReadonlyArray<SetupTool>
  readonly command?: string
  readonly problem?: string
}

/** Actions that set a tool up under a name the rule does not read. */
const otherNames: ReadonlyMap<string, string> = new Map([
  ["actions-rs/toolchain", "rust"],
  ["jdx/mise-action", "mise"],
  ["subosito/flutter-action", "flutter"],
  ["taiki-e/install-action", ""]
])

/** Actions the name rule matches that put no tool on the machine: they only keep a cache. */
const noTool: ReadonlySet<string> = new Set(["gradle/actions/setup-gradle"])

/** Words in the place of a tool that name none; the owner of the action names it then. */
const noName: ReadonlySet<string> = new Set(["action", "actions", "cli", "tool", "tools", "toolchain"])

/** Other spellings of a tool's name, so one tool has one name. */
const spellings: ReadonlyMap<string, string> = new Map([
  ["golang", "go"],
  ["nodejs", "node"],
  ["python3", "python"],
  ["rustup", "rust"],
  ["rust-toolchain", "rust"],
  ["homebrew", "brew"]
])

const forms = [/^setup-(.+)$/, /^(.+)-setup$/, /^install-(.+)$/, /^(.+)-installer$/, /^(.+)-toolchain$/]

const named = (tool: string): string => spellings.get(tool) ?? tool

/** The tool an action's name says it sets up, or `undefined` when its name says no such thing. */
const toolOf = (action: string): string | undefined => {
  const other = otherNames.get(action)
  if (other !== undefined) return other
  const parts = action.split("/")
  const owner = (parts[0] as string).toLowerCase()
  const name = (parts.at(-1) as string).toLowerCase().replace(/-action$/, "")
  for (const form of forms) {
    const tool = form.exec(name)?.[1]
    if (tool !== undefined) return named(noName.has(tool) ? owner.replace(/-actions?$/, "") : tool)
  }
  return undefined
}

/** The tools `taiki-e/install-action` installs: its `tool` input, a list separated by commas, each `name@version`. */
const listed = (inputs: Record<string, unknown>): ReadonlyArray<SetupTool> =>
  (asScalar(inputs["tool"]) ?? "").split(",").flatMap((entry) => {
    const [name, version] = entry.trim().split("@")
    if (name === undefined || name === "") return []
    return [version === undefined || version === "" ? { name } : { name, version }]
  })

const versionOf = (tool: string, inputs: Record<string, unknown>, ref: string | undefined): string | undefined => {
  for (const input of [`${tool}-version`, `${tool}_version`, "version", "toolchain"]) {
    const value = asScalar(inputs[input])
    if (value !== undefined && value !== "") return value
  }
  // `dtolnay/rust-toolchain@1.85.0` names the version where other actions name their own release.
  return tool === "rust" && ref !== undefined && !/^(?:master|main|v\d+)$/.test(ref) ? ref : undefined
}

const isOn = (value: unknown): boolean => value === true || value === "true"
const isOff = (value: unknown): boolean => value === undefined || value === null || value === false || value === "false"

/** What an input makes the action run besides setting its tool up. */
const alsoRuns = (action: string, inputs: Record<string, unknown>): Pick<Setup, "command" | "problem"> => {
  if (action === "ruby/setup-ruby" && !isOff(inputs["bundler-cache"])) {
    // The action installs the gems into the checkout, never into the machine's own gem directory.
    return isOn(inputs["bundler-cache"]) && inputs["working-directory"] === undefined
      ? { command: "bundle config set --local path vendor/bundle\nbundle install --jobs 4" }
      : { problem: "installs gems in a way that was not read (bundler-cache)" }
  }
  if (action === "pnpm/action-setup" && !isOff(inputs["run_install"])) {
    return isOn(inputs["run_install"])
      ? { command: "pnpm install" }
      : { problem: "installs packages with its own arguments (run_install)" }
  }
  return {}
}

/**
 * Reads a `uses:` value and its `with:` inputs. The answer is `undefined`
 * for an action that is not a setup action, and for a local or container
 * action, whose name says nothing about what it does.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const readSetup = (uses: string, inputs: unknown): Setup | undefined => {
  const [action, ref] = uses.split("@") as [string, string | undefined]
  if (action.startsWith(".") || action.includes(":") || !action.includes("/")) return undefined
  if (noTool.has(action)) return { tools: [] }
  const tool = toolOf(action)
  if (tool === undefined) return undefined
  const given = isRecord(inputs) ? inputs : {}
  if (tool === "") return { tools: listed(given) }
  const version = versionOf(tool, given, ref)
  return { tools: [version === undefined ? { name: tool } : { name: tool, version }], ...alsoRuns(action, given) }
}
