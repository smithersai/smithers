// Issuing a machine token (ops/machine-token/issue.ts): only its digest reaches the database, and the file is private.
import { digestSync } from "@smthrs/crypto"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { testFile } from "../../worker/test/harness.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { issue, newToken, requestOf, revoke, writeToken } from "./issue.ts"

const runtime = testFile("machine_token_script")

test("writes the digest with the agent, lane, scope and a 7-day end, never the token", async () => {
  const token = newToken()
  expect(token).toMatch(/^smm_[\w-]{43}$/)
  const line = await runtime.runPromise(issue(token, requestOf({ repo: "acme/widgets", agent: "fixer", lane: "lane-1", by: "ops" })))
  expect(line).toMatchObject({ event: "machine_token.issued", digest: digestSync(token), agent: "fixer", lane: "lane-1", by: "ops" })
  expect(JSON.stringify(line)).not.toContain(token)
  const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<Record<string, unknown>>`
    SELECT token_sha256 AS digest, repo_id AS repo, scope, round(extract(epoch FROM expires_at - issued_at) / 86400) AS days FROM machine_tokens`))
  expect(rows).toEqual([{ digest: digestSync(token), repo: "github/acme/widgets", scope: ["issue/create", "issue/update", "issue/comment", "issue/relate", "work/link"], days: expect.anything() }])
  expect(Number(rows[0]!.days)).toBe(7)
  expect(await runtime.runPromise(revoke(digestSync(token), "ops"))).toMatchObject({ revoked: 1 })
})

test("refuses a scope outside a machine's, a longer life, and an unnamed agent", () => {
  const base = { repo: "acme/widgets", agent: "fixer", lane: "lane-1", by: "ops" }
  expect(() => requestOf({ ...base, scope: "todo/commit" })).toThrow("--scope names todo/commit")
  expect(() => requestOf({ ...base, days: "30" })).toThrow("at most 7")
  expect(() => requestOf({ ...base, agent: undefined })).toThrow("--agent")
  // A work link's source joins them with `/`, so a slash in either could read as the other's.
  // The routes look a repository up by its lowercased id, so a token issued for `Acme/Widgets` must match it.
  expect(requestOf({ ...base, repo: "Acme/Widgets" }).repoId).toBe("github/acme/widgets")
  expect(() => requestOf({ ...base, agent: "a/b", lane: "c" })).toThrow("--agent")
  expect(() => requestOf({ ...base, agent: "a", lane: "b/c" })).toThrow("--lane")
})

test("asking a person is a scope a token holds only when named", () => {
  const base = { repo: "acme/widgets", agent: "fixer", lane: "lane-1", by: "ops" }
  expect(requestOf(base).scope).not.toContain("ask/create")
  expect(requestOf({ ...base, scope: "ask/create,issue/comment" }).scope).toEqual(["ask/create", "issue/comment"])
})

test("the file is created mode 600 and never overwrites", () => {
  const path = join(mkdtempSync(join(tmpdir(), "machine-")), "token")
  writeToken(path, "smm_secret")
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readFileSync(path, "utf8")).toBe("smm_secret\n")
  expect(() => writeToken(path, "smm_other")).toThrow()
})
