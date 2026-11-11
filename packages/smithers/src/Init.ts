/**
 * `smthrs init`: a tagged TypeScript flow and repository-scoped run state.
 * Existing flow entries and user-authored files are retained.
 * @since 1.0.0
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import * as CliError from "./CliError.ts"
import * as Environment from "./Environment.ts"
import * as Project from "./Project.ts"
import { starterSeats } from "./Providers.ts"

/**
 * The ignore rule run state needs.
 *
 * @category constants
 * @since 1.0.0
 */
export const ignoreRule = ".flows/"

/**
 * What one ignore-file edit did.
 *
 * @category models
 * @since 1.0.0
 */
export type IgnoreStatus = "created" | "updated" | "unchanged" | "skipped"

/**
 * Explains why a proposed flow name cannot be used by `init`.
 *
 * Reach for this before presenting a usage error. It accepts one portable path
 * segment from the documented character set and otherwise returns a sentence
 * safe to show to the operator without creating any project state.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const nameProblem = (name: string): string | undefined => {
  const reason = (): string =>
    `a flow name is one path segment of letters, digits, '-' and '_'; got ${JSON.stringify(name)}`
  if (
    name === "" ||
    isAbsolute(name) ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    /\p{Cc}/u.test(name) ||
    !/^[A-Za-z0-9_-]+$/.test(name)
  ) return reason()
  return undefined
}

/**
 * Whether a scaffold name passes {@link nameProblem}.
 *
 * Use this predicate when only a boolean is needed. Invalid input returns
 * `false`; callers that need the refusal sentence should use `nameProblem`.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export const isValidName = (name: string): boolean => nameProblem(name) === undefined

/**
 * Whether a directory is the root of a repository whose ignore file is worth
 * editing.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isRepository = (root: string, exists: (path: string) => boolean = existsSync): boolean =>
  exists(join(root, ".git")) || exists(join(root, ".jj"))

/** Whether an existing ignore file already covers `.flows/`. */
const alreadyIgnored = (contents: string): boolean =>
  contents.split("\n").map((line) => line.trim()).some((line) =>
    line === ".flows" || line === ".flows/" || line === "/.flows" || line === "/.flows/"
  )

/**
 * Adds `.flows/` to the repository ignore file, once.
 *
 * Outside a git or jj repository this reports `skipped` and writes nothing: a
 * `.gitignore` in a directory that is not a repository is litter.
 *
 * @category constructors
 * @since 1.0.0
 */
export const ensureIgnored = (root: string): IgnoreStatus => {
  if (!isRepository(root)) return "skipped"
  const file = join(root, ".gitignore")
  const block = `# Smithers run state\n${ignoreRule}\n`
  if (!existsSync(file)) {
    writeFileSync(file, block, "utf8")
    return "created"
  }
  const contents = readFileSync(file, "utf8")
  if (alreadyIgnored(contents)) return "unchanged"
  const separator = contents === "" || contents.endsWith("\n") ? "" : "\n"
  writeFileSync(file, `${contents}${separator}${block}`, "utf8")
  return "updated"
}

/**
 * The seat a scaffold declares, and the credential that chose it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Seat {
  /** The model seat id. */
  readonly seat: string
  /** The environment variable that resolves it. */
  readonly variable: string
  /** Whether that variable is set in the environment `init` read. */
  readonly resolved: boolean
}

/**
 * The seat `smthrs init` writes into the scaffold.
 *
 * Chooses from the same provider keys `smthrs doctor` reports, in that order.
 * With no key, the default seat is still declared so execution can name the
 * credential it needs. Credentials are never written into the generated flow.
 *
 * @category constructors
 * @since 1.0.0
 */
export const defaultSeat = (
  environment: Environment.Source
): Seat => {
  const chatgpt = Environment.read(environment, "SMITHERS_OPENAI_AUTH") === "chatgpt"
  for (const [variable, seat] of starterSeats) {
    if ((environment[variable] ?? "") !== "") return { seat, variable, resolved: true }
    if (variable === "OPENAI_API_KEY" && chatgpt) {
      return { seat, variable: "SMITHERS_OPENAI_AUTH", resolved: true }
    }
  }
  const [variable, seat] = starterSeats[0]!
  return { seat, variable, resolved: false }
}

/**
 * The scaffolded tagged flow and its ordinary model-backed action layer.
 * Dynamic strings are emitted as JavaScript literals, never executable source.
 * @category constructors
 * @since 1.0.0
 */
export const template = (name: string, seat: Seat): string => {
  const problem = nameProblem(name)
  if (problem !== undefined) throw new CliError.UsageError({ message: problem })
  return `import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import Instructions from "./prompt.mdx"

const Work = AgentAction.make(${JSON.stringify(`${name}/work`)}, {
  payload: { args: Schema.optional(Schema.String) },
  output: Schema.Struct({ summary: Schema.String }),
  // Change the seat to use another model. Credentials stay in the environment.
  seat: ${JSON.stringify(seat.seat)},
  prompt: Instructions
})

export const layer = Work.layer
export default Flow.make(${JSON.stringify(name)}, {
  description: "A starter Smithers flow.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*", "model:call:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  model: ${JSON.stringify(seat.seat)},
  payload: { args: Schema.optional(Schema.String) },
  success: Schema.Struct({ summary: Schema.String }),
  error: AgentAction.AgentFailure,
  body: Node.capture({ action: Work.name }, (input) => Work.call(input))
})
`
}

/**
 * What `smthrs init` created.
 *
 * @category models
 * @since 1.0.0
 */
export interface Scaffolded {
  readonly name: string
  readonly flowFile: string
  readonly created: boolean
  readonly gitignore: IgnoreStatus
  /** The state directory this project's runs will use. */
  readonly stateDirectory: string
  /** The model seat the scaffolded flow declares. */
  readonly seat: string
}

/**
 * Scaffolds `.smithers/flows/<name>/flow.ts` and ignores `.flows/`.
 *
 * An existing flow file is left exactly as it is: `init` is a starting point,
 * not an overwrite, and a second `init` in a project that already has flows
 * must not destroy one.
 *
 * @category constructors
 * @since 1.0.0
 */
export const scaffold = (
  root: string,
  name: string,
  environment: Environment.Source
): Scaffolded => {
  const problem = nameProblem(name)
  if (problem !== undefined) throw new CliError.UsageError({ message: problem })
  const flowsDirectory = Project.flowsDirectory(root)
  const directory = join(flowsDirectory, name)
  const stateDirectory = Project.stateDirectory(root)
  for (const path of [dirname(flowsDirectory), flowsDirectory, directory, stateDirectory]) {
    const stat = statIfPresent(path)
    if (stat !== undefined && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new CliError.Refused({
        fault: "user",
        code: "unsafe_scaffold_path",
        message: `Refusing scaffold path ${path}`
      })
    }
  }
  // lstat also sees dangling symlinks: no entry spelling may be overwritten.
  const entries = ["flow.ts", "flow.mdx", "SKILL.md"].map((entry) => join(directory, entry))
    .filter((path) => statIfPresent(path) !== undefined)
  if (entries.length > 1) {
    throw new CliError.Refused({
      fault: "user",
      code: "flow_conflict",
      message: `Flow ${name} has multiple entry files; retain one of flow.ts, flow.mdx or SKILL.md`
    })
  }
  const flowFile = entries[0] ?? join(directory, "flow.ts")
  const seat = defaultSeat(environment)
  const exists = entries.length > 0
  if (isRepository(root)) {
    const ignore = statIfPresent(join(root, ".gitignore"))
    if (ignore !== undefined && (!ignore.isFile() || ignore.isSymbolicLink())) {
      throw new CliError.Refused({ fault: "user", code: "unsafe_scaffold_path", message: "Refusing .gitignore path" })
    }
  }
  if (!exists) {
    mkdirSync(directory, { recursive: true })
    const content = {
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2024",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            allowImportingTsExtensions: true,
            allowArbitraryExtensions: true
          },
          include: ["flow.ts", "prompt.d.mdx.ts"]
        },
        null,
        2
      ) + "\n",
      "prompt.mdx": "{props.args ?? \"Summarize this project and suggest one small improvement.\"}\n",
      "prompt.d.mdx.ts":
        "import type { Component } from \"@smthrs/registry/Prompt\"\n\ndeclare const Instructions: Component<{ readonly args?: string }>\nexport default Instructions\n"
    }
    for (const [entry, text] of Object.entries(content)) {
      const path = join(directory, entry)
      const stat = statIfPresent(path)
      if (stat !== undefined && (!stat.isFile() || stat.isSymbolicLink())) {
        throw new CliError.Refused({
          fault: "user",
          code: "unsafe_scaffold_path",
          message: `Refusing scaffold path ${path}`
        })
      }
      if (stat === undefined) writeFileSync(path, text, { encoding: "utf8", flag: "wx" })
    }
    writeFileSync(flowFile, template(name, seat), { encoding: "utf8", flag: "wx" })
  }
  // The empty state directory is the project's anchor. `Project.root` treats
  // `.flows/` as proof on its own and `.smithers/flows/` only beside a project
  // marker, so a scaffold in a plain directory that is neither a package nor a
  // repository would otherwise resolve a different root from every
  // subdirectory, which is the one failure `init` exists to prevent.
  mkdirSync(stateDirectory, { recursive: true })
  return { name, flowFile, created: !exists, gitignore: ensureIgnored(root), stateDirectory, seat: seat.seat }
}

/**
 * The default flow name, taken from the project directory.
 *
 * @category constructors
 * @since 1.0.0
 */
export const defaultName = (root: string): string => {
  const base = root.split(/[/\\]/).filter((part) => part !== "").at(-1) ?? "flow"
  const slug = base.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-").replaceAll(/^-+|-+$/g, "")
  return slug === "" ? "flow" : slug
}

/** Reads entry metadata without following symlinks; only absence is ignored. */
const statIfPresent = (path: string) => {
  try {
    return lstatSync(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw cause
  }
}
