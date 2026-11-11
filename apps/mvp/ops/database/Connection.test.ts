import { execFile } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

/** Where an issued token would go: a fresh path each run, since the issuer refuses a file already there. */
const tokenFile = () => join(mkdtempSync(join(tmpdir(), "machine-")), "token")

/**
 * Every standalone command that opens DATABASE_URL: its arguments, what its failure line begins with, and whether a
 * permitted URL reaches the driver before anything else can fail (the cutover asks Cloudflare first).
 */
const commands = [
  { name: "feed-barrier/confirm.ts", script: "feed-barrier/confirm.ts", args: () => ["--by", "test", "--release", "aaaaaaaaaaaa"], prefix: "feed barrier not confirmed: ", driver: true },
  { name: "role-age/expire.ts", script: "role-age/expire.ts", args: () => ["--repo", "a/b", "--person", "test"], prefix: "role row not aged: ", driver: true },
  { name: "machine-token/issue.ts", script: "machine-token/issue.ts", args: () => ["--repo", "a/b", "--agent", "fixer", "--lane", "lane-1", "--by", "test", "--out", tokenFile()], prefix: "", driver: true },
  { name: "machine-token/issue.ts --revoke", script: "machine-token/issue.ts", args: () => ["--revoke", "a".repeat(64), "--by", "test"], prefix: "", driver: true },
  { name: "runner-cutover/cutover.ts", script: "runner-cutover/cutover.ts", args: () => ["--by", "test", "--release", "aaaaaaaaaaaa", "--worker", "ChatApi"], prefix: "runner cutover not done: ", driver: false },
] as const

const cli = (command: typeof commands[number], database: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
  const script = fileURLToPath(new URL(`../${command.script}`, import.meta.url))
  execFile(process.execPath, [script, ...command.args()], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      PATH: process.env.PATH, DATABASE_URL: database,
      APP_DOMAIN: "deployment.invalid", CLOUDFLARE_API_TOKEN: "private-token", CLOUDFLARE_ACCOUNT_ID: "account",
    },
    timeout: 20_000,
  }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : (error as { code?: number }).code ?? null, stdout, stderr }))
})

const unsafe = ["", "?sslmode=disable", "?sslmode=prefer", "?sslmode=allow", "?sslmode=require", "?sslmode=verify-ca", "?sslmode=unknown", "?sslmode=require&channel_binding=require"]
for (const command of commands) {
  test.each(unsafe)(`${command.name} refuses remote DATABASE_URL %s before network access, naming only its host`, async (query) => {
    const database = `postgresql://private-user:private-pass@database.invalid:6543/private-db${query}`
    const result = await cli(command, database)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr.trim()).toBe(`${command.prefix}DATABASE_URL for database.invalid requires sslmode=verify-full or sslmode=require with a pinned CA`)
    expect(result.stderr).not.toMatch(/postgres|private-user|private-pass|private-db|6543|private-token/)
  })
}

for (const command of commands.filter((command) => command.driver)) {
  test.each(["localhost", "127.0.0.1", "127.0.0.2", "[::1]"])(`${command.name} permits loopback %s without TLS`, async (host) => {
    const result = await cli(command, `postgresql://private-user:private-pass@${host}:1/private-db`)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr.trim()).toBe(`${command.prefix}database operation failed for ${host.replace(/^\[|\]$/g, "")}`)
  })
  test(`${command.name} admits remote verify-full to the driver`, async () => {
    const result = await cli(command, "postgresql://private-user:private-pass@database.invalid/private-db?sslmode=verify-full")
    expect(result.code).toBe(1)
    expect(result.stderr.trim()).toBe(`${command.prefix}database operation failed for database.invalid`)
  })
}
for (const command of commands) {
  test(`${command.name} refuses a loopback host override before network access`, async () => {
    const result = await cli(command, "postgresql://private-user:private-pass@localhost/private-db?host=database.invalid")
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr.trim()).toBe(`${command.prefix}DATABASE_URL for localhost has unsupported endpoint overrides`)
  })
}
