/**
 * Converting Worker modules preserves the request-ownership lint policy.
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import test from "node:test"
import { repoRoot } from "../scripts/workspace-packages.mjs"

const require = createRequire(import.meta.url)
const fc = require("fast-check")
const app = join(repoRoot, "apps/mvp")
const appRequire = createRequire(join(app, "package.json"))
const { ESLint } = appRequire("eslint")
const corpus = JSON.parse(readFileSync(new URL("./corpus/smithers-worker-prelude.json", import.meta.url), "utf8"))

test("production configuration checks native prelude factories and respects lexical shadows", async () => {
  const eslint = new ESLint({ cwd: app, overrideConfigFile: join(app, "eslint.config.js") })
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...corpus.factories),
    fc.integer({ min: 0, max: 10000 }),
    fc.constantFrom("direct", "alias", "destructure", "shadow"),
    fc.constantFrom(...corpus.contexts),
    async ({ owner, method }, suffix, mode, context) => {
      const name = "make" + suffix
      const call = owner + "." + method + "({})"
      const body = mode === "direct" ? "const value = " + call :
        mode === "alias" ? "const " + name + " = " + owner + "; const value = " + name + "." + method + "({})" :
        mode === "destructure" ? "const { " + method + ": " + name + " } = " + owner + "; const value = " + name + "({})" :
        "function run(" + owner + ": { " + method + "(x: unknown): number }) { return " + call + " }"
      const source = context === "module" ? body :
        context === "effect-block" ? "export const create = effect { " + body + "; return 0 }" :
        "export const create = effect () => { " + body + "; return 0 }"
      const [result] = await eslint.lintText(source, { filePath: join(app, "worker", "generated" + suffix + ".vibe") })
      assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages))
      const diagnostics = result.messages.filter(message => message.ruleId === "worker/request-owned-io")
      assert.equal(diagnostics.length, mode === "shadow" ? 0 : 1, JSON.stringify({ source, messages: result.messages }))
      const imports = [...new Set([owner, ...(context === "module" ? [] : ["Effect"])])]
      const twin = "import { " + imports.join(", ") + " } from \"effect\"; " +
        (context === "module" ? body : "export const create = Effect.gen(function* () { " + body + "; return 0 })")
      const [typescript] = await eslint.lintText(twin, { filePath: join(app, "worker", "generated" + suffix + ".ts") })
      assert.equal(typescript.fatalErrorCount, 0, JSON.stringify(typescript.messages))
      assert.equal(typescript.messages.filter(message => message.ruleId === "worker/request-owned-io").length, diagnostics.length)
    }
  ), { numRuns: 96, examples: [[{ owner: "Cache", method: "make" }, 0, "direct", "effect-block"], [{ owner: "Effect", method: "cached" }, 1, "alias", "effect-function"]] })
})
