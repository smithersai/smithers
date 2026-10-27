import assert from "node:assert/strict"
import test from "node:test"
import { projection, PAGE } from "../gen-cli-reference.mjs"

const page = () => projection().get(PAGE)

test("sd4-missing-7: captured integrations are rendered", () => {
  for (const name of ["completions", "mcp", "skills"]) assert.ok(page().includes(`## \`${name}\``), name)
})
