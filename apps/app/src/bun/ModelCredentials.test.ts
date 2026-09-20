import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redacted } from "effect"
import type { CloudKeychain } from "./CloudAuth"
import { createModelCredentials } from "./ModelCredentials"

const keychain = () => {
  let value: string | null = null
  const io: CloudKeychain = { read: async () => value, write: async (_s, _a, next) => { value = next }, remove: async () => { value = null } }
  return io
}
const enroll = { action: "enroll", requestId: "first-request", name: "LOOPBACK", origin: "http://127.0.0.1:12345", value: "fixture-credential-never-log" } as const
const directories: string[] = []
const scope = async () => { const path = await mkdtemp(join(tmpdir(), "model-credentials-")); directories.push(path); return path }
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })

test("enrollment survives restart, never repins, rotates and removes while retaining the pin", async () => {
  const io = keychain()
  const options = { keychain: io, scope: await scope(), env: {} }
  const first = await createModelCredentials(options)
  expect(await first.mutate(enroll)).toMatchObject({ ok: true, credential: { name: "LOOPBACK", present: true, origins: [enroll.origin], managed: true } })
  const restarted = await createModelCredentials(options)
  expect(JSON.stringify(restarted.list())).not.toContain(enroll.value)
  expect(Redacted.value(restarted.read("LOOPBACK")!)).toBe(enroll.value)
  expect(await restarted.mutate({ ...enroll, requestId: "second-request", origin: "https://attacker.example" })).toMatchObject({ ok: false, failure: { code: "exists" } })
  expect(await restarted.mutate({ action: "rotate", requestId: "rotate-request", name: "LOOPBACK", value: "rotated-fixture-value" })).toMatchObject({ ok: true })
  expect(Redacted.value(restarted.read("LOOPBACK")!)).toBe("rotated-fixture-value")
  expect(await restarted.mutate({ action: "remove", requestId: "remove-request", name: "LOOPBACK" })).toMatchObject({ ok: true, credential: { present: false } })
  expect(restarted.read("LOOPBACK")).toBeUndefined()
  expect(await restarted.mutate({ ...enroll, requestId: "third-request", origin: "https://attacker.example" })).toMatchObject({ ok: false, failure: { code: "exists" } })
  expect(JSON.stringify(await restarted.receipt(enroll.requestId))).not.toContain(enroll.value)
})

test("concurrent enrollment is serialized and a replay cannot change a credential", async () => {
  const store = await createModelCredentials({ keychain: keychain(), scope: await scope(), env: {} })
  const results = await Promise.all([store.mutate(enroll), store.mutate({ ...enroll, requestId: "racing-request", origin: "https://attacker.example" })])
  expect(results.map(row => row.ok)).toEqual([true, false])
  expect(await store.mutate({ ...enroll, value: "replay-cannot-rotate" })).toEqual(results[0]!)
  expect(Redacted.value(store.read("LOOPBACK")!)).toBe(enroll.value)
})

test("storage refusal never publishes a value or reports success, and env keys stay read only", async () => {
  const store = await createModelCredentials({ scope: await scope(), env: { OPENAI_API_KEY: "operator-owned" }, keychain: {
    read: async () => null, remove: async () => {}, write: async () => { throw new Error(enroll.value) }
  } })
  expect(await store.mutate(enroll)).toEqual({ ok: false, failure: { code: "storage_unavailable" }, fault: "infra" })
  expect(store.read("LOOPBACK")).toBeUndefined()
  expect(await store.mutate({ action: "rotate", requestId: "env-rotation", name: "OPENAI_API_KEY", value: "replacement" })).toMatchObject({ ok: false, failure: { code: "read_only" } })
})

test("two live hosts cannot replace an existing pin from a stale vault snapshot", async () => {
  const options = { keychain: keychain(), scope: await scope(), env: {} }
  const first = await createModelCredentials(options)
  const second = await createModelCredentials(options)
  expect((await first.mutate(enroll)).ok).toBe(true)
  expect(await second.mutate({ ...enroll, requestId: "second-host-request", origin: "https://attacker.example" })).toMatchObject({ ok: false, failure: { code: "exists" } })
  expect((await createModelCredentials(options)).list().find(row => row.name === enroll.name)?.origins).toEqual([enroll.origin])
  await first.mutate({ action: "remove", requestId: "remove-first-host", name: enroll.name })
  await second.refresh()
  expect(second.read(enroll.name)).toBeUndefined()
  await first.mutate({ action: "rotate", requestId: "restore-first-host", name: enroll.name, value: "restored-key" })
  await second.refresh()
  expect(Redacted.value(second.read(enroll.name)!)).toBe("restored-key")
})
