import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const root = fileURLToPath(new URL("../../../..", import.meta.url))
const gate = readFileSync(join(root, ".smithers/flows/land/lane-gates.sh"), "utf8")
// Execute the gate's actual database block, without its unrelated VCS/landing operations.
const block = gate.slice(gate.indexOf("# PostgreSQL is required:"), gate.indexOf("# 1. The gates"))
const unsafe = ["", "?sslmode=disable", "?sslmode=prefer", "?sslmode=allow", "?sslmode=require", "?sslmode=verify-ca", "?sslmode=unknown", "?sslmode=require&channel_binding=require"]
const database = (query: string) => `postgresql://private-user:private-pass@database.invalid:6543/private-db${query}`
const refusal = "DATABASE_URL for database.invalid requires sslmode=verify-full or sslmode=require with a pinned CA"

for (const query of unsafe) {
  test(`migration refuses remote ${query || "no TLS"} before a connection`, () => {
    const result = spawnSync(process.execPath, ["db/migrate.ts"], {
      cwd: join(root, "apps/mvp"), encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, DATABASE_URL: database(query) },
    })
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain(refusal)
    expect(result.stdout + result.stderr).not.toMatch(/private-user|private-pass|private-db|6543|postgresql:\/\//)
  })
  test(`lane gate refuses remote ${query || "no TLS"} and persists host-only refusal`, () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-tls-"))
    try {
      const log = join(dir, "gate.log")
      const result = spawnSync("bash", ["-c", 'root=$1; log=$2; : > "$log"\n' + block, "_", root, log], {
        encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH, SMITHERS_TEST_DATABASE_URL: database(query) },
      })
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain(refusal)
      expect(readFileSync(log, "utf8")).toContain(refusal)
      expect(result.stdout + result.stderr + readFileSync(log, "utf8")).not.toMatch(/private-user|private-pass|private-db|6543|postgresql:\/\//)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test(`host recorder refuses remote ${query || "no TLS"} at its subprocess boundary`, () => {
    const program = `import { run } from ${JSON.stringify(join(root, ".smithers/flows/release/host/host-maintenance-evidence.mjs"))};
      try { await run('/usr/bin/true', [], {env: {PGDATABASE: process.env.DATABASE_URL}}); console.log('CONNECTED'); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH, DATABASE_URL: database(query) },
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr.trim()).toBe(refusal)
  })
}

test("gate failure stdout and persistent log contain the hostname only", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-tls-"))
  try {
    const log = join(dir, "gate.log")
    const result = spawnSync("bash", ["-c", 'root=$1; log=$2; : > "$log"\n' + block, "_", root, log], {
      encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, SMITHERS_TEST_DATABASE_URL: "postgresql://private-user:private-pass@127.0.0.1:1/private-db?connect_timeout=1" },
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("BLOCKED: no PostgreSQL at 127.0.0.1")
    expect(readFileSync(log, "utf8")).toBe(result.stdout)
    expect(result.stdout + result.stderr).not.toMatch(/private-user|private-pass|private-db|postgresql:\/\//)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const [script, args] of [
  ["ops/feed-barrier/confirm.ts", ["--by", "test", "--release", "aaaaaaaaaaaa"]],
  ["ops/role-age/expire.ts", ["--repo", "a/b", "--person", "test"]],
] as const) test(`${script} does not relay nested URL driver messages`, () => {
  const value = "postgresql://private-user:private-pass@database.invalid/private-db?sslmode=verify-full&connect_timeout=" + encodeURIComponent("postgresql://otheruser:otherpass@otherhost/otherdatabase")
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: join(root, "apps/mvp"), encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, DATABASE_URL: value, APP_DOMAIN: "deployment.invalid", CLOUDFLARE_API_TOKEN: "private-token", CLOUDFLARE_ACCOUNT_ID: "account" },
  })
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("database operation failed for database.invalid")
  expect(result.stderr).not.toMatch(/postgresql|otheruser|otherpass|otherhost|otherdatabase|private-user|private-pass|private-db/)
})


test("host recorder does not relay synchronous process-validation errors containing decoded connection fields", () => {
  const program = `import { run } from ${JSON.stringify(join(root, ".smithers/flows/release/host/host-maintenance-evidence.mjs"))};
    try { await run('/usr/bin/true', [], {env: {PGDATABASE: process.env.DATABASE_URL}}); }
    catch (error) { console.error(error.message); process.exitCode = 1; }`
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, DATABASE_URL: "postgresql://private-user:private%00pass@localhost/private-db" },
  })
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr.trim()).toBe("database operation failed for localhost")
})
