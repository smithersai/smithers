import { ESLint } from "eslint"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const root = fileURLToPath(new URL("../", import.meta.url))
const eslint = new ESLint({ cwd: root })
const ruleId = "coverage/no-new-ignores"
const violations = async (source: string, path = "src/WorkspaceSandbox.ts") =>
  (await eslint.lintText(source, { filePath: join(root, path) }))
    .flatMap((result) => result.messages.filter((message) => message.ruleId === ruleId))

it.each([
  "/* v8 ignore next */",
  "/* v8 ignore next 100 */",
  "/* v8 ignore start */",
  "/* v8 ignore stop */",
  "/* c8 ignore next */",
  "/* istanbul ignore file */",
  "// v8 ignore next"
])("rejects a new coverage exclusion: %s", async (pragma) => {
  expect(await violations(`${pragma}\nexport const covered = 1\n`)).toHaveLength(1)
})

it("allows the five existing exclusions, but rejects copies and wider ranges", async () => {
  const paths = ["src/PlanScheduler.ts", "src/internal/ActionPersistence.ts"]
  let approved = 0
  for (const path of paths) {
    const source = await readFile(join(root, path), "utf8")
    expect(await violations(source, path)).toEqual([])
    for (const [pragma] of source.matchAll(/\/\* v8 ignore[^]*?\*\//g)) {
      approved++
      expect(await violations(`${source}\n${pragma}\n`, path)).toHaveLength(1)
      const wider = pragma.replace("ignore next", "ignore next 100")
      expect(await violations(source.replace(pragma, wider), path)).toHaveLength(1)
      expect(await violations(`${pragma}\nexport const moved = 1\n`)).toHaveLength(1)
    }
  }
  expect(approved).toBe(5)
})

it("allows ordinary comments and coverage words in strings", async () => {
  expect(await violations(`// Fully covered.\nexport const text = "v8 ignore next"\n`)).toEqual([])
})
