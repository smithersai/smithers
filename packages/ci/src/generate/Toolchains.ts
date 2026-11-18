/**
 * Which version of each tool every step runs under.
 *
 * A job of the CI that sets a tool up runs under the version it names, once
 * per matrix variant when the version is a matrix value. A step whose job
 * names none runs under the repository's version of the tool. Versions this
 * choice leaves out are named in the notes, never dropped without a word.
 *
 * @since 0.1.0
 */

import { type Ci, expand, generatedWorkflow, hostOf, type Job, type Toolchain, treeOf } from "../contract/Inventory.ts"
import { type Variant, variantsOf } from "./Expressions.ts"

/**
 * The repository's version of each tool, the notes, and the version one
 * variant of a job runs under.
 *
 * @category models
 * @since 0.1.0
 */
export interface Choice {
  /** One entry per tool, in name order: what a step whose job names no version runs under. */
  readonly toolchains: ReadonlyArray<Toolchain>
  readonly notes: ReadonlyArray<string>
  /** The same tools, in the same order, with the versions this variant of this job names. */
  readonly toolsOf: (job: Job, variant: Variant) => ReadonlyArray<Toolchain>
}

// A version still holding `${{ }}` differs by variant, or is worked out when the workflow runs.
const literalOf = (toolchain: Toolchain): string | undefined =>
  toolchain.version === undefined || toolchain.version.includes("${{") ? undefined : toolchain.version

const filledOf = (toolchain: Toolchain, variant: Variant): string | undefined => {
  if (toolchain.version === undefined) return undefined
  const version = expand(toolchain.version, variant)
  return version === "" || version.includes("${{") ? undefined : version
}

/**
 * Chooses the version of each tool.
 *
 * The repository's version comes from what the CI's jobs set up, then from a
 * file that pins the tool. The first entry with a version wins, and a matrix
 * value counts when nothing names a plain version. A workflow that is not CI
 * is asked only for a tool nothing else names. The jobs of one shared working
 * tree run on one machine, so a version one of them names is the repository's.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const chooseToolchains = (inventory: Ci): Choice => {
  const jobs = new Map(inventory.jobs.map((job) => [job.id, job]))
  const ownerOf = (toolchain: Toolchain): Job | undefined => {
    const job = toolchain.job === undefined ? undefined : jobs.get(toolchain.job)
    return job === undefined || treeOf(job) !== undefined ? undefined : job
  }
  const rank = (toolchain: Toolchain): number =>
    ownerOf(toolchain) !== undefined ? 0 : toolchain.job === undefined || jobs.has(toolchain.job) ? 1 : 2
  const key = (toolchain: Toolchain): string =>
    [toolchain.name, rank(toolchain), toolchain.source, toolchain.version ?? "", toolchain.job ?? ""].join("\n")
  // The generated workflow's own setup steps are read back by the next inventory. They are this generator's
  // choice, never the repository's: counting them would make a second run write a different workflow.
  const ordered = inventory.toolchains
    .filter((toolchain) => toolchain.source !== generatedWorkflow)
    .sort((left, right) => key(left) < key(right) ? -1 : 1)

  // A workflow that is not CI is asked only for a tool nothing else names, and what it leaves out is no loss.
  const own = ordered.filter((toolchain) => rank(toolchain) < 2)
  const named = new Set(own.map((toolchain) => toolchain.name))
  const chosen = new Map<string, Toolchain>()
  for (const toolchain of [...own, ...ordered.filter((other) => !named.has(other.name))]) {
    const current = chosen.get(toolchain.name)
    if (current === undefined || (literalOf(current) === undefined && literalOf(toolchain) !== undefined)) {
      chosen.set(toolchain.name, toolchain)
    }
  }

  const byJob = new Map<string, Array<Toolchain>>()
  for (const toolchain of own) {
    const job = ownerOf(toolchain)
    if (job !== undefined) byJob.set(job.id, [...(byJob.get(job.id) ?? []), toolchain])
  }
  const filledFor = (job: Job, name: string, variant: Variant): Toolchain | undefined =>
    (byJob.get(job.id) ?? []).find((toolchain) => toolchain.name === name && filledOf(toolchain, variant) !== undefined)

  // A tool only matrix values name still needs a version for the steps whose jobs do not set it up. Targets for
  // Windows never run, so their versions are not a candidate.
  const fallbackOf = (name: string): string | undefined =>
    own.flatMap((toolchain) => {
      const job = ownerOf(toolchain)
      return toolchain.name !== name || job === undefined
        ? []
        : variantsOf(job)
          .filter((variant) => hostOf(job.runsOn === undefined ? undefined : expand(job.runsOn, variant)) !== "win32")
          .flatMap((variant) => filledOf(toolchain, variant) ?? [])
    })[0]

  const repository = [...chosen.values()]
    .sort((left, right) => left.name < right.name ? -1 : 1)
    .map((toolchain): Toolchain => {
      const version = literalOf(toolchain) ?? fallbackOf(toolchain.name)
      return version === undefined
        ? { name: toolchain.name, source: toolchain.source }
        : { name: toolchain.name, source: toolchain.source, version }
    })
  const toolsOf = (job: Job, variant: Variant): ReadonlyArray<Toolchain> =>
    repository.map((tool) => {
      const named = filledFor(job, tool.name, variant)
      return named === undefined ? tool : {
        name: tool.name,
        source: named.source,
        version: filledOf(named, variant) as string
      }
    })

  const notes: Array<string> = []
  for (const toolchain of own) {
    const { name } = toolchain
    const kept = repository.find((tool) => tool.name === name) as Toolchain
    const runs = kept.version === undefined
      ? "the version its setup action installs by default"
      : `${name} ${kept.version} (${kept.source})`
    const job = ownerOf(toolchain)
    if (job === undefined) {
      const version = literalOf(toolchain)
      if (version !== undefined && version !== kept.version && rank(chosen.get(name) as Toolchain) === 1) {
        notes.push(
          `${name} ${version} (${toolchain.source}) is not installed: a step whose job names no version runs with ${runs}.`
        )
      }
      continue
    }
    const variants = variantsOf(job)
    if (variants.every((variant) => filledOf(toolchain, variant) === undefined)) {
      notes.push(`${name}: ${job.id} sets it up with no version smithers-ci can read, so its steps run with ${runs}.`)
    }
    for (const variant of variants) {
      const version = filledOf(toolchain, variant)
      const used = filledFor(job, name, variant) as Toolchain
      if (version !== undefined && version !== filledOf(used, variant)) {
        notes.push(
          `${name} ${version} is not installed for ${job.id}: the job sets ${name} up twice, and its steps run with ` +
            `${name} ${filledOf(used, variant)}.`
        )
      }
    }
  }

  return { toolchains: repository, notes, toolsOf }
}
