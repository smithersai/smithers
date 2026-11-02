import { describe, expect, it } from "@effect/vitest"
import { Action } from "@smthrs/flow"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const actionDir = fileURLToPath(new URL("../src/Action/", import.meta.url))

/** A source module: TypeScript, or the same module migrated to VibeLang. */
const sourceExtensions = [".ts", ".vibe"] as const

/** A source module's file, and not the declaration sidecar a `.vibe` module may emit. */
const isSourceFile = (file: string): boolean =>
  sourceExtensions.some((extension) => file.endsWith(extension)) && !file.endsWith(".d.vibe.ts")

/** The one file of `files` that holds the source module `name`. */
const sourceFile = (files: ReadonlyArray<string>, name: string): string => {
  const found = sourceExtensions.map((extension) => `${name}${extension}`).filter((file) => files.includes(file))
  if (found.length !== 1) {
    throw new Error(`${name} needs one source module, found ${found.length === 0 ? "none" : found.join(" and ")}`)
  }
  return found[0]!
}

const errors = [
  "AttemptTimedOut",
  "ConcurrentKeylessDispatch",
  "DuplicateImplementation",
  "ImplementationVersionMismatch",
  "InfraInterrupt",
  "InfraInterruptRetriesExhausted",
  "IrreversibleRetryRequiresIdempotencyKey",
  "UncanonicalIdempotencyKey"
] as const

describe("Action error modules", () => {
  it.each(errors)("%s lives in its own module and is re-exported by the barrel", async (name) => {
    const module = await import(`../src/Action/${sourceFile(readdirSync(actionDir), name)}`)
    expect(Object.keys(module)).toEqual([name])
    expect(module[name]).toBe(Action[name])
  })

  it("keeps one tagged error per file", () => {
    for (const file of readdirSync(actionDir).filter(isSourceFile)) {
      const source = readFileSync(`${actionDir}${file}`, "utf8")
      const count = source.match(/Schema\.TaggedError</g)?.length ?? 0
      expect(count, file).toBeLessThanOrEqual(1)
    }
  })

  it.each([
    ["a .ts module", ["M.ts"], "M.ts"],
    ["a .vibe module", ["M.vibe"], "M.vibe"]
  ])("finds %s", (_case, files, expected) => {
    expect(sourceFile(files, "M")).toBe(expected)
  })

  it.each([
    ["a missing module", ["Other.ts"], "none"],
    ["a module in both languages", ["M.ts", "M.vibe"], "M.ts and M.vibe"],
    ["a declaration sidecar only", ["M.d.vibe.ts"], "none"],
    ["a module in another language", ["M.js"], "none"]
  ])("refuses %s", (_case, files, found) => {
    expect(() => sourceFile(files, "M")).toThrow(`M needs one source module, found ${found}`)
  })

  it.each([
    ["M.ts", true],
    ["M.vibe", true],
    ["M.d.vibe.ts", false],
    ["M.js", false],
    ["M.md", false]
  ])("counts %s as a source file: %s", (file, expected) => {
    expect(isSourceFile(file)).toBe(expected)
  })
})
