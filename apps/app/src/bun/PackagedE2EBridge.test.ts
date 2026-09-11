import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { encodeRgbaPng, startPackagedE2EBridge } from "./PackagedE2EBridge"
import type { PackagedE2EBridge, PackagedE2EBridgeOptions } from "./PackagedE2EBridge"

const token = "packaged-e2e-test-token-that-is-long-enough"
const bridges: Array<PackagedE2EBridge> = []

const availablePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) {
        server.close()
        reject(new Error("no port"))
        return
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error))
    })
  })

const callbacks = (overrides: Partial<PackagedE2EBridgeOptions> = {}): PackagedE2EBridgeOptions => ({
  state: () => ({ window: "real" }),
  evaluate: (script) => ({ script }),
  queueRepositorySelection: () => undefined,
  screenshot: () => new Uint8Array([137, 80, 78, 71]),
  quit: () => undefined,
  ...overrides
})

const start = async (options: Partial<PackagedE2EBridgeOptions> = {}): Promise<PackagedE2EBridge> => {
  const bridge = startPackagedE2EBridge(callbacks({
    env: {
      SMITHERS_E2E_BRIDGE: "1",
      SMITHERS_E2E_BRIDGE_PORT: String(await availablePort()),
      SMITHERS_E2E_BRIDGE_TOKEN: token
    },
    ...options
  }))
  if (bridge === null) throw new Error("test bridge did not start")
  bridges.push(bridge)
  return bridge
}

const request = (bridge: PackagedE2EBridge, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers }
  })

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop()
})

describe("the packaged E2E bridge", () => {
  test("does not open a socket without the exact opt-in and validates its secrets", async () => {
    expect(startPackagedE2EBridge(callbacks({ env: {} }))).toBeNull()
    expect(() => startPackagedE2EBridge(callbacks({
      env: { SMITHERS_E2E_BRIDGE: "1", SMITHERS_E2E_BRIDGE_PORT: "0", SMITHERS_E2E_BRIDGE_TOKEN: token }
    }))).toThrow("must be an integer")
    expect(() => startPackagedE2EBridge(callbacks({
      env: { SMITHERS_E2E_BRIDGE: "1", SMITHERS_E2E_BRIDGE_PORT: "12345", SMITHERS_E2E_BRIDGE_TOKEN: "short" }
    }))).toThrow("at least 32 characters")
  })

  test("authenticates every route and enforces route methods", async () => {
    const bridge = await start()
    expect((await fetch(`http://127.0.0.1:${bridge.port}/health`)).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${bridge.port}/health`, {
      headers: { authorization: "Bearer wrong" }
    })).status).toBe(401)

    const health = await request(bridge, "/health")
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, pid: process.pid })
    const wrongMethod = await request(bridge, "/health", { method: "POST" })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("GET")
    expect((await request(bridge, "/absent")).status).toBe(404)
  })

  test("returns state and serialized renderer evaluation results and errors", async () => {
    const scripts: Array<string> = []
    const bridge = await start({
      state: () => ({ app: { packaged: true }, window: { renderer: "native" } }),
      evaluate: (script) => {
        scripts.push(script)
        if (script === "undefined") return undefined
        if (script === "boom") throw new Error("renderer exploded")
        return { answer: 42 }
      }
    })
    expect(await (await request(bridge, "/state")).json()).toEqual({
      app: { packaged: true },
      window: { renderer: "native" }
    })
    const evaluated = await request(bridge, "/window/eval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "6 * 7" })
    })
    expect(await evaluated.json()).toEqual({ result: { answer: 42 } })
    expect(scripts).toEqual(["6 * 7"])

    const valueUndefined = await request(bridge, "/window/eval", {
      method: "POST",
      body: JSON.stringify({ script: "undefined" })
    })
    expect(await valueUndefined.json()).toEqual({ result: null, valueUndefined: true })
    const failed = await request(bridge, "/window/eval", {
      method: "POST",
      body: JSON.stringify({ script: "boom" })
    })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: "bridge_error", message: "renderer exploded" })
  })

  test("strictly validates and queues one native repository-picker answer", async () => {
    const selections: Array<string | null> = []
    const bridge = await start({
      queueRepositorySelection: (path) => {
        selections.push(path)
      }
    })
    const post = (body: unknown): Promise<Response> => request(bridge, "/window/repository-picker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })

    expect((await post({ path: "relative" })).status).toBe(400)
    expect((await post({ path: "/tmp/repo", extra: true })).status).toBe(400)
    expect((await post({ nope: "/tmp/repo" })).status).toBe(400)
    expect((await post({ path: null })).status).toBe(202)
    expect((await post({ path: "/tmp/repo with spaces" })).status).toBe(202)
    expect(selections).toEqual([null, "/tmp/repo with spaces"])
  })

  test("bounds request bodies, serves PNG bytes, and schedules quit", async () => {
    let quit = 0
    const bridge = await start({ quit: () => { quit += 1 } })
    const malformed = await request(bridge, "/window/eval", { method: "POST", body: "{" })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: "invalid_json" })
    const missing = await request(bridge, "/window/eval", { method: "POST", body: "{}" })
    expect(missing.status).toBe(400)
    const oversized = await request(bridge, "/window/eval", {
      method: "POST",
      body: JSON.stringify({ script: "x".repeat(1024 * 1024) })
    })
    expect(oversized.status).toBe(413)

    const screenshot = await request(bridge, "/window/screenshot")
    expect(screenshot.status).toBe(200)
    expect(screenshot.headers.get("content-type")).toBe("image/png")
    expect([...new Uint8Array(await screenshot.arrayBuffer())]).toEqual([137, 80, 78, 71])
    expect((await request(bridge, "/app/quit", { method: "POST" })).status).toBe(202)
    await Bun.sleep(50)
    expect(quit).toBe(1)
  })

  test("reports unavailable screen capture without failing other routes", async () => {
    const bridge = await start({ screenshot: () => null })
    const screenshot = await request(bridge, "/window/screenshot")
    expect(screenshot.status).toBe(503)
    expect(await screenshot.json()).toMatchObject({ error: "screenshot_unavailable" })
    expect((await request(bridge, "/health")).status).toBe(200)
  })
})

describe("the dependency-free screenshot encoder", () => {
  test("writes a valid RGBA PNG envelope and rejects impossible buffers", () => {
    const png = encodeRgbaPng(1, 1, new Uint8Array([255, 0, 127, 255]))
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR")
    expect(new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(16)).toBe(1)
    expect(new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(20)).toBe(1)
    expect(new TextDecoder().decode(png.subarray(-8, -4))).toBe("IEND")
    expect(() => encodeRgbaPng(0, 1, new Uint8Array())).toThrow("positive integers")
    expect(() => encodeRgbaPng(2, 2, new Uint8Array(4))).toThrow("does not match")
  })
})
