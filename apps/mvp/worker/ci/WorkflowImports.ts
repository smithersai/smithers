import { parse } from "@babel/parser"
import type { Node } from "@babel/types"

/** Check the original TypeScript before compilation can erase unused or type-only imports. */
export const importRefusal = (source: string, modules: readonly string[]): "syntax" | "import" | undefined => {
  let program
  try {
    program = parse(source, { sourceType: "module", plugins: ["typescript"], createImportExpressions: true }).program
  } catch {
    return "syntax"
  }
  const pending: Node[] = [program]
  while (pending.length > 0) {
    const node = pending.pop()!
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration":
        if (node.source && !modules.includes(node.source.value)) return "import"
        break
      case "ImportExpression":
      case "TSImportEqualsDeclaration":
      case "TSImportType":
        return "import"
      case "CallExpression":
      case "OptionalCallExpression":
        if (node.callee.type === "Identifier" && node.callee.name === "require") return "import"
        if ((node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression") &&
            !node.callee.computed && node.callee.property.type === "Identifier" &&
            (node.callee.property.name === "require" || node.callee.property.name === "import")) return "import"
        break
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "extra" || key.endsWith("Comments")) continue
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child !== null && typeof child === "object" && typeof child.type === "string") pending.push(child)
      }
    }
  }
  return undefined
}
