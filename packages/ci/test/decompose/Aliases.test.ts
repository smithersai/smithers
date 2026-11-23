import { describe, expect, it } from "vitest"
import { withoutAliases } from "../../src/decompose/Aliases.vibe"

const owners = new Map([["core", "packages/core"], ["nested", "packages/core/nested"], ["ui", "packages/ui"]])
const file = "packages/app/tsconfig.json"
const config = (values: unknown, options = {}) =>
  JSON.stringify({ compilerOptions: { paths: { core: values }, ...options } })

describe("withoutAliases", () => {
  it("masks only destinations proven to resolve to the named workspace package", () => {
    for (const text of [config(["../core"]), config(["./core/src/*"], { baseUrl: ".." })]) {
      const masked = withoutAliases(file, text, owners)
      expect(masked).not.toContain("\"core\"")
      expect(masked.length).toBe(text.length)
    }
    for (
      const text of [
        config(["../ui"]),
        config(["../core/nested"]),
        config(["../core", "../ui"]),
        config(["/core"]),
        config(["../core/*/other"]),
        config(["../core\\\\foo"]),
        config([]),
        config(""),
        config([42]),
        config(["../../../../x"]),
        config(["../core"], { baseUrl: 7 }),
        config(["../core"], { baseUrl: "/x" }),
        config(["../core"], { baseUrl: "../../../../x" }),
        "{\"extends\":\"base\"}",
        "{}",
        "",
        "{ broken",
        config(["../core"]).replace("\"core\":", "\"external\":")
      ]
    ) {
      expect(withoutAliases(file, text, owners)).toBe(text)
    }
  })
  it("keeps computed and remapped bundler destinations available to the dependency scanner", () => {
    const text = "const alias = {core: resolve(root, 'packages/ui/src')} // }"
    expect(withoutAliases("vite.config.ts", text, owners)).toBe(text)
  })
})
