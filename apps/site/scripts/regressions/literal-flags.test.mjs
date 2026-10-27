import assert from "node:assert/strict"
import test from "node:test"
import { projection, PAGE, prose } from "../gen-cli-reference.mjs"

const page = () => projection().get(PAGE)

test("sd4-cli-ref-5: flags in prose retain copyable hyphens", () => {
  assert.equal(prose("human, agent, --silent"), "human, agent, `--silent`")
  assert.match(page(), /agent, `--silent`/)
  assert.equal(prose("--help, --ui=plain; snake_case and x--y"), "`--help`, `--ui`=plain; snake_case and x--y")
})
