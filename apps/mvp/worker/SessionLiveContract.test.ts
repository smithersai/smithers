import ts from "typescript"
import { expect, test } from "vitest"
import { sourceText, typeScriptOf } from "../../../packages/repo-targets/test-utils/source-readers.mjs"

/**
 * The exported readers of the sessions tables in module `path`: each exported constant or function whose body names
 * one, read from its TypeScript (a .vibe module's projection, where `export effect function` is a function).
 */
const tableReaders = (path: string | URL) => {
  const file = ts.createSourceFile("module.ts", typeScriptOf(path), ts.ScriptTarget.Latest, true)
  const exported = (node: ts.Node) => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
  const reads = (body: string) => /\b(?:FROM|UPDATE|INTO) (?:sessions|host_sessions)\b/.test(body) || /findLiveBy\(/.test(body)
  return file.statements.flatMap(statement => {
    if (!exported(statement)) return []
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      const body = statement.body.getText(file)
      return reads(body) ? [{ name: statement.name.text, body }] : []
    }
    if (!ts.isVariableStatement(statement)) return []
    return statement.declarationList.declarations.flatMap(declaration => {
      const body = declaration.initializer?.getText(file) ?? ""
      return reads(body) ? [{ name: declaration.name.getText(file), body }] : []
    })
  })
}

test("finds the table readers of a module converted to VibeLang as it finds its TypeScript twin's", () => {
  const twins = new URL("../tests/fixtures/source-readers/", import.meta.url)
  expect(tableReaders(new URL("vibe/Twin.ts", twins)).map(r => r.name)).toEqual(["sweep"])
  expect(tableReaders(new URL("vibe/Twin.ts", twins)).map(r => r.name)).toEqual(tableReaders(new URL("ts/Twin.ts", twins)).map(r => r.name))
})

test("every SessionStore table reader is classified, and live readers use sessionLive", () => {
  const source = sourceText(new URL("./SessionStore.ts", import.meta.url))
  const readers = tableReaders(new URL("./SessionStore.ts", import.meta.url))
  const live = ["reauthCandidate", "reauthenticateHost", "credentialStale", "createHostSession", "deploymentMember", "findHostLive", "findLive", "findLiveById", "authority", "held", "renew"]
  const other = ["reauthenticate", "latestRole", "latestRoleVerifiedAt", "createSession", "ownerOf", "revokeHost", "hostOwnerOf", "signingOut", "forgetTokens", "replaceTokens", "setRole", "keepRole"]
  expect(readers.map(r => r.name).sort()).toEqual([...live, ...other].sort())
  for (const reader of readers.filter(r => live.includes(r.name))) {
    if (["findLive", "findLiveById"].includes(reader.name)) {
      expect(source.slice(source.indexOf("const findLiveBy"), source.indexOf("export interface Authority"))).toContain("sessionLive(")
    } else expect(reader.body, reader.name).toContain("sessionLive(")
  }
})

// These authority paths consume session rows outside SessionStore, so the export inventory alone cannot see them.
test("token use and notification audiences share the absolute session bound", () => {
  for (const path of ["./github/Store.ts", "./Notifications.ts", "./flows/SandboxSpend.ts", "./WriteAuthority.ts"]) {
    const source = sourceText(new URL(path, import.meta.url))
    expect(source, path).toContain("sessionLive(")
    expect(source, path).not.toMatch(/revoked_at IS NULL AND (?:live\.)?expires_at > now\(\)/)
  }
})

test("the final write checks use the shared absolute deadline", () => {
  expect(sourceText(new URL("./WriteAuthority.ts", import.meta.url))).toContain("sessionDeadline(")
  expect(sourceText(new URL("./runners/Fence.ts", import.meta.url))).toContain("WriteAuthority.deadline(")
  expect(sourceText(new URL("./stack/Stack.ts", import.meta.url))).toContain("WriteAuthority.requireAtCommit(")
  const text = sourceText(new URL("./branch/Texts.ts", import.meta.url))
  expect(text).toContain("WriteAuthority.live(")
  expect(text).not.toContain("WriteAuthority.holds(")
})

test.each(["./Executions.ts", "./SocketChecks.ts"])("%s captures signing key IDs for its runtime authority checks", path => {
  const source = sourceText(new URL(path, import.meta.url))
  expect(source).toContain("signingKeyIds")
  expect(source).toMatch(/(?:SigningKeyIds|keyIds|configuredKeyIds)/)
})
