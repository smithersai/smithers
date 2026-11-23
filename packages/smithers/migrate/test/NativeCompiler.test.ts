import * as Ast from "typescript/unstable/ast"
import { describe, expect, it } from "vitest"
import * as Ts from "../src/internal/Ts.ts"

describe("native migration syntax compiler", () => {
  it.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "TSX"])(
    "preserves imports and source positions in %s after closing its compiler",
    (extension) => {
      const source = Ts.parse(`flow.${extension}`, `// 😀\r\nimport { Task as T } from "smthrs";\r\n`)
      expect(Ts.imports(source)).toEqual([{
        specifier: "smthrs",
        names: new Map([["T", "Task"]]),
        namespace: undefined,
        typeOnly: false,
        line: 2,
        column: 1
      }])
      expect(source.statements[0]!.getText()).toBe(`import { Task as T } from "smthrs";`)
    }
  )

  it("distinguishes type-phase imports from runtime imports", () => {
    const source = Ts.parse(
      "flow.ts",
      [
        `import type { Task } from "smthrs"`,
        `import type * as Types from "smthrs"`,
        `import { type OnlyType, Task as T } from "smthrs"`,
        `export type { Task } from "smthrs"`
      ].join("\n")
    )
    const imports = Ts.imports(source)
    expect(imports.map((entry) => entry.typeOnly)).toEqual([true, true, false, true])
    expect(imports[1]!.namespace).toBe("Types")
    expect(imports[2]!.names).toEqual(new Map([["T", "Task"]]))
  })

  it("recovers old package references before and after malformed syntax", () => {
    const source = Ts.parse("flow.ts", `import "smthrs";\nconst broken = ;\nexport * from "old-package";`)
    expect(Ts.moduleSpecifiers(source)).toEqual([
      { specifier: "smthrs", form: "import", line: 1, column: 1 },
      { specifier: "old-package", form: "export", line: 3, column: 1 }
    ])
  })

  it("inspects JSX attributes and parent links without executing the source", () => {
    const source = Ts.parse(
      "flow.tsx",
      `throw new Error("must not execute");\nconst task = <Task id="read" {...opts}>body</Task>`
    )
    let opening: Ast.JsxOpeningElement | undefined
    Ts.forEachNode(source, (node) => {
      if (Ast.isJsxOpeningElement(node)) opening = node
    })
    expect(opening).toBeDefined()
    expect(Ts.tagName(opening!)).toBe("Task")
    expect(Ts.attributeNames(opening!)).toEqual(["id", "..."])
    expect(Ts.attributeLiteral(opening!, "id")).toBe("read")
    expect(Ast.isJsxElement(opening!.parent)).toBe(true)
  })

  it("finds literal CommonJS and dynamic imports but not strings or comments", () => {
    const source = Ts.parse(
      "flow.ts",
      [
        `import legacy = require("legacy")`,
        "require(`commonjs`)",
        "import(`dynamic`)",
        `const text = 'require("fake")'`,
        `// import("fake")`
      ].join("\n")
    )
    expect(Ts.moduleSpecifiers(source)).toEqual([
      { specifier: "legacy", form: "require", line: 1, column: 1 },
      { specifier: "commonjs", form: "require", line: 2, column: 1 },
      { specifier: "dynamic", form: "dynamic", line: 3, column: 1 }
    ])
  })

  it("sanitizes unpaired UTF-16 surrogates instead of crashing the native TypeScript compiler", () => {
    const source = Ts.parse("surrogate.ts", "const x = \"\ud800\"")
    expect(source.text).toBeDefined()
  })
})
