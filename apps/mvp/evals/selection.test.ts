import { expect, test } from "vitest"
import { readdirSync } from "node:fs"
import { evalFiles, STANDALONE_EVALS } from "./standalone"

test("the standalone manifest covers every collected eval file", () => {
  const files = readdirSync(new URL(".", import.meta.url)).filter(name => /\.eval\.(?:ts|vibe)$/.test(name)).map(name => "evals/" + name).sort()
  expect([...evalFiles(undefined)].sort()).toEqual(files)
  for (const [name, file] of Object.entries(STANDALONE_EVALS)) {
    expect(evalFiles(" " + name + " ")).toEqual([file])
  }
})

test("accepts multiple named suites and refuses unknown names", () => {
  expect(evalFiles(" timeline, todo-steer, timeline, ")).toEqual(["evals/timeline.eval.ts", "evals/todo-steer.eval.ts"])
  expect(() => evalFiles("timline")).toThrow("no eval is named timline")
})
