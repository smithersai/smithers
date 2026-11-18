/**
 * A job while it is being read, and what every source does to one.
 *
 * @since 0.1.0
 */

import type { Inventory, Job, Source, Step, Toolchain, Unsupported } from "../contract/Inventory.ts"
import { hasSecretValue, isLiteralSecret, scrub } from "./Secrets.ts"

/**
 * What one file contributes to an inventory.
 *
 * @category models
 * @since 0.1.0
 */
export interface Parsed {
  readonly jobs: ReadonlyArray<Job>
  readonly toolchains: ReadonlyArray<Toolchain>
}

/**
 * A job whose steps and unsupported list are still growing.
 *
 * @category models
 * @since 0.1.0
 */
export interface Draft extends Job {
  readonly steps: Array<Step>
  readonly unsupported: Array<Unsupported>
}

/**
 * Starts a job. Lists left out are empty.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const draft = (
  fields: Pick<Job, "id" | "source" | "file" | "name"> & Partial<Pick<Job, "needs" | "triggers" | "matrix" | "runsOn">>
): Draft => ({ needs: [], triggers: [], matrix: [], ...fields, steps: [], unsupported: [] })

/**
 * Records something a job does that cannot be reproduced. The file comes first
 * so the entry stands alone. A repeated entry is kept once.
 *
 * @category mutations
 * @since 0.1.0
 * @throws {never}
 */
export const note = (job: Draft, feature: string, reason: string): void => {
  const detail = `${job.file}: ${reason}`
  if (!job.unsupported.some((entry) => entry.feature === feature && entry.detail === detail)) {
    job.unsupported.push({ feature, detail })
  }
}

/**
 * One command to add to a job. `where` names it in anything recorded about it.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepInput {
  readonly where: string
  readonly command: string
  readonly cwd?: string
  readonly env?: ReadonlyMap<string, string>
  readonly secrets?: ReadonlyArray<string>
  readonly name?: string | undefined
}

/**
 * Adds a step numbered after the steps before it. A command holding a value
 * shaped like a credential is not added, and such an environment value is kept
 * by name only.
 *
 * @category mutations
 * @since 0.1.0
 * @throws {never}
 */
export const addStep = (job: Draft, input: StepInput): void => {
  const command = input.command.trim()
  if (command === "") return note(job, "empty-command", `${input.where} has no command`)
  if (hasSecretValue(command)) return note(job, "secret-value", `${input.where} holds a value shaped like a secret`)
  const env: Array<[string, string]> = []
  const secrets = new Set(input.secrets)
  for (const [name, value] of input.env ?? []) {
    if (isLiteralSecret(name, value)) {
      secrets.add(name)
      note(job, "secret-value", `${input.where} sets ${name} to a literal value; only its name is kept`)
    } else {
      env.push([name, value])
    }
  }
  job.steps.push({
    id: `${job.id}:${job.steps.length + 1}`,
    command,
    cwd: input.cwd ?? "",
    env: Object.fromEntries(env),
    secrets: [...secrets],
    ...(input.name === undefined ? {} : { name: input.name })
  })
}

/**
 * A job standing for a whole file that could not be read as jobs, so the
 * reason has a place in the inventory.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const fileProblem = (id: string, source: Source, file: string, feature: string, reason: string): Parsed => {
  const job = draft({ id, source, file, name: id })
  note(job, feature, reason)
  return { jobs: [job], toolchains: [] }
}

/**
 * Joins what each file contributed: jobs in reading order, each tool and file
 * pair once in a stable order, with nothing shaped like a credential left in
 * any field.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const assemble = (repository: string, commit: string, parts: ReadonlyArray<Parsed>): Inventory => {
  const toolchains = new Map<string, Toolchain>()
  for (const tool of parts.flatMap((part) => part.toolchains)) {
    toolchains.set(JSON.stringify([tool.name, tool.source, tool.version]), tool)
  }
  return scrub({
    version: 1,
    repository,
    commit,
    toolchains: [...toolchains.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, tool]) => tool),
    jobs: parts.flatMap((part) => part.jobs)
  })
}
