/** Keep the operator reference aligned with the registered command schemas. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

test("branch, TODO, connection, approval and step-cache operations have reference entries", () => {
  const docs = read("docs/reference/cli/README.md")
  const { operations } = JSON.parse(read("src/internal/backend/catalog.mvp.json"))
  const commands = operations.filter((row) => row.cli && ["branch", "todo"].includes(row.cli[0]))
    .map((row) => row.cli.join(" "))
  commands.push(...[...read("src/internal/backend/Definitions.ts").matchAll(/^  "(auth (?:connect|connections|revoke))":/gm)].map((match) => match[1]))
  assert.ok(read("src/cli/ControlCommands.ts").includes('.command("grant",'))
  commands.push("approvals grant")
  commands.push(...[...read("src/cli/StepCacheCommands.ts").matchAll(/\.command\("([^"]+)"/g)].map((match) => `cache steps ${match[1]}`))
  const missing = commands.filter((command) => !docs.includes(`\`${command}`))
  assert.deepEqual(missing, [], "registered operations missing from docs/reference/cli/README.md")
})
