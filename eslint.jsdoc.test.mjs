import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { jsdocConvention, moduleHeader, vibeDeclarations } from "./eslint.jsdoc.js"

const require = createRequire(import.meta.url)
const eslintPath = require.resolve("eslint", {
  paths: [new URL("./packages/smithers/flows/flow", import.meta.url).pathname]
})
const { Linter } = await import(pathToFileURL(eslintPath).href)

const messages = (source) => {
  const linter = new Linter()
  return linter.verify(source, [{
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: { "flows-jsdoc": { rules: { "module-header": moduleHeader } } },
    rules: { "flows-jsdoc/module-header": "error" }
  }])
}

const conventionMessages = (source) => {
  const linter = new Linter()
  const { files: _files, ignores: _ignores, ...config } = jsdocConvention[0]
  return linter.verify(source, [config])
}

test("a standalone leading JSDoc is a module header", () => {
  assert.equal(messages("/** Module prose.\n * @since 0.1.0\n */\n\nexport const value = 1\n").length, 0)
})

test("a module header followed directly by a statement is detached with a blank line", () => {
  const source = "/** Module prose.\n * @since 0.1.0\n */\nimport * as Value from \"./Value.ts\"\n"
  const linter = new Linter()
  const config = [{
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: { "flows-jsdoc": { rules: { "module-header": moduleHeader } } },
    rules: { "flows-jsdoc/module-header": "error" }
  }]
  assert.equal(messages(source)[0]?.ruleId, "flows-jsdoc/module-header")
  assert.equal(
    linter.verifyAndFix(source, config).output,
    "/** Module prose.\n * @since 0.1.0\n */\n\nimport * as Value from \"./Value.ts\"\n"
  )
})

test("a module header followed directly by a comment is detached with a blank line", () => {
  assert.equal(
    messages("/** Module prose.\n * @since 0.1.0\n */\n// note\nexport const value = 1\n")[0]?.ruleId,
    "flows-jsdoc/module-header"
  )
})

test("a module header that also documents the first export stays attached", () => {
  assert.equal(messages("/** Value prose.\n * @private\n * @since 0.1.0\n */\nexport const value = 1\n").length, 0)
})

test("the first export's JSDoc is not mistaken for a module header", () => {
  assert.equal(
    messages("/** Export prose.\n * @category values\n * @since 0.1.0\n */\nexport const value = 1\n")[0]?.ruleId,
    "flows-jsdoc/module-header"
  )
})

test("default function and class declarations follow the export JSDoc convention", () => {
  const header = "/** Module prose.\n * @since 0.1.0\n */\n\n"
  assert.ok(
    conventionMessages(`${header}export default function value() {}`).some((message) =>
      message.ruleId === "jsdoc/require-jsdoc"
    )
  )
  assert.ok(
    conventionMessages(`${header}export default class Value {}`).some((message) =>
      message.ruleId === "jsdoc/require-jsdoc"
    )
  )
  assert.equal(
    conventionMessages(
      `${header}/** Value prose.\n * @category values\n * @since 0.1.0\n */\nexport default function value() {}`
    ).length,
    0
  )
})

test("default expressions remain outside the declaration convention", () => {
  const source = "/** Module prose.\n * @since 0.1.0\n */\n\nconst value = 1\nexport default value\n"
  assert.equal(conventionMessages(source).length, 0)
})

test("slop is an accepted declaration marker", () => {
  const source =
    "/** Module prose.\n * @since 0.1.0\n */\n\n/** Value prose.\n * @category values\n * @since 0.1.0\n * @slop\n */\nexport const value = 1\n"
  assert.equal(conventionMessages(source).length, 0)
})

test("the repository default rejects undocumented RPC exports", async () => {
  const { ESLint } = await import(pathToFileURL(eslintPath).href)
  const eslint = new ESLint({ cwd: new URL(".", import.meta.url).pathname })
  const [result] = await eslint.lintText("export const undocumented = 1\n", {
    filePath: "packages/rpc/src/Regression.ts"
  })
  assert.ok(result.messages.some((message) => message.ruleId === "jsdoc/require-jsdoc"))
})

test("only a declaration beside a VibeLang source is a generated declaration", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-declarations-"))
  try {
    for (const directory of ["src/[id]", "node_modules/dep", "dist", ".cache"]) {
      mkdirSync(join(root, directory), { recursive: true })
    }
    for (
      const file of [
        "src/Service.vibe",
        "src/View.vibex",
        "src/[id]/route.vibe",
        "src/Ambient.d.ts",
        "node_modules/dep/Dep.vibe",
        "dist/Built.vibe",
        ".cache/Cached.vibe"
      ]
    ) {
      writeFileSync(join(root, file), "")
    }
    const ignores = vibeDeclarations(root)
    assert.deepEqual(
      ignores.slice(0, 4),
      ["**/*.d.vibe.ts", "**/*.d.vibex.ts", "**/*.vibe.text.d.ts", "**/*.vibex.text.d.ts"]
    )
    assert.deepEqual(ignores.slice(4).sort(), ["src/Service.d.ts", "src/View.d.ts", "src/\\[id\\]/route.d.ts"])

    const { ESLint } = await import(pathToFileURL(eslintPath).href)
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: [{ ignores }, { files: ["**/*.ts"] }] })
    for (const generated of ["src/Service.d.ts", "src/View.d.ts", "src/[id]/route.d.ts", "src/Service.d.vibe.ts"]) {
      assert.equal(await eslint.isPathIgnored(join(root, generated)), true, generated)
    }
    for (const written of ["src/Ambient.d.ts", "src/id/route.d.ts"]) {
      assert.equal(await eslint.isPathIgnored(join(root, written)), false, written)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
