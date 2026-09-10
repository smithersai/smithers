/**
 * The package's own prose, pinned to the barrel it describes.
 *
 * `README.md`'s Public API table, its Limits table, and `docs/api.md`'s list of
 * flow modules are hand-written. The rc.0 changelog once promised a generator
 * that failed when the README drifted from the barrel; the generator was
 * removed with the documentation restructuring and nothing replaced it, so
 * the Limits table came to name six caps by identifiers the package does not
 * export and to call `shell_command`'s field `timeout` where the schema says
 * `timeout_ms`. Each check here reads the prose and the source and refuses
 * the disagreement.
 */
import * as Fs from "node:fs"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Std from "../src/index.ts"

const packageRoot = Path.join(Path.dirname(fileURLToPath(import.meta.url)), "..")
const readme = Fs.readFileSync(Path.join(packageRoot, "README.md"), "utf8")
const api = Fs.readFileSync(Path.join(packageRoot, "docs", "api.md"), "utf8")

/** The rows of the Markdown table under `heading`, split into trimmed cells. */
const tableUnder = (text: string, heading: string): ReadonlyArray<ReadonlyArray<string>> => {
  const start = text.indexOf(`\n${heading}\n`)
  if (start < 0) throw new Error(`no section ${heading}`)
  const section = text.slice(start + heading.length + 2).split(/\n## /)[0] ?? ""
  return section
    .split("\n")
    .filter((line) => line.startsWith("| `") || line.startsWith("| HTTP"))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()))
}

/** The names a struct or union-of-structs schema accepts at the top level. */
const fieldsOf = (schema: unknown): ReadonlyArray<string> => {
  const candidate = schema as { fields?: Record<string, unknown>; members?: ReadonlyArray<unknown> }
  if (candidate.fields !== undefined) return Object.keys(candidate.fields)
  if (candidate.members !== undefined) return candidate.members.flatMap(fieldsOf)
  return []
}

const barrel = Std as Record<string, Record<string, unknown>>
const flowModules = Object.keys(barrel).filter((module) => "flow" in barrel[module]!)
const moduleByFlowName = new Map(
  flowModules.map((module) => [barrel[module]!["name"] as string, module] as const)
)

describe("README.md", () => {
  const rows = tableUnder(readme, "## Public API")
  const documentedModules = rows.map((row) => row[0]!.replaceAll("`", ""))

  it("names every namespace the barrel exports, and nothing else", () => {
    expect([...documentedModules].sort()).toEqual(Object.keys(Std).sort())
  })

  it("lists at least every runtime export of each namespace", () => {
    for (const row of rows) {
      const module = row[0]!.replaceAll("`", "")
      const listed = row[1]!.split(",").map((cell) => cell.trim().replaceAll("`", "")).filter((cell) => cell.length > 0)
      const missing = Object.keys(barrel[module] ?? {}).filter((key) => !listed.includes(key))
      expect(missing, `${module} row omits ${missing.join(", ")}`).toEqual([])
    }
  })

  it("names every limit by a public identifier holding the stated value, or by no identifier", () => {
    for (const [limit, value] of tableUnder(readme, "## Limits")) {
      const identifier = /^`([A-Za-z]+)\.([A-Z_]+)`$/.exec(limit!)
      if (identifier === null) {
        expect(limit, `${limit} reads like an identifier but is not \`Module.CONSTANT\``).not.toMatch(/`[A-Z_]{4,}`/)
        continue
      }
      const [, module, constant] = identifier
      const actual = barrel[module!]?.[constant!]
      expect(actual, `${limit} is not exported from the barrel`).toBeTypeOf("number")
      const stated = value!.includes("MiB")
        ? Number(value!.replace(/\s*MiB.*/, "")) * 1024 * 1024
        : Number(value!.replaceAll(",", "").replace(/\s.*$/, ""))
      expect(actual, `${limit} is ${actual}, README says ${value}`).toBe(stated)
    }
  })

  it("describes each timeout's default by an input field the flow accepts", () => {
    for (const [, , appliesTo] of tableUnder(readme, "## Limits")) {
      const claim = /one `([a-z_-]+)` call with no `(\w+)`/.exec(appliesTo!)
      if (claim === null) continue
      const [, flowName, field] = claim
      const module = moduleByFlowName.get(flowName!)
      expect(module, `${flowName} is not a registered flow`).toBeDefined()
      const fields = fieldsOf(barrel[module!]!["Input"])
      expect(fields, `${flowName} has no input field ${field}`).toContain(field)
    }
  })
})

describe("docs/api.md", () => {
  it("lists exactly the modules that declare a flow", () => {
    const paragraph = /The modules are ([\s\S]*?)\./.exec(api)
    expect(paragraph).not.toBeNull()
    const listed = [...paragraph![1]!.matchAll(/`(\w+)`/g)].map((match) => match[1]!)
    expect([...listed].sort()).toEqual([...flowModules].sort())
    const count = /^(\w+) modules declare a flow/m.exec(api)?.[1]
    const words = [
      "Zero",
      "One",
      "Two",
      "Three",
      "Four",
      "Five",
      "Six",
      "Seven",
      "Eight",
      "Nine",
      "Ten",
      "Eleven",
      "Twelve",
      "Thirteen",
      "Fourteen",
      "Fifteen",
      "Sixteen",
      "Seventeen",
      "Eighteen",
      "Nineteen",
      "Twenty"
    ]
    expect(count).toBe(words[flowModules.length])
  })
})
