import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = path => readFileSync(new URL(path, import.meta.url), "utf8")
test("SD4-COPY-6 / sd4-missing-3 / p4-flows-5: flow instructions use registered personal-flow commands", () => {
  const page = source("../../docs/app/pages/flows.md")
  const registry = source("../../../mvp/src/flows/registry.ts")
  const registered = new Set([...registry.matchAll(/command: "([^"]+)"/g)].map(match => match[1]))
  const commands = [...page.matchAll(/`\/([a-z][a-z0-9.-]*)(?:[ `])/g)].map(match => match[1])
  assert.ok(commands.includes("flow.new"))
  assert.ok(commands.includes("flow.run"))
  for (const command of commands) assert.ok(registered.has(command), command)
  assert.match(page, /\/app\/flows/)
  assert.doesNotMatch(page, /repository flows;|overridable flows are|Flow card|draft run of `todo`/)
})
