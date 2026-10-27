import assert from "node:assert/strict"
import test from "node:test"
import { projection, PAGE } from "../gen-cli-reference.mjs"

const page = () => projection().get(PAGE)

test("sd4-cli-ref-3: callable change and generator commands have reference sections", () => {
  for (const name of ["change list", "change status", "change files", "change show", "change conflicts", "generate package", "generate ci"]) {
    assert.ok(page().includes(`### \`${name}\``), name)
  }
})
