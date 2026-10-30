import { expect, it } from "vitest"
import { deferTypeScript } from "../src/internal/Bootstrap.ts"

it.each(["add", "list", "view", "remove"])("uses native startup for environment %s", (verb) => {
  expect(deferTypeScript(["environment", verb, "--json"])).toBe(true)
})

it.each([
  [],
  ["environment"],
  ["environment", "exec"],
  ["environment", "shell"],
  ["environment", "forward"],
  ["--json", "environment", "list"],
  ["runs", "resume", "retained-run"],
  ["flow", "start", "hello"],
  ["ps"],
  ["environment", "list", "--mcp"],
  ["environment", "list", "--mcp=true"],
  ["environment", "list", "--http"],
  ["environment", "list", "--http=3000"]
])("retains the declaration compiler for durable or protocol entrypoints: %j", (...args) => {
  expect(deferTypeScript(args)).toBe(false)
})
