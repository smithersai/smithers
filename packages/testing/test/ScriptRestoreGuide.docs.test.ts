import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { BuiltinScript } from "../src/index.ts"

const guide = readFileSync(new URL("../docs/guides/script-a-model.md", import.meta.url), "utf8")

it("sd4-guides-2: every public boolean directive is described in the table", () => {
  const row = guide.split("\n").find((line) => line.startsWith("| `restore: true`"))
  expect(row).toContain("`[RESTORE]`")
  expect(row).toContain("JOURNEY.md")
  expect(BuiltinScript.tag({ restore: true })).toBe("[RESTORE]")
  expect(BuiltinScript.directives("[RESTORE]").restore).toBe(true)
})
