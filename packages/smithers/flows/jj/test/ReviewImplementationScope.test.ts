/** Review selectors retain the implementation when a source module delegates to a platform companion. */
import * as Fs from "node:fs"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import * as TypeScript from "typescript"
import { describe, expect, it } from "vitest"

const root = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..")
const wrapper = "src/browser/BrowserJj.vibe"
const text = Fs.readFileSync(Path.join(root, wrapper), "utf8")
const companions = [...text.matchAll(/from ["']([^"'\n]+\.platform\.ts)["']/g)]
  .map((match) => Path.posix.normalize(Path.posix.join(Path.posix.dirname(wrapper), match[1]!)))
const source = TypeScript.createSourceFile(
  "PACKAGE.ts",
  Fs.readFileSync(Path.join(root, "PACKAGE.ts"), "utf8"),
  TypeScript.ScriptTarget.Latest,
  true
)
const rules: Array<{ id: string; paths: Array<string> }> = []
const visit = (node: TypeScript.Node): void => {
  if (TypeScript.isObjectLiteralExpression(node)) {
    const properties = node.properties.filter(TypeScript.isPropertyAssignment)
    const property = (name: string) => properties.find((entry) => entry.name.getText(source) === name)?.initializer
    const id = property("id")
    const paths = property("paths")
    if (id && TypeScript.isStringLiteral(id) && paths && TypeScript.isArrayLiteralExpression(paths)) {
      const selected = paths.elements.filter(TypeScript.isStringLiteral).map((entry) => entry.text)
      if (selected.includes(wrapper)) rules.push({ id: id.text, paths: selected })
    }
  }
  TypeScript.forEachChild(node, visit)
}
visit(source)

describe("review implementation scope", () => {
  it("finds the actual platform implementation and the selectors that protect its wrapper", () => {
    expect(companions.length).toBeGreaterThan(0)
    expect(rules.length).toBeGreaterThan(0)
    for (const companion of companions) expect(Fs.statSync(Path.join(root, companion)).isFile()).toBe(true)
  })
  it.each(rules)("keeps the implementation in $id", ({ paths }) => {
    for (const companion of companions) expect(paths).toContain(companion)
  })
})
