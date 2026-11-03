// The feed barrier script (ops/feed-barrier/confirm.ts): what it writes, that a second run writes nothing, how it
// finds production's database through Neon's API (the exact project, in the organization, on its default branch),
// the release from the deployed build, and that nothing it prints carries a key or a password, the real CLI included.
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { testFile } from "../../worker/test/harness.ts"
import { confirm, deployedBuild, idOf, neonUri, projectNamePattern, run } from "./confirm.ts"

const runtime = testFile("feed_barrier_script")

test("writes the barrier once: a second run finds it and writes nothing", async () => {
  const barrier = { id: idOf("74F62526544F"), release: "74f62526544f", by: "smithers-bc" }
  expect(barrier.id).toBe("r-74f62526544f")
  const first = await runtime.runPromise(confirm(barrier))
  expect(first).toMatchObject({ outcome: "written", id: "r-74f62526544f", release: "74f62526544f", confirmedBy: "smithers-bc", completedAt: null })
  const second = await runtime.runPromise(confirm({ ...barrier, by: "someone-else" }))
  expect(second).toMatchObject({ outcome: "existing", confirmedBy: "smithers-bc", confirmedAt: first.confirmedAt })
  expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT count(*)::int AS n FROM feed_barriers`)))
    .toEqual([{ n: 1 }])
})

/** Neon's API as it answers for a project named as Alchemy names one: `<stack>-ChatPostgres-<stage>-<suffix>`. */
const neon = (overrides: { readonly name?: string; readonly org?: string; readonly branches?: ReadonlyArray<{ id: string; default: boolean }> } = {}) => {
  const asked: Array<string> = []
  const fetch = (async (input: string) => {
    const url = new URL(input)
    asked.push(url.pathname.replace("/api/v2", "") + url.search)
    const path = url.pathname.replace("/api/v2", "")
    const body = path === "/projects/proud-sky-12345678"
      ? { project: { id: "proud-sky-12345678", name: overrides.name ?? "smithers-mvp-ChatPostgres-prod-a1b2c3d4", org_id: overrides.org ?? "org-smithers", default_branch_id: "br-main" } }
      : path === "/projects/proud-sky-12345678/branches"
      ? { branches: overrides.branches ?? [{ id: "br-main", default: true }, { id: "br-preview", default: false }] }
      : path === "/projects/proud-sky-12345678/branches/br-main/databases"
      ? { databases: [{ name: "neondb", owner_name: "neondb_owner" }] }
      : { uri: "postgresql://neondb_owner:sekret-pass@ep.example.neon.tech/neondb?sslmode=require&channel_binding=require" }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { asked, fetch }
}
const production = { key: "neon-key-xyz", orgId: "org-smithers", project: "proud-sky-12345678", stage: "prod" }

test("the exact project, checked against the organization and the stage's generated name, on its default branch", async () => {
  expect(projectNamePattern("prod").test("smithers-mvp-ChatPostgres-prod-a1b2c3d4")).toBe(true)
  expect(projectNamePattern("prod").test("smithers-mvp-ChatPostgres-dev_williamcory-a1b2c3d4")).toBe(false)
  const { asked, fetch } = neon()
  const uri = await neonUri(production, fetch)
  expect(Redacted.value(uri)).toBe("postgresql://neondb_owner:sekret-pass@ep.example.neon.tech/neondb?sslmode=verify-full")
  expect(String(uri)).not.toContain("sekret")
  expect(asked.at(-1)).toBe("/projects/proud-sky-12345678/connection_uri?branch_id=br-main&database_name=neondb&role_name=neondb_owner")
})

test("refuses another organization's project, another stage's, and a project with no single default branch", async () => {
  await expect(neonUri(production, neon({ org: "org-other" }).fetch)).rejects.toThrow("is in organization org-other, not NEON_ORG_ID's")
  await expect(neonUri(production, neon({ name: "smithers-mvp-ChatPostgres-dev_williamcory-a1b2c3d4" }).fetch))
    .rejects.toThrow("not the prod stage's database project")
  await expect(neonUri(production, neon({ branches: [] }).fetch)).rejects.toThrow("has no single default branch")
})

test("the release is the deployed build version.json names, and nothing else", async () => {
  const answering = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof globalThis.fetch
  expect(await deployedBuild("smithers.sh", answering({ build: "74f62526544f" }))).toBe("74f62526544f")
  await expect(deployedBuild("smithers.sh", answering({ build: "74f62526544f+" }))).rejects.toThrow("names no deployed revision")
  await expect(deployedBuild(undefined)).rejects.toThrow("APP_DOMAIN is not set")
})

test("a failure prints one scrubbed line: no key, no password, no connection string", async () => {
  const lines: Array<string> = []
  const io = { out: (line: string) => lines.push(`out ${line}`), err: (line: string) => lines.push(`err ${line}`) }
  // Neon refuses; the key must not appear.
  const refusing = (async () => new Response("{}", { status: 401 })) as unknown as typeof globalThis.fetch
  expect(await run(["--by", "bc", "--project", "proud-sky-12345678", "--release", "74f62526544f"],
    { NEON_API_KEY: "neon-key-xyz", NEON_ORG_ID: "org-smithers" }, io, refusing)).toBe(1)
  // The database refuses the URI Neon gave; the password and the URI must not appear.
  expect(await run(["--by", "bc", "--project", "proud-sky-12345678", "--release", "74f62526544f"],
    { NEON_API_KEY: "neon-key-xyz", NEON_ORG_ID: "org-smithers" }, io, (async (input: string) => {
      if (String(input).includes("connection_uri")) {
        return new Response(JSON.stringify({ uri: "postgresql://neondb_owner:sekret-pass@127.0.0.1:1/neondb" }))
      }
      return neon().fetch(input as never)
    }) as unknown as typeof globalThis.fetch)).toBe(1)
  expect(lines).toHaveLength(2)
  for (const line of lines) {
    expect(line).toMatch(/^err feed barrier not confirmed: /)
    expect(line).not.toMatch(/neon-key-xyz|sekret-pass|postgresql:\/\/neondb_owner:/)
  }
})

/** The real CLI with `DATABASE_URL`: its exit, its stdout and its stderr. */
const cli = (databaseUrl: string) => {
  const script = fileURLToPath(new URL("./confirm.ts", import.meta.url))
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    execFile(process.execPath, [script, "--by", "bc", "--release", "74f62526544f"], {
      env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl },
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      timeout: 60_000,
    }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : (error as { code?: number }).code ?? null, stdout, stderr })))
}

test.each([
  ["a database it can't reach", "postgresql://someone:cli-sekret@127.0.0.1:1/nothing", ["cli-sekret"]],
  ["a password with a malformed escape", "postgresql://someone:cli%ZZsekret@127.0.0.1:1/nothing", ["cli%ZZsekret", "ZZsekret"]],
  ["a password with escapes", "postgresql://someone:cli%40sek%2Fret@127.0.0.1:1/nothing", ["cli%40sek%2Fret", "cli@sek/ret"]],
  ["a URL that doesn't parse", "postgresql://someone:cli-sekret@host:notaport/nothing", ["cli-sekret"]],
  ["not a URL at all", "cli-sekret-not-a-url", ["cli-sekret"]],
])("the real CLI with %s: exit 1, nothing on stdout, one line on stderr, no secret", async (_name, url, secrets) => {
  const { code, stdout, stderr } = await cli(url)
  expect(code).toBe(1)
  expect(stdout).toBe("")
  expect(stderr.trim().split("\n")).toHaveLength(1)
  expect(stderr).toMatch(/^feed barrier not confirmed: /)
  for (const secret of secrets) expect(stderr).not.toContain(secret)
})
