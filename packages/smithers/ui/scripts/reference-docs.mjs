/** Inspect public source declarations without importing browser components. */
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import ts from "typescript"

const bindings = (name) => ts.isIdentifier(name) ? [name.text] :
  name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindings(element.name))

/** Collect every exported declaration, including erased types and aliases. */
export function exportedNames(url, visited = new Set()) {
  if (visited.has(url.href)) return []
  visited.add(url.href)
  const file = ts.createSourceFile(url.pathname, readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true)
  const names = []
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause && ts.isNamedExports(clause)) {
        names.push(...clause.elements.map((element) => element.name.text))
      } else if (clause && ts.isNamespaceExport(clause)) {
        names.push(clause.name.text)
      } else {
        const path = statement.moduleSpecifier?.text
        const target = [path, `${path}.ts`, `${path}.tsx`, `${path}.vibe`, `${path}/index.ts`, `${path}/index.tsx`, `${path}/index.vibe`]
          .map((path) => new URL(path, url))
          .find((candidate) => /\.(?:ts|tsx|vibe)$/.test(candidate.pathname) && existsSync(candidate))
        assert.ok(target, `resolve public wildcard: ${path}`)
        names.push(...exportedNames(target, visited))
      }
    } else if (ts.isExportAssignment(statement)) {
      names.push("default")
    } else if (ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.getModifiers(statement).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) names.push("default")
      else if (ts.isVariableStatement(statement)) names.push(...statement.declarationList.declarations.flatMap((declaration) => bindings(declaration.name)))
      else if (statement.name) names.push(statement.name.text)
    }
  }
  return [...new Set(names)]
}

/** Only code in the API page counts; prose and mentions in guides do not. */
export function missingReferenceNames(names, api) {
  const code = [
    ...api.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm),
    ...api.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "").matchAll(/`([^`\n]+)`/g),
  ].map((match) => match[1]).join("\n")
  return names.filter((name) => !new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).test(code))
}

/** Each manifest entry names source and receives its own API check. */
export function publicEntries(manifest) {
  return Object.entries(manifest.exports).map(([subpath, conditions]) => ({
    specifier: subpath === "." ? manifest.name : manifest.name + subpath.slice(1),
    path: typeof conditions === "string" ? conditions : conditions.types ?? conditions.import ?? conditions.default,
  }))
}
