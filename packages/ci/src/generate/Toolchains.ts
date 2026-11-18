/**
 * Which version of each tool the generated workflow installs.
 *
 * The generated workflow has one job, so it installs one version of a tool.
 * An inventory can hold several: a workflow sets one up, a file such as
 * `.nvmrc` pins another, and a matrix runs each variant under its own. An
 * inventory does not say which job or variant a version belongs to, so the
 * versions this choice leaves out are named in the notes, never dropped
 * without a word.
 *
 * @since 0.1.0
 */

import { type Ci, generatedWorkflow, type Toolchain } from "../contract/Inventory.ts"

/**
 * The tools to install, one entry per tool in name order, and a note for
 * each version left out.
 *
 * @category models
 * @since 0.1.0
 */
export interface Choice {
  readonly toolchains: ReadonlyArray<Toolchain>
  readonly notes: ReadonlyArray<string>
}

const workflows = ".github/workflows/"

// A version still holding `${{ }}` is worked out when the workflow runs: it is not a version to install.
const versionOf = (toolchain: Toolchain): string | undefined =>
  toolchain.version === undefined || toolchain.version.includes("${{") ? undefined : toolchain.version

/**
 * Chooses one version of each tool.
 *
 * What the CI's own files set up comes first, then a file that pins the
 * tool. The first entry with a version wins. A workflow that is not CI is
 * asked only for a tool nothing else names.
 *
 * Two things are noted: a version as trusted as the chosen one that differs
 * from it, and a CI workflow that sets a tool up with no version the
 * inventory holds, which is how a version taken from the matrix arrives.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const chooseToolchains = (inventory: Ci): Choice => {
  const ciFiles = new Set(inventory.jobs.map((job) => job.file))
  const ciWorkflows = new Set(
    inventory.jobs.filter((job) => job.source === "github-actions").map((job) => job.file)
  )
  const rank = (toolchain: Toolchain): number =>
    ciFiles.has(toolchain.source) ? 0 : toolchain.source.startsWith(workflows) ? 2 : 1
  const key = (toolchain: Toolchain): string =>
    `${toolchain.name}\n${rank(toolchain)}\n${toolchain.source}\n${toolchain.version ?? ""}`
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
    if (current === undefined || (versionOf(current) === undefined && versionOf(toolchain) !== undefined)) {
      chosen.set(toolchain.name, toolchain)
    }
  }

  const notes: Array<string> = []
  for (const toolchain of own) {
    const kept = chosen.get(toolchain.name) as Toolchain
    const keptVersion = versionOf(kept)
    const runs = keptVersion === undefined
      ? "the version its setup action installs by default"
      : `${kept.name} ${keptVersion} (${kept.source})`
    const version = versionOf(toolchain)
    if (version === undefined && ciWorkflows.has(toolchain.source)) {
      notes.push(
        `${toolchain.name}: ${toolchain.source} sets it up with a version this inventory does not hold: none is ` +
          `written, or it is worked out when the workflow runs, as a matrix value is. Every target runs with ${runs}.`
      )
    }
    if (version !== undefined && version !== keptVersion && rank(toolchain) === rank(kept)) {
      notes.push(
        `${toolchain.name} ${version} (${toolchain.source}) is not installed: every target runs with ${runs}.`
      )
    }
  }

  return {
    toolchains: [...chosen.values()]
      .sort((left, right) => left.name < right.name ? -1 : 1)
      .map((toolchain) => {
        const version = versionOf(toolchain)
        return version === undefined
          ? { name: toolchain.name, source: toolchain.source }
          : { name: toolchain.name, source: toolchain.source, version }
      }),
    notes
  }
}
