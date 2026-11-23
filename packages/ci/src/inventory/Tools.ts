/**
 * What an inventory means on one machine: which CI jobs it can run, which
 * need a tool it lacks, and which tools it has at another version than the
 * CI asks for. Nothing here looks at the machine; `Machine.vibe` does, and
 * passes what it found.
 *
 * @since 0.1.0
 */

import type * as Duration from "effect/Duration"
import {
  ci,
  ciJobs,
  expand,
  hostOf,
  type Inventory,
  isSelfHosted,
  type Job,
  missingTool,
  otherSystem,
  runnerOf,
  selfHosted,
  type Toolchain,
  type ToolVersion,
  unknownRunner,
  type Unsupported
} from "../contract/Inventory.vibe"

/**
 * The machine an inventory is read for: its operating system in Node's
 * names, and the `PATH` its tools are looked for on, which is this
 * process's unless one is given.
 *
 * @category models
 * @since 0.1.0
 */
export interface Machine {
  readonly host: string
  readonly path?: string | undefined
  /** How long a program may take to print its version: 30 seconds unless given. */
  readonly patience?: Duration.Input | undefined
}

/**
 * This machine.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const thisMachine = (): Machine => ({ host: process.platform })

/**
 * A tool found on the machine: the program that answers for it, and the
 * version it reports when it reports one.
 *
 * @category models
 * @since 0.1.0
 */
export interface Found {
  readonly program: string
  readonly version?: string | undefined
}

/** Tools whose program has another name. One of the programs is enough. */
const programs: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["python", ["python3", "python"]],
  ["rust", ["cargo"]],
  ["nextest", ["cargo-nextest"]],
  ["beam", ["erl"]],
  ["buildx", ["docker"]],
  ["compose", ["docker"]],
  ["foundry", ["forge"]],
  ["xcode", ["xcodebuild"]],
  ["llvm", ["clang"]],
  ["haskell", ["ghc"]],
  ["graalvm", ["native-image"]],
  ["android", ["sdkmanager"]],
  ["chrome", ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]],
  ["r", ["Rscript"]]
])

/**
 * The programs that show a tool is on the machine, in the order they are
 * looked for. A tool is its own program unless it is known under another.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const programsOf = (tool: string): ReadonlyArray<string> => programs.get(tool) ?? [tool]

/**
 * The version in what a program prints for `--version`: the first number
 * with a dot in it.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const versionIn = (printed: string): string | undefined => /\d+\.\d+(?:\.\d+)*/.exec(printed)?.[0]

const older = (have: ReadonlyArray<number>, want: ReadonlyArray<number>): boolean => {
  for (const [index, number] of want.entries()) {
    const had = have[index] ?? 0
    if (had !== number) return had < number
  }
  return false
}

/**
 * True when the version found is not the one asked for. A version asked for
 * is compared by the numbers it gives: `22` and `22.x` are any 22. `^1.22`
 * is any 1 from 1.22 on, and `~3.4.1` any 3.4 from 3.4.1 on. A name such as
 * `latest` or `stable`, and a range such as `>=3.9`, name no numbers to
 * compare, so they never differ.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const differs = (asked: string, found: string): boolean => {
  const match = /^\s*v?([\^~]?)(\d+(?:\.\d+)*)/.exec(asked)
  if (match === null) return false
  const want = (match[2] as string).split(".").map(Number)
  const have = found.split(".").map(Number)
  const unlike = (count: number): boolean => want.slice(0, count).some((number, index) => number !== have[index])
  if (match[1] === "") return unlike(want.length)
  return unlike(match[1] === "^" ? 1 : 2) || older(have, want)
}

const systemNames: Readonly<Record<string, string>> = { linux: "Linux", darwin: "macOS", win32: "Windows" }

/**
 * An operating system as a person names it.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const systemName = (host: string): string => systemNames[host] ?? host

const variantsOf = (job: Job): ReadonlyArray<Readonly<Record<string, string>>> =>
  job.matrix.length === 0 ? [{}] : job.matrix

/**
 * Where a job's variants run: the systems of those on a machine anyone can have, the variants of them that run on
 * `host`, and the self-hosted runners of the rest. A runner that names no system is here.
 */
const placesOf = (job: Job, host: string) => {
  const systemOf = (variant: Readonly<Record<string, string>>): string => hostOf(runnerOf(job, variant)) ?? host
  // A variant whose runner the workflow file does not give runs nowhere a replay knows.
  const hosted = variantsOf(job).filter((variant) =>
    !isSelfHosted(runnerOf(job, variant)) && !unknownRunner(runnerOf(job, variant))
  )
  return {
    systems: [...new Set(hosted.map(systemOf))],
    here: hosted.filter((variant) => systemOf(variant) === host),
    ownRunners: [...new Set(variantsOf(job).map((variant) => runnerOf(job, variant)).filter(isSelfHosted))]
  }
}

/**
 * True when a job has a variant that runs on `host`.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const runsOn = (job: Job, host: string): boolean => placesOf(job, host).here.length > 0

/** The versions of one tool a job asks for in the variants that run here, each once. */
const askedOf = (
  tools: ReadonlyArray<Toolchain>,
  here: ReadonlyArray<Readonly<Record<string, string>>>
): ReadonlyArray<string> => [
  ...new Set(tools.flatMap((tool) => {
    const version = tool.version
    // A matrix value no variant here gives stays as written, and is no version.
    return version === undefined
      ? []
      : here.map((variant) => expand(version, variant)).filter((filled) => !filled.includes("${{"))
  }))
]

/** The CI jobs that run unless the machine says otherwise, by id: `Inventory.ci` before the machine is asked. */
const runnable = (inventory: Inventory): ReadonlySet<string> => new Set(ci(inventory).jobs.map((job) => job.id))

/**
 * The tools a machine must be asked about: every tool set up by a CI job
 * that nothing else stops and that has a variant on `host`, each once. A job
 * left out for another reason is not asked about: installing its tool would
 * not make it run.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const neededTools = (inventory: Inventory, host: string): ReadonlyArray<string> => {
  const runs = runnable(inventory)
  const here = new Set(
    inventory.jobs.filter((job) => runs.has(job.id) && runsOn(job, host)).map((job) => job.id)
  )
  return [
    ...new Set(inventory.toolchains.flatMap((tool) => tool.job !== undefined && here.has(tool.job) ? [tool.name] : []))
  ]
}

/**
 * The inventory as `host` can run it. `found` holds each tool of
 * `neededTools` that is on the machine.
 *
 * - A CI job with no variant on `host` gets one `other-system` entry for each
 *   system it runs on, so it is left out and listed. A job with a variant
 *   here is untouched: the replay leaves its other variants out one by one.
 * - A CI job that nothing else stops and that sets up a tool the machine
 *   lacks gets one `missing-tool` entry for the tool, whose detail is what to
 *   install.
 * - A tool the machine has at another version than such a job asks for is
 *   listed in `toolVersions`, and the job still runs.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const onMachine = (inventory: Inventory, host: string, found: ReadonlyMap<string, Found>): Inventory => {
  const inCi = new Set(ciJobs(inventory).map((job) => job.id))
  const runs = runnable(inventory)
  const versions: Array<ToolVersion> = []
  const jobs = inventory.jobs.map((job): Job => {
    if (!inCi.has(job.id)) return job
    const { here, ownRunners, systems } = placesOf(job, host)
    if (here.length === 0) {
      const elsewhere = systems.map((system): Unsupported => ({
        feature: otherSystem,
        detail: `${job.file}: ${job.name} runs on ${systemName(system)}; this machine is ${systemName(host)}`
      }))
      const own = ownRunners.map((runner): Unsupported => ({
        feature: selfHosted,
        detail: `${job.file}: ${job.name} runs on the self-hosted runner ${runner}`
      }))
      return { ...job, unsupported: [...job.unsupported, ...elsewhere, ...own] }
    }
    if (!runs.has(job.id)) return job
    const tools = inventory.toolchains.filter((tool) => tool.job === job.id)
    const missing: Array<Unsupported> = []
    for (const name of new Set(tools.map((tool) => tool.name))) {
      const asked = askedOf(tools.filter((tool) => tool.name === name), here)
      const have = found.get(name)
      if (have === undefined) {
        missing.push({ feature: missingTool, detail: asked.length === 1 ? `${name} ${asked[0]}` : name })
        continue
      }
      const version = have.version
      if (version === undefined) continue
      for (const wanted of asked) {
        if (differs(wanted, version)) versions.push({ job: job.id, tool: name, asked: wanted, found: version })
      }
    }
    return missing.length === 0 ? job : { ...job, unsupported: [...job.unsupported, ...missing] }
  })
  return { ...inventory, jobs, ...(versions.length === 0 ? {} : { toolVersions: versions }) }
}
