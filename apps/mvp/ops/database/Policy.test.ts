import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates } from "node:tls"
import { Redacted } from "effect"
import { afterAll, expect, test } from "vitest"
import { neonConnectionUri, sslFor } from "./Connection.ts"

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
  expect(options.rejectUnauthorized).toBe(true)
  expect(options.ca).toEqual(getCACertificates("default"))
  expect(options.servername).toBe("database.invalid")
})

test.each(["require", "verify-full"])("%s loads the pinned CA instead of public roots", (mode) => {
  const options = ssl(`${uri}?sslmode=${mode}&sslrootcert=${encodeURIComponent(pin)}`)!
  expect(options.rejectUnauthorized).toBe(true)
  expect(options.ca).toEqual([getCACertificates("default")[0]])
})

test.each([invalid, join(directory, "missing"), directory])("unusable pin %s refuses with host only", (file) => {
  expect(() => ssl(`${uri}?sslmode=require&sslrootcert=${encodeURIComponent(file)}`)).toThrow(/^DATABASE_URL for database.invalid has an unusable pinned CA$/)
})

test("Neon's API URL becomes verify-full without mutating unrelated connection settings", () => {
  const normalized = neonConnectionUri(`${uri}?sslmode=require&channel_binding=require&connect_timeout=3`)
  expect(Redacted.value(normalized)).toBe(`${uri}?sslmode=verify-full&connect_timeout=3`)
  expect(String(normalized)).not.toContain("private-pass")
  expect(sslFor(normalized)?.rejectUnauthorized).toBe(true)
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
