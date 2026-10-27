import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { BuiltinScript } from "../src/index.ts"

const guide = readFileSync(new URL("../docs/guides/script-a-model.md", import.meta.url), "utf8")

it("sd4-guides-1: the tag example prints its documented result", () => {
  const options = guide.match(/BuiltinScript\.tag\((\{ ask: true[^\n]+?\})\)/)![1]!
  const documented = JSON.parse(guide.match(/\/\/ ("\[ASK\][^\n]+")/)![1]!)
  const prompt = `${BuiltinScript.tag(Function(`return (${options})`)())} Add a greeting`
  expect(prompt).toBe(documented)
})
