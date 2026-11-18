/**
 * Reads `turbo.json`: each task is a job that runs `turbo run <task>`.
 *
 * @since 0.1.0
 */

import { parse, type ParseError } from "jsonc-parser"
import { longRunning } from "../contract/Inventory.ts"
import { addStep, draft, fileProblem, note, type Parsed } from "./Draft.ts"
import type { Runner } from "./PackageJson.ts"
import { asStrings, isRecord, shellQuote } from "./Values.ts"

/**
 * Reads the root Turborepo file, which may hold comments. `needs` lists the
 * tasks this file defines. `turbo run` itself runs the rest of `dependsOn`:
 * `^task`, and tasks a package defines.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const readTurbo = (file: string, text: string, runner: Runner): Parsed => {
  const errors: Array<ParseError> = []
  const config: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isRecord(config)) return fileProblem(file, "malformed-file", "it is not a JSON object")
  const tasks = config["tasks"] ?? config["pipeline"]
  if (!isRecord(tasks)) return fileProblem(file, "malformed-file", "it has no tasks")
  const jobs = Object.entries(tasks).map(([name, raw]) => {
    const task = isRecord(raw) ? raw : {}
    const dependsOn = asStrings(task["dependsOn"] ?? []) ?? []
    const job = draft({
      id: `${file}:${name}`,
      source: "turbo",
      file,
      name,
      needs: dependsOn.filter((need) => Object.hasOwn(tasks, need)).map((need) => `${file}:${need}`)
    })
    if (task["persistent"] === true) note(job, longRunning, `task ${name} keeps running until it is stopped`)
    addStep(job, { where: `task ${name}`, command: `${runner.exec} turbo run ${shellQuote(name)}` })
    return job
  })
  return { jobs, toolchains: [{ name: "turbo", source: file }], unsupported: [] }
}
