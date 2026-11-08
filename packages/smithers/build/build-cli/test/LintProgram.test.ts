import { ESLint, type SourceCode } from "eslint"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

// Observe the real parser service: every lint rule still runs on source and
// example modules, but their shared dependency graph must not be retained twice.
test("source and example lint share one typed program", async () => {
  const programs = new Map<string, unknown>()
  const eslint = new ESLint({
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    overrideConfig: {
      plugins: {
        "program-observer": {
          rules: {
            capture: {
              meta: { schema: [] },
              create(context) {
                programs.set(context.filename, (context.sourceCode as SourceCode).parserServices?.program)
                return {}
              }
            }
          }
        }
      },
      rules: { "program-observer/capture": "error" }
    }
  })
  const results = await eslint.lintFiles(["src/Ansi.ts", "examples/who-owns.ts"])
  expect(results.map((result) => ({ errors: result.errorCount, warnings: result.warningCount })))
    .toEqual([{ errors: 0, warnings: 0 }, { errors: 0, warnings: 0 }])
  expect(programs.size).toBe(2)
  expect([...programs.values()].every((program) => program !== undefined)).toBe(true)
  expect(new Set(programs.values()).size).toBe(1)
})
