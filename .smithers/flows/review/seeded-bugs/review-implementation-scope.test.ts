/** Review rules keep every extracted implementation in the scope of its original source module. */
import * as Fs from "node:fs"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import * as TypeScript from "typescript"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

const root = Path.dirname(fileURLToPath(import.meta.url))
const wrappers = ["labels.vibe", "run.vibe"] as const
const companions = new Map(wrappers.map((wrapper) => [
  wrapper,
  [...Fs.readFileSync(Path.join(root, wrapper), "utf8").matchAll(/from ["']([^"'\n]+\.platform\.ts)["']/g)]
    .map((match) => Path.posix.normalize(Path.posix.join(Path.posix.dirname(wrapper), match[1]!)))
]))
const source = TypeScript.createSourceFile(
  "PACKAGE.ts",
  Fs.readFileSync(Path.join(root, "PACKAGE.ts"), "utf8"),
  TypeScript.ScriptTarget.Latest,
  true
)
const rules: Array<{ id: string; paths: Array<string> }> = []
let registered: Array<string> = []
const visit = (node: TypeScript.Node): void => {
  if (TypeScript.isObjectLiteralExpression(node)) {
    const properties = node.properties.filter(TypeScript.isPropertyAssignment)
    const property = (name: string) => properties.find((entry) => entry.name.getText(source) === name)?.initializer
    const id = property("id")
    const paths = property("paths")
    if (id && TypeScript.isStringLiteral(id) && paths && TypeScript.isArrayLiteralExpression(paths)) {
      rules.push({ id: id.text, paths: paths.elements.filter(TypeScript.isStringLiteral).map((entry) => entry.text) })
    }
  }
  if (TypeScript.isCallExpression(node) && TypeScript.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "testSuite" && node.arguments[0]
    && TypeScript.isArrayLiteralExpression(node.arguments[0])) {
    registered = node.arguments[0].elements.filter(TypeScript.isStringLiteral).map((entry) => entry.text)
  }
  TypeScript.forEachChild(node, visit)
}
visit(source)

describe("review implementation scope", () => {
  it("finds both actual companions and the original rules protecting their wrappers", () => {
    const required = new Map([
      ["labels.vibe", ["gate-integrity"]],
      ["run.vibe", ["live-report-leak", "live-cell-authority", "gate-integrity"]]
    ])
    for (const wrapper of wrappers) {
      assert.ok(companions.get(wrapper)!.length > 0)
      const selected = rules.filter((rule) => rule.paths.includes(wrapper)).map((rule) => rule.id)
      for (const id of required.get(wrapper)!) assert.ok(selected.includes(id), id + " protects " + wrapper)
      for (const companion of companions.get(wrapper)!) assert.ok(Fs.statSync(Path.join(root, companion)).isFile())
    }
  })
  for (const wrapper of wrappers) {
    for (const rule of rules.filter((entry) => entry.paths.includes(wrapper))) {
      it("keeps " + wrapper + "'s implementation in " + rule.id, () => {
        for (const companion of companions.get(wrapper)!) assert.ok(rule.paths.includes(companion), rule.id + " must select " + companion)
      })
    }
  }
  it("registers every test from the package script in the declared suite", () => {
    const manifest = JSON.parse(Fs.readFileSync(Path.join(root, "package.json"), "utf8"))
    const scriptTests = manifest.scripts.test.match(/[\w.-]+\.test\.ts/g) as Array<string>
    assert.ok(scriptTests.length > 0)
    for (const file of scriptTests) assert.ok(registered.includes(file), file + " must be registered")
  })
})
