import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, chownSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { layer, sslFor } from "./Connection.ts"

// Own a real TLS Postgres, including a CA that the default public roots cannot trust.
// No external URL or production credentials. Missing server tools are explicit skips.
const tools = ["initdb", "postgres", "openssl"]
const available = tools.every((tool) => {
  try { execFileSync(tool, [tool === "openssl" ? "version" : "--version"], { stdio: "ignore" }); return true } catch { return false }
})
let directory: string
let port: number
let server: ChildProcess | undefined
const run = (command: string, args: ReadonlyArray<string>) => execFileSync(command, [...args], { cwd: directory, stdio: "pipe" })

beforeAll(async () => {
  if (!available) return
  directory = mkdtempSync("/tmp/mvp-ops-tls-")
  for (const name of ["ca", "other"]) {
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=ops-test-${name}`,
      "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", `${name}.key`, "-out", `${name}.crt`])
  }
  run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", "server.key", "-out", "server.csr"])
  chmodSync(join(directory, "server.key"), 0o600)
  writeFileSync(join(directory, "extensions"), "subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n")
  run("openssl", ["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", "extensions", "-out", "server.crt"])
  writeFileSync(join(directory, "password"), "test-password\n", { mode: 0o600 })
  // lat-run's app namespace maps lane to root. Only the owned server drops to its unprivileged mapped uid.
  const identity = process.getuid?.() === 0 ? { uid: 1, gid: 1 } : {}
  if (identity.uid !== undefined) {
    chownSync(directory, identity.uid, identity.gid!)
    for (const file of readdirSync(directory)) chownSync(join(directory, file), identity.uid, identity.gid!)
  }
  execFileSync("initdb", ["-D", join(directory, "data"), "--username=ops_tls", "--auth-host=scram-sha-256", "--auth-local=trust", `--pwfile=${join(directory, "password")}`, "--no-locale", "--encoding=UTF8"],
    { cwd: directory, stdio: "pipe", ...identity })
  port = await new Promise<number>((resolve, reject) => {
    const socket = createServer()
    socket.on("error", reject)
    socket.listen(0, "127.0.0.1", () => { const address = socket.address() as { port: number }; socket.close(() => resolve(address.port)) })
  })
  server = spawn("postgres", ["-D", join(directory, "data"), "-h", "127.0.0.1", "-p", String(port), "-k", directory,
    "-c", "ssl=on", "-c", `ssl_cert_file=${join(directory, "server.crt")}`, "-c", `ssl_key_file=${join(directory, "server.key")}`],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"], ...identity })
  await new Promise<void>((resolve, reject) => {
    let output = ""
    server!.on("error", reject)
    server!.once("exit", (code) => reject(new Error(`TLS fixture exited ${code}: ${output}`)))
    server!.stderr!.on("data", (chunk) => {
      output += String(chunk)
      if (output.includes("ready to accept connections")) resolve()
    })
  })
})

afterAll(async () => {
  if (server !== undefined && server.exitCode === null) {
    const stopped = new Promise<void>((resolve) => server!.once("exit", () => resolve()))
    server.kill("SIGTERM")
    await stopped
  }
  if (directory !== undefined && existsSync(directory)) rmSync(directory, { recursive: true, force: true })
})

const query = (options: { pin?: "ca" | "other"; trust?: "ca" | "other"; host?: string; neon?: boolean; optout?: boolean }) => {
  const connection = fileURLToPath(new URL("./Connection.ts", import.meta.url))
  const program = `
    import { Effect, Redacted } from "effect";
    import { SqlClient } from "effect/sql";
    import { layer, neonConnectionUri } from ${JSON.stringify(connection)};
    try {
      const url = process.env.OPS_TEST_NEON === "1" ? neonConnectionUri(process.env.DATABASE_URL) : Redacted.make(process.env.DATABASE_URL);
      const rows = await Effect.runPromise(Effect.scoped(Effect.flatMap(SqlClient.SqlClient, sql => sql\`SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()\`).pipe(Effect.provide(layer(url)))));
      console.log(JSON.stringify(rows));
    } catch (error) {
      const code = error?.reason?.cause?.code ?? error?.cause?.reason?.cause?.code ?? "unknown";
      console.error(code);
      process.exitCode = 1;
    }
  `
  const url = new URL(`postgresql://ops_tls:test-password@${options.host ?? "localhost"}:${port}/postgres`)
  url.searchParams.set("sslmode", options.neon || options.pin ? "require" : "verify-full")
  if (options.neon) url.searchParams.set("channel_binding", "require")
  if (options.pin) url.searchParams.set("sslrootcert", join(directory, `${options.pin}.crt`))
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    execFile(process.execPath, ["--input-type=module", "--eval", program], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: {
        PATH: process.env.PATH, DATABASE_URL: url.toString(), OPS_TEST_NEON: options.neon ? "1" : "0",
        ...(options.trust ? { NODE_EXTRA_CA_CERTS: join(directory, `${options.trust}.crt`) } : {}),
        // Even an inherited/global verification opt-out must not defeat explicit client verification.
        ...(options.optout ? { NODE_TLS_REJECT_UNAUTHORIZED: "0" } : {}),
      }, timeout: 15_000,
    }, (error, out, err) => resolve({ code: error === null ? 0 : (error as { code?: number }).code ?? null, out, err }))
  })
}

test.skipIf(!available)("Neon's require + channel_binding API URL connects with verify-full and the process root store", async () => {
  const result = await query({ neon: true, trust: "ca" })
  expect(result.err).toBe("")
  expect(result.code).toBe(0)
  expect(JSON.parse(result.out)).toEqual([{ ssl: true, version: expect.stringMatching(/^TLSv1\.[23]$/) }])
})

test.skipIf(!available)("the Neon-derived path rejects an untrusted issuer, even with the global TLS opt-out", async () => {
  const result = await query({ neon: true, optout: true })
  expect(result.code).toBe(1)
  expect(result.out).toBe("")
  expect(result.err).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/)
})

test.skipIf(!available)("the Neon-derived path rejects the wrong hostname despite a trusted issuer", async () => {
  const result = await query({ neon: true, trust: "ca", host: "127.0.0.1" })
  expect(result.code).toBe(1)
  expect(result.err).toContain("ERR_TLS_CERT_ALTNAME_INVALID")
})

test.skipIf(!available)("require with a pinned CA connects using that CA rather than unrelated process roots", async () => {
  const result = await query({ pin: "ca", trust: "other" })
  expect(result.err).toBe("")
  expect(result.code).toBe(0)
  expect(JSON.parse(result.out)[0].ssl).toBe(true)
})

test.skipIf(!available)("require with the wrong pinned CA rejects the server despite trusted process roots", async () => {
  const result = await query({ pin: "other", trust: "ca" })
  expect(result.code).toBe(1)
  expect(result.err).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/)
})

test.skipIf(!available)("require with a pinned CA still verifies the hostname", async () => {
  const result = await query({ pin: "ca", host: "127.0.0.1" })
  expect(result.code).toBe(1)
  expect(result.err).toContain("ERR_TLS_CERT_ALTNAME_INVALID")
})

test.skipIf(!available)("a server leaf certificate cannot masquerade as a pinned CA", () => {
  const url = new URL("postgresql://private-user:private-pass@database.invalid/private-db?sslmode=require")
  url.searchParams.set("sslrootcert", join(directory, "server.crt"))
  expect(() => sslFor(Redacted.make(url.toString()))).toThrow(/^DATABASE_URL for database.invalid has an unusable pinned CA$/)
})

test.skipIf(!available)("the shared ops layer performs a verified TLS query on its owned Postgres", async () => {
  const url = new URL(`postgresql://ops_tls:test-password@localhost:${port}/postgres?sslmode=require`)
  url.searchParams.set("sslrootcert", join(directory, "ca.crt"))
  const rows = await Effect.runPromise(Effect.scoped(Effect.flatMap(SqlClient.SqlClient,
    (sql) => sql`SELECT ssl, current_user AS person FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
  ).pipe(Effect.provide(layer(Redacted.make(url.toString()))))))
  expect(rows).toEqual([{ ssl: true, person: "ops_tls" }])
})

// The exact boundary used by Alchemy's ChatMigrations action, with a Neon-shaped URI and a real TLS server.
test.skipIf(!available)("deploy migration boundary normalizes Neon's URI and applies all migrations over verified TLS", async () => {
  const { migrate, neonConnectionUri } = await import("./Connection.ts")
  const connection = neonConnectionUri(`postgresql://ops_tls:test-password@localhost:${port}/postgres?sslmode=require&channel_binding=require&sslrootcert=${encodeURIComponent(join(directory, "ca.crt"))}`)
  expect(new URL(Redacted.value(connection)).searchParams.get("sslmode")).toBe("verify-full")
  await Effect.runPromise(Effect.scoped(migrate(connection)))
  await Effect.runPromise(Effect.scoped(migrate(connection)))
  const rows = await Effect.runPromise(Effect.scoped(Effect.flatMap(SqlClient.SqlClient,
    sql => sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'feed_barriers'`,
  ).pipe(Effect.provide(layer(connection)))))
  expect(rows).toEqual([{ n: 1 }])
})

test.skipIf(!available)("standalone migrations succeed on loopback and verify-full with a pinned CA", () => {
  for (const query of ["", `?sslmode=require&sslrootcert=${encodeURIComponent(join(directory, "ca.crt"))}`]) {
    const result = execFileSync(process.execPath, ["db/migrate.ts"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8", timeout: 20_000,
      env: { PATH: process.env.PATH, DATABASE_URL: `postgresql://ops_tls:test-password@localhost:${port}/postgres${query}` },
    })
    expect(result).toContain("db:migrate: up to date")
  }
})

const hasPsql = (() => { try { execFileSync("psql", ["--version"], { stdio: "ignore" }); return true } catch { return false } })()
for (const { host, pin, success } of [
  { host: "localhost", pin: "ca", success: true },
  { host: "127.0.0.1", pin: "ca", success: false },
  { host: "localhost", pin: "other", success: false },
  { host: "localhost", pin: undefined, success: false },
]) test.skipIf(!available || !hasPsql)(`host recorder libpq verifies chain and hostname: ${host}, ${pin ?? "system roots"}`, async () => {
  const { run } = await import(/* @vite-ignore */ new URL("../../../../.smithers/flows/release/host/host-maintenance-evidence.mjs", import.meta.url).href)
  const psql = execFileSync("which", ["psql"], { encoding: "utf8" }).trim()
  const uri = `postgresql://ops_tls:test-password@${host}:${port}/postgres?${pin === undefined ? "sslmode=verify-full" : `sslmode=require&sslrootcert=${encodeURIComponent(join(directory, `${pin}.crt`))}`}`
  const pending = run(psql, ["-X", "-Atc", "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"], { env: { PGDATABASE: uri }, expected: null })
  const result = await pending
  if (success) {
    if (result.status !== 0) {
      const { libpqEnvironment } = await import("./Policy.ts")
      const raw = spawnSync(psql, ["-X", "-Atc", "SELECT 1"], { encoding: "utf8", env: libpqEnvironment(uri) })
      // Classify this owned fixture's failure without printing driver text or a URL.
      const classes = ["certificate", "hostname", "host name", "SSL", "GSS", "password", "authentication", "role", "database", "refused", "resolve", "invalid", "permission", "root", "parameter", "read-only", "key", "file", "exist", "socket", "not supported"]
      throw new Error(`owned psql failure ${raw.status}: ${classes.filter(word => raw.stderr.includes(word)).join(", ")}`)
    }
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("t")
    expect(result.stderr).toBe("")
  } else {
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe(`database operation failed for ${host}`)
    expect(JSON.stringify(result)).not.toMatch(/postgresql|test-password|ops_tls/)
  }
})


test.skipIf(!available || !hasPsql)("lane readiness connects over verified libpq TLS and retains its real readiness fallback", async () => {
  const { probe } = await import("./Probe.ts")
  const uri = `postgresql://ops_tls:test-password@localhost:${port}/postgres?sslmode=require&sslrootcert=${encodeURIComponent(join(directory, "ca.crt"))}`
  expect(probe(uri, { PATH: process.env.PATH })).toEqual({ code: 0 })
  // Wrong authentication makes the SQL probe fail; the real server still answers libpq's readiness probe.
  expect(probe(uri.replace("test-password", "wrong-password"), { PATH: process.env.PATH })).toEqual({ code: 0 })
})
