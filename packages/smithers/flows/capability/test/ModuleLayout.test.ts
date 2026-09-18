import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
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

/**
 * The names `src` really holds, read once and compared exactly.
 *
 * `existsSync` asks the filesystem, and a macOS or Windows volume answers
 * case-insensitively, so `permissionDenied.ts` "exists" there and does not on
 * the Linux runner. The directory listing is the same on every host.
 */
const modules: ReadonlySet<string> = new Set(readdirSync(new URL("../src/", import.meta.url)))

const capitalized = (name: string): string => `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`

/**
 * Where a public name is defined: the file of its own name, or, for a value
 * constructor named after the type it builds (`permissionDenied` builds a
 * `PermissionDenied`), the file of that type.
 */
const isDefined = (name: string): boolean => {
  const renamedFile = renamed[name]
  if (renamedFile !== undefined) return modules.has(renamedFile)
  return modules.has(`${name}.ts`) || modules.has(`${capitalized(name)}.ts`)
}

describe("module layout", () => {
  it.each([["Capability.ts"], ["Permission.ts"]])("%s only re-exports named modules", (barrel) => {
    expect(definesNothing(barrel)).toBe(true)
  })

  it.each([
    ["Capability", Object.keys(Capability)],
    ["Permission", Object.keys(Permission)]
  ])("every %s export is defined in the file of its name", (_barrel, names) => {
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => !isDefined(name))).toEqual([])
  })

  it.each([
    ["evaluate.ts", "matches"],
    ["evaluate.ts", "withinMatchBudget"],
    ["formatError.ts", "format"]
  ])("%s reaches %s through the Capability barrel so a mocked barrel is observed", (path, name) => {
    expect(source(path)).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./Capability\\.ts"`))
  })
})
