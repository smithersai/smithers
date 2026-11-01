import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import * as Capability from "../src/Capability.ts"
import * as Permission from "../src/Permission.ts"

const source = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8")

/** A source module of `src`: TypeScript, or the same module migrated to VibeLang. */
const sourceExtensions = [".ts", ".vibe"] as const

const reExport = /^export (?:\*|\{[^}]*\}|type \{[^}]*\}) from "\.\/([A-Za-z]+\.(?:ts|vibe))"$/

/** Every `export` and `import` line of `text` re-exports a module that exists in `files`. */
const onlyReExports = (text: string, files: ReadonlySet<string>): boolean =>
  text
    .split("\n")
    .filter((line) => line.startsWith("export ") || line.startsWith("import "))
    .every((line) => {
      const target = reExport.exec(line)?.[1]
      return target !== undefined && files.has(target)
    })

const definesNothing = (path: string): boolean => onlyReExports(source(path), modules)

/**
 * Public concepts renamed at the file level because their name is taken by
 * the barrel they are re-exported from.
 */
const renamed: Readonly<Record<string, string>> = { Capability: "ExactCapability" }

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
const definedIn = (files: ReadonlySet<string>, name: string): boolean => {
  const stems = [renamed[name] ?? name, ...(renamed[name] === undefined ? [capitalized(name)] : [])]
  return stems.some((stem) => sourceExtensions.some((extension) => files.has(`${stem}${extension}`)))
}

const isDefined = (name: string): boolean => definedIn(modules, name)

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
    ["a .ts re-export", `export * from "./Real.ts"`, true],
    ["a .vibe re-export", `export { a } from "./Real.vibe"`, true],
    ["a re-export of a missing .vibe", `export * from "./Missing.vibe"`, false],
    ["a re-export of a missing .ts", `export * from "./Missing.ts"`, false],
    ["a barrel with logic", `export effect function run() { return 1 }`, false],
    ["a barrel with a value", `export const value = 1`, false],
    ["a re-export of another extension", `export * from "./Real.js"`, false],
    ["a re-export beside logic", `export * from "./Real.vibe"\nexport effect function run() { return 1 }`, false],
    ["two re-exports", `export * from "./Real.ts"\nexport * from "./Real.vibe"`, true]
  ])("the barrel rule reads %s", (_case, text, expected) => {
    expect(onlyReExports(text, new Set(["Real.ts", "Real.vibe", "Real.js"]))).toBe(expected)
  })

  it.each([
    ["own .ts file", ["thing.ts"], "thing", true],
    ["own .vibe file", ["thing.vibe"], "thing", true],
    ["its type's .vibe file", ["Thing.vibe"], "thing", true],
    ["no file", ["other.vibe"], "thing", false],
    ["a sidecar only", ["thing.d.vibe.ts"], "thing", false],
    ["a renamed concept's .vibe file", ["ExactCapability.vibe"], "Capability", true],
    ["a renamed concept without its file", ["Capability.vibe"], "Capability", false]
  ])("the definition rule reads %s", (_case, files, name, expected) => {
    expect(definedIn(new Set(files), name)).toBe(expected)
  })

  it.each([
    ["evaluate.ts", "matches"],
    ["evaluate.ts", "withinMatchBudget"],
    ["formatError.ts", "format"]
  ])("%s reaches %s through the Capability barrel so a mocked barrel is observed", (path, name) => {
    expect(source(path)).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./Capability\\.ts"`))
  })
})
