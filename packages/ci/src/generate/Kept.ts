/**
 * The steps of the generated workflow that send a job's results out as the
 * repository's own workflow did (`Inventory.KeptStep`): an upload of an
 * artifact, a coverage report, test results.
 *
 * Such a step runs on the runner, after `smthrs ci`, once for each variant of
 * its job that the generated workflow runs. Smithers build leaves that job's
 * checkout where the step before it finds it (`keptDirectory`), with what each
 * of its steps left, also when every step reused its result. The step before
 * the kept one puts that checkout in the runner's workspace, where the action
 * reads its inputs, and the kept step runs as the repository wrote it, with
 * the variant's matrix values written in.
 *
 * @since 0.1.0
 */

import { expand, type Job, type KeptStep, runnerOf } from "../contract/Inventory.ts"
import { split } from "../inventory/Expression.ts"
import { type Variant, variantKey } from "./Expressions.ts"
import type { StepPlan } from "./Steps.ts"
import * as Yaml from "./Yaml.ts"

/**
 * One place a kept step runs: the job, its variant, the machine Smithers build
 * runs its targets on, and the condition of the generated matrix entry that
 * runs them, such as `matrix.os == 'ubuntu-latest'`.
 *
 * @category models
 * @since 0.1.0
 */
export interface KeptPlace {
  readonly job: Job
  readonly variant: Variant
  readonly machine: string
  readonly entry: string
}

/**
 * Where Smithers build leaves the checkout of the `index`th kept machine on
 * the runner when its run ends.
 *
 * @category constants
 * @since 0.1.0
 */
export const keptDirectory = (index: number): string => `\${{ runner.temp }}/smthrs-kept/${index}`

/**
 * The variable that tells Smithers build which machines to keep when the
 * run ends, and where: a JSON object from a machine's name to a directory.
 *
 * @category constants
 * @since 0.1.0
 */
export const keepVariable = "SMTHRS_KEEP_MACHINES"

/**
 * One kept step at one place, with the number of the directory its
 * machine's checkout is kept in.
 *
 * @category models
 * @since 0.1.0
 */
export interface KeptRun {
  readonly step: KeptStep
  readonly place: KeptPlace
  readonly index: number
}

/**
 * Every kept step of `jobs` at each place the generated workflow runs its
 * job: once for each variant that has a target on a machine, under the
 * matrix entry that runs it. Each machine has a directory of its own.
 *
 * @category rendering
 * @since 0.1.0
 * @throws {never}
 */
export const keptRuns = (
  jobs: ReadonlyArray<Job>,
  plan: Pick<StepPlan, "targets" | "legs">
): ReadonlyArray<KeptRun> => {
  const runs: Array<KeptRun> = []
  let index = 0
  for (const job of jobs) {
    const kept = job.kept ?? []
    const seen = new Set<string>()
    for (const target of plan.targets) {
      if (kept.length === 0 || target.job !== job.id || target.machine === undefined) continue
      const key = variantKey(target.variant)
      if (seen.has(key)) continue
      seen.add(key)
      const leg = plan.legs.find((each) => each.labels.includes(target.label))
      const runner = runnerOf(job, target.variant) ?? ""
      const entry = leg !== undefined
        ? `matrix.leg == ${literal(leg.id)}`
        : runner.includes(",")
        ? `join(matrix.os, ',') == ${literal(runner)}`
        : `matrix.os == ${literal(runner)}`
      const place = { job, variant: target.variant, machine: target.machine, entry }
      for (const step of kept) runs.push({ step, place, index })
      index += 1
    }
  }
  return runs
}

/**
 * The value of `keepVariable` for `runs`: each machine once, with its
 * directory on the runner.
 *
 * @category rendering
 * @since 0.1.0
 * @throws {never}
 */
export const keepValue = (runs: ReadonlyArray<KeptRun>): string =>
  JSON.stringify(Object.fromEntries(runs.map((run) => [run.place.machine, keptDirectory(run.index)])))

// A matrix value written into an expression as GitHub reads text.
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`

// Every `matrix.<key>` an expression reads, outside its strings, becomes the variant's value. The generated
// workflow's own matrix holds other keys.
const fillExpression = (expression: string, variant: Variant): string =>
  expression.split(/('(?:[^']|'')*')/).map((piece, at) =>
    at % 2 === 1 ? piece : piece.replace(
      /(?<![\w.])matrix\.([\w.-]+)/gi,
      (_whole, key: string) => {
        const found = Object.keys(variant).find((held) => held.toLowerCase() === key.toLowerCase())
        return literal(found === undefined ? "" : variant[found] as string)
      }
    )
  ).join("")

// A text with each `${{ }}` given the variant's matrix values.
const fillText = (text: string, variant: Variant): string => {
  const { pieces, rest } = split(expand(text, variant))
  return pieces.map(([before, expression]) => `${before}\${{ ${fillExpression(expression, variant)} }}`).join("") +
    rest
}

// A condition, written with or without `${{ }}`, as an expression.
const conditionOf = (text: string | undefined): string => {
  if (text === undefined) return "success()"
  const { pieces, rest } = split(text)
  const [only] = pieces
  return pieces.length === 1 && only !== undefined && only[0] === "" && rest.trim() === "" ? only[1] : text
}

const filled = (values: Readonly<Record<string, string>>, variant: Variant): ReadonlyArray<Yaml.Entry> =>
  Object.entries(values).map(([name, held]) => Yaml.entry(name, fillText(held, variant)))

// A value GitHub reads as a boolean or a number where the step's own keys want one.
const typed = (text: string): Yaml.Value =>
  text === "true" || text === "false" ? text === "true" : /^[0-9]+$/.test(text) ? Number(text) : text

// The variant as a person reads it: ` (python 3.12)`, or nothing.
const variantName = (variant: Variant): string => {
  const values = Object.keys(variant).sort().map((key) => `${key} ${variant[key]}`)
  return values.length === 0 ? "" : ` (${values.join(", ")})`
}

/**
 * The two steps that run one kept step at one place: the one that puts the
 * job's checkout in the runner's workspace, then the kept step. Both run
 * only on the matrix entry that runs the job's targets, under the kept
 * step's own condition, so `if: always()` still runs after a failed step.
 *
 * @category rendering
 * @since 0.1.0
 * @throws {never}
 */
export const keptSteps = (step: KeptStep, place: KeptPlace, index: number): ReadonlyArray<Yaml.Item> => {
  const { entry, job, variant } = place
  const condition = `\${{ ${entry} && (${fillExpression(conditionOf(step.if), variant)}) }}`
  const where = `${job.id}${variantName(variant)}`
  const directory = keptDirectory(index)
  return [
    Yaml.item(Yaml.mapping([
      Yaml.entry("name", `Files of ${where}`),
      Yaml.entry("if", condition),
      Yaml.entry(
        "run",
        `find "$GITHUB_WORKSPACE" -mindepth 1 -maxdepth 1 -exec rm -rf {} +\ncp -a "${directory}/." "$GITHUB_WORKSPACE/"\n`
      )
    ])),
    Yaml.item(Yaml.mapping([
      Yaml.entry("name", `${step.name === undefined ? step.uses : fillText(step.name, variant)}: ${where}`),
      ...(step.id === undefined ? [] : [Yaml.entry("id", `${step.id}-${index}`)]),
      Yaml.entry("if", condition),
      Yaml.entry("uses", step.uses),
      ...(step.with === undefined ? [] : [Yaml.entry("with", Yaml.mapping(filled(step.with, variant)))]),
      ...(step.env === undefined ? [] : [Yaml.entry("env", Yaml.mapping(filled(step.env, variant)))]),
      ...(step.continueOnError === undefined
        ? []
        : [Yaml.entry("continue-on-error", typed(fillText(step.continueOnError, variant)))]),
      ...(step.timeoutMinutes === undefined
        ? []
        : [Yaml.entry("timeout-minutes", typed(fillText(step.timeoutMinutes, variant)))])
    ]))
  ]
}
