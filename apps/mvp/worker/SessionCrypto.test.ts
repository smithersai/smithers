import { Effect } from "effect"
import { expect, test } from "vitest"
import { cleanupId, digestEffect, digestSessionValue } from "./SessionCrypto.vibe"

test("session digests agree with the SHA-256 test vector", async () => {
  const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  expect(digestSessionValue("abc")).toBe(digest)
  expect(await Effect.runPromise(digestEffect("abc"))).toBe(digest)
})

test("each cleanup creates a distinct version 4 UUID", async () => {
  const first = await Effect.runPromise(cleanupId)
  const second = await Effect.runPromise(cleanupId)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  expect(first).toMatch(uuid)
  expect(second).toMatch(uuid)
  expect(second).not.toBe(first)
})
