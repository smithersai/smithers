import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { isSource, modulePath, sourceText, sourcesUnder, typeScriptOf } from "../test-utils/source-readers.mjs"

// Inside the package, so the projection finds this package's vibelang.
const root = mkdtempSync(join(import.meta.dirname, ".source-readers-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const write = (path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true })
  writeFileSync(join(root, path), text)
}

write("ts/load.ts", 'import * as Effect from "effect/Effect"\nexport const load = (id: string) => Effect.gen(function* () {\n  const user = yield* Effect.succeed({ id, route: "/api/users" })\n  return user\n})\n')
write("vibe/load.vibe", 'export effect function load(id: string) {\n  const user = try Effect.succeed({ id, route: "/api/users" })\n  return user\n}\n')
write("vibe/load.d.vibe.ts", "export {}\n")
write("vibe/view.vibex", "export const view = () => <p />\n")
write("vibe/notes.md", "")
write("vibe/node_modules/dep/index.ts", "")
write("vibe/test/helper.ts", "")

describe("sourcesUnder", () => {
  it("lists .ts, .tsx, .vibe and .vibex sources, sorted, without declarations, node_modules or skipped paths", () => {
    expect(sourcesUnder(join(root, "vibe"))).toEqual(["load.vibe", "test/helper.ts", "view.vibex"])
    expect(sourcesUnder(join(root, "vibe"), (path) => path === "test")).toEqual(["load.vibe", "view.vibex"])
    expect(sourcesUnder(new URL(`file://${root}/`))).toEqual(["ts/load.ts", "vibe/load.vibe", "vibe/test/helper.ts", "vibe/view.vibex"])
  })

  it("names a source by its extension, never a declaration file", () => {
    expect(["a.ts", "a.tsx", "a.vibe", "a.vibex", "a.d.ts", "a.d.vibe.ts", "a.mjs"].filter(isSource)).toEqual(["a.ts", "a.tsx", "a.vibe", "a.vibex"])
  })
})

describe("modulePath", () => {
  it("finds a module converted to VibeLang under its TypeScript name, and fails for a module that is neither", () => {
    expect(modulePath(join(root, "vibe/load.ts"))).toBe(join(root, "vibe/load.vibe"))
    expect(modulePath(join(root, "ts/load.ts"))).toBe(join(root, "ts/load.ts"))
    expect(() => modulePath(join(root, "vibe/absent.ts"))).toThrow(/No module at .*absent\.ts/)
  })
})

describe("sourceText", () => {
  it("reads a module as written, under its TypeScript name", () => {
    expect(sourceText(join(root, "vibe/load.ts"))).toContain('const user = try Effect.succeed({ id, route: "/api/users" })')
  })
})

describe("typeScriptOf", () => {
  it("reads a TypeScript module as written", () => {
    expect(typeScriptOf(join(root, "ts/load.ts"))).toContain("yield* Effect.succeed(")
  })

  it("reads a VibeLang module as VibeLang's TypeScript projection: its text kept, try lowered to yield*", () => {
    const projected = typeScriptOf(join(root, "vibe/load.ts"))
    expect(projected).toContain("export        function load(id: string)")
    // The projection keeps every offset, so `try ` becomes spaces before the lowered form.
    expect(projected).toContain('const user =     (yield* $run(Effect.succeed({ id, route: "/api/users" })))')
    expect(projected).not.toMatch(/\btry\b/)
  })
})
