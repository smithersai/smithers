import { API, type APIOptions } from "typescript/unstable/sync"
import { describe, expect, it } from "vitest"
import { parseModule } from "../src/internal/ParseModule.ts"

describe("compiler isolation and failure cleanup", () => {
  it.each(["project", "source", "snapshot"] as const)("closes its session on %s failure", (failure) => {
    let closes = 0
    const open = () => ({
      updateSnapshot: (() => {
        if (failure === "snapshot") throw new Error("native compiler failure")
        return { getProject: () => failure === "project" ? undefined : { program: { getSourceFile: () => undefined } } }
      }),
      close: () => {
        closes++
      }
    })
    expect(() => parseModule("entry.ts", "const value = 1", open))
      .toThrow(failure === "snapshot" ? "native compiler failure" : "did not return a syntax tree")
    expect(closes).toBe(1)
  })

  it("never falls back to the real filesystem or loads libraries and imports", () => {
    let options!: APIOptions
    const source = parseModule("../../outside.ts", "import '/private/source'", (value) => {
      options = value
      return new API(value)
    })
    expect(source).toBeDefined()
    const { cwd, fs } = options
    const file = String(cwd) + "/input.ts"
    expect(fs!.readFile!(file)).toBe("import '/private/source'")
    expect(fs!.fileExists!(file)).toBe(true)
    expect(fs!.directoryExists!(cwd!)).toBe(true)
    for (
      const outside of ["/private/source", "/tsconfig.json", String(cwd) + "/node_modules/typescript/lib/lib.d.ts"]
    ) {
      expect(fs!.readFile!(outside)).toBeNull()
      expect(fs!.fileExists!(outside)).toBe(false)
      expect(fs!.directoryExists!(outside)).toBe(false)
      expect(fs!.getAccessibleEntries!(outside)).toEqual({ files: [], directories: [] })
      expect(fs!.realpath!(outside)).toBe(outside)
    }
    expect(JSON.parse(fs!.readFile!(String(cwd) + "/tsconfig.json")!)).toEqual({
      files: ["input.ts"],
      compilerOptions: { noLib: true, noResolve: true, allowJs: true, types: [] }
    })
  })
})
