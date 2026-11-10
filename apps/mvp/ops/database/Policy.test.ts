import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates } from "node:tls"
import { Redacted } from "effect"
import { afterAll, expect, test } from "vitest"
import { diagnostic, neonConnectionUri, sslFor } from "./Connection.ts"
import { libpqEnvironment } from "./Policy.ts"

const directory = mkdtempSync(join(tmpdir(), "ops-ca-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const ssl = (value: string) => sslFor(Redacted.make(value))
const uri = "postgresql://private-user:private-pass@database.invalid:6543/private-db"

// A real public CA, without needing production credentials or any network operation.
const pin = join(directory, "trusted.crt")
writeFileSync(pin, getCACertificates("default")[0]!)
const invalid = join(directory, "invalid.crt")
writeFileSync(invalid, "not a CA")

test.each(["localhost", "LOCALHOST", "localhost.", "127.0.0.1", "127.255.255.255", "[::1]"])("loopback %s is allowed", (host) => {
  expect(ssl(`postgresql://user:password@${host}/local`)).toBeUndefined()
})

test.each(["localhost.example", "127.example", "128.0.0.1", "[::2]", "[::ffff:7f00:1]"])("%s cannot claim the loopback exception", (host) => {
  expect(() => ssl(`postgresql://user:password@${host}/remote`)).toThrow("requires sslmode=verify-full")
})

test.each(["not-a-url", "postgresql://user:password@host:notaport/db", "https://database.invalid/private", "postgresql:///db"])("malformed input refuses without echoing %s", (value) => {
  expect(() => ssl(value)).toThrow(/^DATABASE_URL is not a valid Postgres URL$/)
})

test.each(["host=database.invalid", "hostaddr=192.0.2.1", "port=5432"])("rejects endpoint override %s", (query) => {
  expect(() => ssl(`postgresql://user:password@localhost/local?${query}`)).toThrow(/^DATABASE_URL for localhost has unsupported endpoint overrides$/)
})

test.each(["sslmode=verify-full&sslmode=disable", "sslmode=disable&sslmode=verify-full", "sslmode=require&sslrootcert=a&sslrootcert=b"])("rejects ambiguous parameters %s", (query) => {
  expect(() => ssl(`${uri}?${query}`)).toThrow(/^DATABASE_URL for database.invalid has ambiguous TLS parameters$/)
})

test("verify-full uses the process root store and explicit verification", () => {
  const options = ssl(`${uri}?sslmode=verify-full`)!
  expect(options).toMatchObject({ rejectUnauthorized: true })
  expect(options.ca).toEqual(getCACertificates("default"))
  expect(options.servername).toBe("database.invalid")
})

test.each(["require", "verify-full"])("%s loads the pinned CA instead of public roots", (mode) => {
  const options = ssl(`${uri}?sslmode=${mode}&sslrootcert=${encodeURIComponent(pin)}`)!
  expect(options).toMatchObject({ rejectUnauthorized: true })
  expect(options.ca).toEqual([getCACertificates("default")[0]])
})

test.each([invalid, join(directory, "missing"), directory])("unusable pin %s refuses with host only", (file) => {
  expect(() => ssl(`${uri}?sslmode=require&sslrootcert=${encodeURIComponent(file)}`)).toThrow(/^DATABASE_URL for database.invalid has an unusable pinned CA$/)
})

test("Neon's API URL becomes verify-full without mutating unrelated connection settings", () => {
  const normalized = neonConnectionUri(`${uri}?sslmode=require&channel_binding=require&connect_timeout=3`)
  expect(Redacted.value(normalized)).toBe(`${uri}?sslmode=verify-full&connect_timeout=3`)
  expect(String(normalized)).not.toContain("private-pass")
  expect(sslFor(normalized)).toMatchObject({ rejectUnauthorized: true })
})

test.each(["require", "verify-full"])("empty pin preserves the %s policy", (mode) => {
  if (mode === "require") expect(() => ssl(`${uri}?sslmode=${mode}&sslrootcert=`)).toThrow("requires sslmode=verify-full")
  else expect(ssl(`${uri}?sslmode=${mode}&sslrootcert=`)?.ca).toEqual(getCACertificates("default"))
})

test("malformed certificate blocks are not usable CA pins", () => {
  const file = join(directory, "malformed.crt")
  writeFileSync(file, "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----")
  expect(() => ssl(`${uri}?sslmode=require&sslrootcert=${encodeURIComponent(file)}`)).toThrow(/^DATABASE_URL for database.invalid has an unusable pinned CA$/)
})

test("loopback also permits an empty CA setting, and verified IPv6 has no DNS servername", () => {
  expect(ssl("postgresql://u:p@localhost/local?sslmode=require&sslrootcert=")).toBeUndefined()
  expect(ssl("postgresql://u:p@[::1]/local?sslmode=verify-full")?.servername).toBeUndefined()
})


test.each(["service=private", "servicefile=private"])("rejects libpq endpoint indirection %s", (query) => {
  expect(() => ssl(`postgresql://u:p@localhost/db?${query}`)).toThrow("unsupported endpoint overrides")
})

test("libpq explicitly verifies hostnames, strips ambient PG overrides and retains no URL in argv", () => {
  const env = libpqEnvironment(`${uri}?sslmode=require&sslrootcert=${encodeURIComponent(pin)}`, {
    PATH: "path", PGHOSTADDR: "192.0.2.1", PGSERVICE: "private", PGSSLMODE: "disable", PGOPTIONS: "unsafe",
  })
  expect(env.PATH).toBe("path")
  expect(env.PGHOSTADDR).toBeUndefined()
  expect(env.PGSERVICE).toBeUndefined()
  expect(env.PGSSLMODE).toBe("verify-full")
  expect(env.PGOPTIONS).toBe("-c default_transaction_read_only=on")
  expect(env.PGHOST).toBe("database.invalid")
  expect(env.PGPORT).toBe("6543")
  expect(env.PGDATABASE).toBe("private-db")
  expect(env.PGUSER).toBe("private-user")
  expect(env.PGPASSWORD).toBe("private-pass")
  expect(env.PGSSLROOTCERT).toBe(pin)
  expect(env.PGGSSENCMODE).toBe("disable")
})

test("libpq uses system roots for verify-full and explicit plaintext only for loopback", () => {
  expect(libpqEnvironment(`${uri}?sslmode=verify-full`).PGSSLROOTCERT).toBe("system")
  const local = libpqEnvironment("postgresql://u:p@localhost/db?sslrootcert=")
  expect(local.PGSSLMODE).toBe("disable")
  expect(local.PGSSLROOTCERT).toBeUndefined()
})

test("database diagnostics never relay a driver message, even with unrelated nested credentials", () => {
  const error = new Error("postgresql://otheruser:otherpass@otherhost/otherdatabase")
  expect(diagnostic(error, Redacted.make(uri))).toBe("database operation failed for database.invalid")
  expect(diagnostic(error, Redacted.make("bad-private-url"))).toBe("DATABASE_URL is not a valid Postgres URL")
})


test("libpq preserves supported options and decodes credentials without exposing them as connection strings", () => {
  const env = libpqEnvironment("postgresql://private%40user:private%2Fpass@[::1]/private%20db?connect_timeout=2&application_name=ops")
  expect(env.PGHOST).toBe("::1")
  expect(env.PGPORT).toBe("5432")
  expect(env.PGUSER).toBe("private@user")
  expect(env.PGPASSWORD).toBe("private/pass")
  expect(env.PGDATABASE).toBe("private db")
  expect(env.PGCONNECT_TIMEOUT).toBe("2")
  expect(env.PGAPPNAME).toBe("ops")
  const anonymous = libpqEnvironment("postgresql://localhost/local")
  expect(anonymous.PGUSER).toBeUndefined()
  expect(anonymous.PGPASSWORD).toBeUndefined()
})

test.each(["requiressl=0", "gssencmode=prefer", "unknown=private", "connect_timeout=1&connect_timeout=2"])("libpq refuses unsupported or ambiguous options %s", query => {
  expect(() => libpqEnvironment(`postgresql://u:p@localhost/db?${query}`)).toThrow("DATABASE_URL for localhost has unsupported libpq parameters")
})
