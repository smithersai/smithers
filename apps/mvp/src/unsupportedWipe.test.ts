import { expect, test } from "vitest"
import { pageWipe, type WipeHost } from "./wipe"

test("startup without Web Locks returns a supported failure before reading or opening device stores", async () => {
  let touched = 0
  const channel = new BroadcastChannel(`unsupported-${crypto.randomUUID()}`)
  const unavailable = () => { touched++; throw new Error("Device stores must stay closed") }
  const page = pageWipe({
    locks: undefined,
    marks: { getItem: unavailable, setItem: unavailable, removeItem: unavailable },
    directory: unavailable,
    indexedDB: { deleteDatabase: unavailable },
    channel: () => channel,
    reload: unavailable,
  } as unknown as WipeHost, { engine: "unopened", outbox: "unopened" })
  try {
    expect(await page.open()).toBe("unsupported")
    expect(touched).toBe(0)
    expect(await page.reopen("identity_reopen")).toBe(false)
    await expect(page.signOut(async () => new Response())).rejects.toThrow("Web Locks unavailable")
    expect(touched).toBe(0)
  } finally { page.close() }
})
