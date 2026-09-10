import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as GraphBuildError from "../src/GraphBuildError.ts"
import * as Plan from "../src/Plan.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const api = read("../docs/api.md")
const readme = read("../README.md")
const troubleshooting = read("../docs/troubleshooting.md")
const planValue = read("../docs/concepts/plan-value.md")
const index = read("../src/index.ts")

const tableCodes = (section: string): ReadonlyArray<string> =>
  [...section.matchAll(/^\| `([a-z_]+)`\s+\|/gm)].map((match) => match[1]!).filter((code) => code !== "code")

const planErrorCodes = Plan.PlanError.fields.code.literals
const graphBuildCodes = GraphBuildError.GraphBuildErrorCode.literals
const namespaces = [...index.matchAll(/^export \* as (\w+) from/gm)].map((match) => match[1]!)
const words = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve"
]

describe("reference docs", () => {
  it("the PlanError table lists every code the schema carries", () => {
    const section = api.split("### Plan.PlanError")[1]!.split("\n### ")[0]!
    expect(tableCodes(section)).toEqual([...planErrorCodes])
    for (const code of planErrorCodes) expect(troubleshooting).toContain(`### ${code}`)
  })

  it("the GraphBuildErrorCode table lists every code the schema carries", () => {
    const section = api.split("### GraphBuildError.GraphBuildErrorCode")[1]!.split("\n## ")[0]!
    expect(tableCodes(section)).toEqual([...graphBuildCodes])
    for (const code of graphBuildCodes) expect(troubleshooting).toMatch(new RegExp(`### ${code}\\b|\`${code}\``))
  })

  it("the README names invalid_plan and unstable_callback beside the refusal codes", () => {
    const section = readme.split("## When it refuses")[1]!.split("\n## ")[0]!
    expect(section).toContain("`invalid_plan`")
    expect(section).toContain("`unstable_callback`")
  })

  it("the root export catalog counts and lists every namespace the barrel exports", () => {
    expect(api).toContain(`exports ${words[namespaces.length]} modules from its root entry point`)
    const catalog = api.split("| Namespace")[1]!.split("\n\n")[0]!
    const listed = tableCodes(catalog.replace(/`(\w+)`/g, (_, name: string) => `\`${name.toLowerCase()}\``))
    expect([...listed].sort()).toEqual(namespaces.map((name) => name.toLowerCase()).sort())
  })

  it("README and plan-value warn that payloads persist as plaintext identity material", () => {
    for (const text of [readme, planValue, api]) {
      expect(text).toMatch(/hashed into (?:the|its) step\s+key and (?:persisted|written) verbatim as plaintext/)
      expect(text).toMatch(/resolved at dispatch/)
    }
  })
})
