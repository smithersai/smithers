/*
 * The case index: every ./cases/*.case.ts default-exports a showcase(). Read
 * from disk so adding a case is adding one file.
 */
import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { ShowcaseCase } from "./showcase"

export const CASES_DIR = join(__dirname, "cases")

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const loadCases = (): ReadonlyArray<ShowcaseCase> => {
  const cases = readdirSync(CASES_DIR)
    .filter(file => file.endsWith(".case.ts"))
    .sort()
    .map(file => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const definition = (require(join(CASES_DIR, file)) as { default: ShowcaseCase }).default
      if (`${definition.id}.case.ts` !== file) throw new Error(`${file} declares id ${definition.id}`)
      if (!ID.test(definition.id)) throw new Error(`${file}: an id is lowercase words joined by dashes`)
      return definition
    })
  return [...cases].sort((a, b) => a.order - b.order)
}
