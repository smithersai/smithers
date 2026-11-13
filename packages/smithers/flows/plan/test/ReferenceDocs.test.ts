import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as GraphBuildError from "../src/GraphBuildError.ts"
import * as Node from "../src/Node.ts"
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
  "twelve",
  "thirteen"
]

describe("reference docs", () => {
  it("the package overview separates pure planning from persistence", () => {
    const overview = readme.split("## Install")[0]!
    const manifest = JSON.parse(read("../package.json")) as { description: string }
    expect(overview).toContain("performs no I/O at all")
    expect(overview).toContain("`@smthrs/plan-store`")
    expect(overview).not.toContain("records that graph in a SQLite store")
    expect(manifest.description).toContain("step-key compiler")
    expect(manifest.description).not.toMatch(/store|database|SQLite/)
  })

  it("the API and troubleshooting document the eager arm depth refusal", () => {
    const depth = api.split("### Node.maximumArmDepth")[1]?.split("\n### ")[0] ?? ""
    expect(depth).toContain(`const maximumArmDepth: ${Node.maximumArmDepth}`)
    for (const combinator of ["Node.branch", "Node.catch"]) expect(depth).toContain(`\`${combinator}\``)
    expect(depth).toContain("`graph_too_deep`")
    const raised = api.split("This package raises ")[1]!.split(".")[0]!
    expect(raised).toContain("`graph_too_deep`")
    const refusal = troubleshooting.split("### graph_too_deep")[1]?.split("\n### ")[0] ?? ""
    expect(refusal).toContain("`Node.maximumArmDepth`")
    expect(refusal).toContain("`@smthrs/flow`")
    expect(refusal).toContain("`@smthrs/core`")
    expect(refusal).toContain(`\`${Node.maximumArmDepth}\``)
    for (const combinator of ["Node.branch", "Node.catch"]) expect(refusal).toContain(`\`${combinator}\``)
    const notRaised = troubleshooting.split("### The codes this package does not raise")[1]!.split("\n## ")[0]!
    expect(notRaised).not.toContain("`graph_too_deep`")
  })

  it("InputRef JSDoc describes Pending as an ordering edge without a consumed value", () => {
    const inputRef = read("../src/KeyMaterial.ts").split("export const InputRef")[0]!
    expect(inputRef).toContain("`Pending` orders this node after `from` and consumes no value.")
    expect(inputRef).not.toContain("`Pending` consumes")
  })

  it("the repetition reference names the exported Optimizer pattern", () => {
    const repetition = api.split("## Repetition")[1]!.split("\n## ")[0]!
    expect(repetition).toContain("`Optimizer` takes it as `onMaxReached`")
    expect(repetition).not.toContain("`Loop`")
    expect(read("../../patterns/src/index.ts")).toContain("export * as Optimizer from \"./Optimizer.ts\"")
  })

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
