import assert from "node:assert/strict"
import test from "node:test"
import { projection, PAGE } from "../gen-cli-reference.mjs"

const page = () => projection().get(PAGE)

test("sd4-cli-ref-1 / sd4-missing-6: removed agents is absent from the reference", () => {
  assert.doesNotMatch(page(), /## `agents`/)
})
