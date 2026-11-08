import { expect, it } from "vitest"

it("supports Web Locks callback-only requests, metadata, and their result", async () => {
  const name = `callback-only-${crypto.randomUUID()}`
  expect(
    await navigator.locks.request(name, (lock) => {
      expect(lock).toMatchObject({ name, mode: "exclusive" })
      return 42
    })
  ).toBe(42)
})

it("forwards shared mode and callback rejection", async () => {
  const name = `shared-${crypto.randomUUID()}`
  await expect(navigator.locks.request(name, { mode: "shared" }, (lock) => {
    expect(lock).toMatchObject({ name, mode: "shared" })
    throw new Error("callback failed")
  })).rejects.toThrow("callback failed")
})
