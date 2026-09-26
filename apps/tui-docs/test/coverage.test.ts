import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { commands } from "../../tui/src/editor.ts"
import { registry } from "../../tui/src/keys.ts"
import { scenarioNames } from "../scripts/scenarios.mjs"
import { parseScripts } from "../scripts/scripts.mjs"
const docs = fileURLToPath(new URL("../../tui/docs/", import.meta.url))
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
  )
const files = walk(docs).filter((file) => file.endsWith(".md"))
test("every user guide has an executable recording and every local guide link resolves", () => {
  const ids = new Map<string, string>()
  assert(files.length >= 25)
  for (const file of files) {
    const source = readFileSync(file, "utf8"), scripts = parseScripts(source)
    assert(scripts.length > 0, `No recording in ${file}`)
    for (const script of scripts) {
      if (ids.has(script.id)) {
        assert.equal(ids.get(script.id), JSON.stringify(script), `Conflicting script ${script.id}`)
      }
      ids.set(script.id, JSON.stringify(script))
      const setup = script.steps.find((step: { kind: string }) => step.kind === "Use")
      if (setup) assert(scenarioNames.includes(setup.value), `Unknown fixture ${setup.value}`)
    }
    for (const match of source.matchAll(/\]\(([^):]+\.md)(?:#[^)]*)?\)/g)) {
      assert(files.includes(join(dirname(file), match[1]!)), `Broken guide link ${match[1]} in ${file}`)
    }
  }
  assert(ids.size >= 35, `Only ${ids.size} recordings`)
})
test("command and keyboard references cover their complete runtime registries", () => {
  const commandDoc = readFileSync(join(docs, "reference/commands.md"), "utf8")
  for (const command of [...commands, { name: "exit" }]) {
    assert(commandDoc.includes(`\`/${command.name}`), `Undocumented command ${command.name}`)
  }
  const keyDoc = readFileSync(join(docs, "reference/keys.md"), "utf8")
  for (const binding of registry) {
    assert(keyDoc.includes(`${binding.label}.`), `Undocumented action ${binding.id}`)
    for (const key of binding.keys) assert(keyDoc.includes(`\`${key}\``), `Undocumented key ${key}`)
  }
})
