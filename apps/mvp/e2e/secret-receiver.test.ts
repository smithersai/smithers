import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { digest, receiver, registeredReceiver } from "./secret-receiver"

describe("owned secret receiver, real HTTP", () => {
  it("selects only the registered tunnel, ignoring the greeting's admin URL", () => {
    expect(registeredReceiver("Manage domains at https://admin.localhost.run/")).toBeUndefined()
    expect(registeredReceiver(JSON.stringify({ type: "other", data: "https://admin.localhost.run/" }))).toBeUndefined()
    expect(registeredReceiver(JSON.stringify({ type: "v1.tcpip_forward.register.accepted", data: null }))).toBeUndefined()
    expect(registeredReceiver(JSON.stringify({ type: "v1.tcpip_forward.register.accepted", data: "https://attacker.test/" }))).toBeUndefined()
    expect(registeredReceiver(JSON.stringify({ type: "v1.tcpip_forward.register.accepted",
      data: "abc123.lhr.life tunneled with tls termination, https://abc123.lhr.life\r\n" }))).toBe("https://abc123.lhr.life")
  })
  it("requires the exact token, proves both versions, and never echoes rejected or accepted input", async () => {
    const app = await receiver()
    const first = randomBytes(32).toString("hex")
    const second = randomBytes(32).toString("hex")
    const base = `http://127.0.0.1:${app.port}`
    const get = (token: string, path = app.path, method = "GET") => fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${token}` }, redirect: "error",
    })
    try {
      expect((await get(first)).status).toBe(401)
      expect((await get(first, "/elsewhere")).status).toBe(404)
      app.expect(first)
      expect((await get("smthrs-secret-placeholder")).status).toBe(401)
      const initial = await get(first)
      expect(initial.status).toBe(200)
      expect(await initial.json()).toEqual({ version: 1, digest: digest(first) })
      app.expect(second)
      const stale = await get(first)
      expect(stale.status).toBe(401)
      expect(await stale.text()).toBe("refused")
      const rotated = await get(second)
      expect(rotated.status).toBe(200)
      expect(await rotated.json()).toEqual({ version: 2, digest: digest(second) })
      expect((await get(second, app.path, "POST")).status).toBe(404)
      expect(app.receipts.map(({ version }) => version)).toEqual([1, 2])
      expect(app.refused).toBe(3)
      const recorded = JSON.stringify(app.receipts)
      expect([first, second].some((value) => recorded.includes(value)), "receiver receipts contain no token").toBe(false)
    } finally { await app.close() }
  })
})
