import { readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Index from "../src/index.ts"

describe("the barrel", () => {
  it("re-exports one namespace per source module", () => {
    const modules = readdirSync(join(import.meta.dirname, "..", "src"))
      .filter((file) => file.endsWith(".ts") && file !== "index.ts")
      .map((file) => file.slice(0, -3))
      .sort()
    expect(Object.keys(Index).sort()).toEqual(modules)
  })
})
