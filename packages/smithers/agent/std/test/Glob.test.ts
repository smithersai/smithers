import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Glob from "../src/Glob.ts"
import * as Grep from "../src/Grep.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("Glob", () => {
  const files = {
    "/src/a.ts": "",
    "/src/nested/b.ts": "",
    "/src/nested/c.tsx": "",
    "/src/z.js": ""
  }

  it("matches recursive and brace patterns in deterministic path order", async () => {
    const recursive = await execute(Effect.provide(Glob.run({ pattern: "**/*.ts", root: "/src" }), layer({ files })))
    const braces = await execute(Effect.provide(Glob.run({ pattern: "**/*.{ts,tsx}", root: "/src" }), layer({ files })))
    expect(recursive.paths).toEqual(["/src/a.ts", "/src/nested/b.ts"])
    expect(braces.paths).toEqual(["/src/a.ts", "/src/nested/b.ts", "/src/nested/c.tsx"])
  })

  it("returns an empty result when no file matches", async () => {
    const result = await execute(Effect.provide(Glob.run({ pattern: "**/*.md", root: "/src" }), layer({ files })))
    expect(result).toEqual({ paths: [], total: 0, truncated: false })
  })

  it("caps output and discloses truncation", async () => {
    const result = await execute(
      Effect.provide(Glob.run({ pattern: "**/*.ts", root: "/src", limit: 1 }), layer({ files }))
    )
    expect(result).toMatchObject({ paths: ["/src/a.ts"], total: 2, truncated: true })
    expect(result.notice).toBeDefined()
  })

  it("admits either boolean for noIgnore", () => {
    expect(Schema.decodeUnknownSync(Glob.Input)({ pattern: "*.ts", noIgnore: true })).toEqual({
      pattern: "*.ts",
      noIgnore: true
    })
    expect(Schema.decodeUnknownSync(Glob.Input)({ pattern: "*.ts", noIgnore: false }).noIgnore).toBe(false)
  })

  it("declares sealed hermetic effects and narrows to the root subtree", () => {
    expect(Glob.effects).toMatchObject({ tier: "sealed", mode: "hermetic" })
    expect(Glob.effectsFor({ root: "/src" }).reads).toEqual(["/src/**"])
  })

  it("narrows to the same subtree grep does, from one definition", () => {
    for (const root of ["/", "/src", "/src/", "/src//"]) {
      expect(Glob.effectsFor({ root }).reads).toEqual(Grep.effectsFor({ root }).reads)
    }
    expect(Glob.effectsFor({ root: "/src//" }).reads).toEqual(["/src/**"])
  })
})
