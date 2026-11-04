import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { distinctPerson, personSettings, personState } from "./people"
import type { Cookie, SessionAnswer } from "./deployment/session"

const directory = mkdtempSync(join(tmpdir(), "sharing-people-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const origin = "https://app.example.com"
const owner: SessionAnswer = { signedIn: true, login: "owner-test", personId: "owner", role: "member" }
const other: SessionAnswer = { signedIn: true, login: "other-test", personId: "other", role: "member" }
const cookie: Cookie = { name: "__Host-smithers_session", domain: "app.example.com", path: "/", value: "test-only",
  expires: Date.now() / 1000 + 3600, secure: true, httpOnly: true, sameSite: "Lax" }
const write = (value: unknown) => {
  const path = join(directory, "session.json")
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

describe("separate real sharing identities", () => {
  it("requires an explicit expected login and absolute session path for each role", () => {
    for (const person of ["teammate", "guest"] as const) {
      const prefix = person === "teammate" ? "E2E_TEAMMATE" : "E2E_GUEST"
      const env = { [`${prefix}_LOGIN`]: "other-test", [`${prefix}_SESSION`]: "/private/session.json" }
      expect(personSettings(person, env)).toEqual({ login: "other-test", session: "/private/session.json" })
      for (const login of [undefined, "", "../owner", "bad login"]) {
        expect(personSettings(person, { ...env, [`${prefix}_LOGIN`]: login })).toBeUndefined()
      }
      for (const session of [undefined, "", "session.json"]) {
        expect(personSettings(person, { ...env, [`${prefix}_SESSION`]: session })).toBeUndefined()
      }
    }
  })

  it("uses live signed-in identities and rejects two devices of the same person", () => {
    expect(distinctPerson(owner, other, "other-test")).toMatchObject({ login: "other-test", personId: "other" })
    expect(() => distinctPerson(owner, { ...other, personId: "owner" }, "other-test")).toThrow("Two devices")
    expect(() => distinctPerson(owner, { ...other, login: "OWNER-TEST" }, "OWNER-TEST")).toThrow("Two devices")
    expect(() => distinctPerson(owner, other, "unrelated-test")).toThrow("Second test identity refused")
    for (const invalid of [{ signedIn: false }, { signedIn: true }, { ...other, role: "unknown" }]) {
      expect(() => distinctPerson(owner, invalid, "other-test")).toThrow("refused")
    }
    for (const invalid of [{ signedIn: false }, { signedIn: true }, { ...owner, personId: undefined }]) {
      expect(() => distinctPerson(invalid, other, "other-test")).toThrow("verified live session")
    }
  })

  it("keeps only the app cookie, never a GitHub cookie or local storage", () => {
    const path = write({ cookies: [cookie, { ...cookie, domain: "github.com", name: "user_session" }],
      origins: [{ origin, localStorage: [{ name: "sensitive", value: "test-only" }] }] })
    expect(personState(path, origin)).toEqual({ cookies: [cookie], origins: [] })
  })

  it("refuses expired, wrong-origin, publicly readable and malformed session files without echoing their content", () => {
    for (const cookies of [[], [{ ...cookie, expires: 1 }], [{ ...cookie, domain: "other.example.com" }]]) {
      expect(() => personState(write({ cookies, origins: [] }), origin)).toThrow("absent or expired")
    }
    const path = write({ cookies: [cookie] })
    chmodSync(path, 0o644)
    expect(() => personState(path, origin)).toThrow("private")
    chmodSync(path, 0o600)
    writeFileSync(path, '{"cookie":"test-only-should-not-be-printed')
    expect(() => personState(path, origin)).toThrow("unreadable or invalid")
    expect(() => personState(write({ cookies: null }), origin)).toThrow("unreadable or invalid")
  })
})
