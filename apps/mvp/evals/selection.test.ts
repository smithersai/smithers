import { afterEach, expect, test } from "vitest"
import { readdirSync } from "node:fs"
import { evalFiles, STANDALONE_EVALS } from "./standalone"
import { onlyKnown } from "./suite"

const previous = process.env.EVAL_ONLY
afterEach(() => {
  if (previous === undefined) delete process.env.EVAL_ONLY
  else process.env.EVAL_ONLY = previous
})

test.each(["timeline", "todo-steer", "todo-lint", "ui-judge", "memory"])("accepts the standalone %s suite during collection", (name) => {
  process.env.EVAL_ONLY = name
  expect(() => onlyKnown()).not.toThrow()
})

test("accepts mixed selections and still rejects misspelled names", () => {
  process.env.EVAL_ONLY = " timeline, greeting, todo-steer, "
  expect(() => onlyKnown()).not.toThrow()
  process.env.EVAL_ONLY = "timline"
  expect(() => onlyKnown()).toThrow("no eval case is named timline")
  delete process.env.EVAL_ONLY
  expect(() => onlyKnown()).not.toThrow()
})


test("the standalone manifest covers every collected eval file", () => {
  const files = readdirSync(new URL(".", import.meta.url)).filter(name => /\.eval\.(?:ts|vibe)$/.test(name)).map(name => "evals/" + name).sort()
  expect([...evalFiles(undefined)].sort()).toEqual(files)
  for (const [name, file] of Object.entries(STANDALONE_EVALS)) {
    expect(evalFiles(" " + name + " ")).toEqual(["evals/agent.eval.ts", "evals/flows.eval.ts", file])
  }
})

test("case selections retain their UI calibration and omit unrelated standalone suites", () => {
  expect(evalFiles("greeting")).toEqual(["evals/agent.eval.ts", "evals/flows.eval.ts"])
  expect(evalFiles("form-ask")).toEqual(["evals/agent.eval.ts", "evals/flows.eval.ts", "evals/ui-judge.eval.ts"])
})
