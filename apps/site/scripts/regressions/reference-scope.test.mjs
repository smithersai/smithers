import assert from "node:assert/strict"
import test from "node:test"
import { projection, PAGE } from "../gen-cli-reference.mjs"

const page = () => projection().get(PAGE)

test("sd4-ia-3: reference states its discovery scope", () => {
  assert.doesNotMatch(page(), /Every command in/)
  assert.match(page(), /discovery/)
  assert.match(page(), /\/docs\/reference\/api\/cli/)
})
