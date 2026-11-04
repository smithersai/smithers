import { readFileSync } from "node:fs"
import ts from "typescript"
import { expect, test } from "vitest"

test("every SessionStore table reader is classified, and live readers use sessionLive", () => {
  const source = readFileSync(new URL("./SessionStore.ts", import.meta.url), "utf8")
  const file = ts.createSourceFile("SessionStore.ts", source, ts.ScriptTarget.Latest, true)
  const readers = file.statements.flatMap(statement => {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return []
    return statement.declarationList.declarations.flatMap(declaration => {
      const name = declaration.name.getText(file)
      const body = declaration.initializer?.getText(file) ?? ""
      return /\b(?:FROM|UPDATE|INTO) (?:sessions|host_sessions)\b/.test(body) || /findLiveBy\(/.test(body)
        ? [{ name, body }] : []
    })
  })
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
    const source = readFileSync(new URL(path, import.meta.url), "utf8")
    expect(source, path).toContain("sessionLive(")
    expect(source, path).not.toMatch(/revoked_at IS NULL AND (?:live\.)?expires_at > now\(\)/)
  }
})

test("the final write checks use the shared absolute deadline", () => {
  expect(readFileSync(new URL("./WriteAuthority.ts", import.meta.url), "utf8")).toContain("sessionDeadline(")
  expect(readFileSync(new URL("./runners/Fence.ts", import.meta.url), "utf8")).toContain("WriteAuthority.deadline(")
  expect(readFileSync(new URL("./stack/Stack.ts", import.meta.url), "utf8")).toContain("WriteAuthority.requireAtCommit(")
  const text = readFileSync(new URL("./branch/Texts.ts", import.meta.url), "utf8")
  expect(text).toContain("WriteAuthority.live(")
  expect(text).not.toContain("WriteAuthority.holds(")
})

test.each(["./Executions.ts", "./SocketChecks.ts"])("%s captures signing key IDs for its runtime authority checks", path => {
  const source = readFileSync(new URL(path, import.meta.url), "utf8")
  expect(source).toContain("signingKeyIds")
  expect(source).toMatch(/(?:SigningKeyIds|keyIds|configuredKeyIds)/)
})
