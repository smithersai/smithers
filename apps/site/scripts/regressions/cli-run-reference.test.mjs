import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { PAGE, projection } from "../gen-cli-reference.mjs"

const site = new URL("../../", import.meta.url)

test("the advanced run namespace retains its own target schema beside run inspect", () => {
  const additional = JSON.parse(readFileSync(new URL("src/data/cli-reference-extra.json", site), "utf8"))
  const run = additional.find(command => command.name === "run")
  assert.ok(run, "run's target options need an explicit reference supplement")
  assert.ok(run.schema.args.properties.patterns)
  assert.ok(run.schema.options.properties.jobs)
})

test("the real captured CLI projects both target execution and run inspection", () => {
  const output = projection(fileURLToPath(new URL("../../../../", import.meta.url))).get(PAGE)
  assert.match(output, /## `run`/)
  assert.match(output, /### `run inspect`/)
  assert.match(output, /\| `--jobs`, `-j` \|/)
})
