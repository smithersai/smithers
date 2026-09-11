import { describe, expect, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"
import * as Capability from "../src/Capability.ts"
import * as Permission from "../src/Permission.ts"

const source = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8")

const definesNothing = (path: string): boolean =>
  source(path)
    .split("\n")
    .filter((line) => line.startsWith("export ") || line.startsWith("import "))
    .every((line) => /^export (\*|\{[^}]*\}|type \{[^}]*\}) from "\.\/[A-Za-z]+\.ts"$/.test(line))

/**
 * Public concepts renamed at the file level because their name is taken by
 * the barrel they are re-exported from.
 */
const renamed: Readonly<Record<string, string>> = { Capability: "ExactCapability.ts" }

const fileFor = (name: string): string => renamed[name] ?? `${name}.ts`

describe("module layout", () => {
  it.each([["Capability.ts"], ["Permission.ts"]])("%s only re-exports named modules", (barrel) => {
    expect(definesNothing(barrel)).toBe(true)
  })

  it.each([
    ["Capability", Object.keys(Capability)],
    ["Permission", Object.keys(Permission)]
  ])("every %s export is defined in the file of its name", (_barrel, names) => {
    expect(names.length).toBeGreaterThan(0)
    const missing = names.filter((name) => !existsSync(new URL(`../src/${fileFor(name)}`, import.meta.url)))
    expect(missing).toEqual([])
  })

  it.each([
    ["evaluate.ts", "matches"],
    ["evaluate.ts", "withinMatchBudget"],
    ["formatError.ts", "format"]
  ])("%s reaches %s through the Capability barrel so a mocked barrel is observed", (path, name) => {
    expect(source(path)).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./Capability\\.ts"`))
  })
})
