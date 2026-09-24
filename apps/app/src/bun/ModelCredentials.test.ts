import { expect, test } from "bun:test"
import { Redacted } from "effect"
import type { CloudKeychain } from "./CloudAuth"
import { createModelCredentials } from "./ModelCredentials"

const vault = (entries: ReadonlyArray<{ name: string; origin: string; value: string | null }>): CloudKeychain => {
  let value: string | null = JSON.stringify({ version: 1, entries, receipts: [] })
  return { read: async () => value, write: async (_s, _a, next) => { value = next }, remove: async () => { value = null } }
}

test("a stored vault entry is listed without its value and read by name", async () => {
  const store = await createModelCredentials({ scope: "/scope", env: {}, keychain: vault([{ name: "LOOPBACK", origin: "http://127.0.0.1:12345", value: "stored-fixture-never-log" }]) })
  expect(store.list().find(row => row.name === "LOOPBACK")).toEqual({ name: "LOOPBACK", origins: ["http://127.0.0.1:12345"], present: true, managed: true })
  expect(JSON.stringify(store.list())).not.toContain("stored-fixture-never-log")
  expect(Redacted.value(store.read("LOOPBACK")!)).toBe("stored-fixture-never-log")
})

test("an operator env key wins over a vault entry of the same name", async () => {
  const store = await createModelCredentials({ scope: "/scope", env: { OPENAI_API_KEY: "operator-owned" },
    keychain: vault([{ name: "OPENAI_API_KEY", origin: "https://api.openai.com", value: "vault-value" }]) })
  expect(Redacted.value(store.read("OPENAI_API_KEY")!)).toBe("operator-owned")
})

test("an unreadable vault lists and reads nothing from it", async () => {
  const store = await createModelCredentials({ scope: "/scope", env: {}, keychain: { read: async () => "not json", write: async () => {}, remove: async () => {} } })
  expect(store.read("LOOPBACK")).toBeUndefined()
  expect(store.list().some(row => row.name === "LOOPBACK")).toBe(false)
})
