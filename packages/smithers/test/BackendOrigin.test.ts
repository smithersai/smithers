import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const client = async (origin: string, environment: Record<string, string> = {}) => {
  const home = await mkdtemp(join(tmpdir(), "cli-origin-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const c = new Client({
    environment: { HOME: home, XDG_CONFIG_HOME: home, SMITHERS_DISABLE_SYSTEM_KEYRING: "1", ...environment }
  })
  c.session.saveConfig({ api_origin: origin })
  return c
}
it.each([502, 503])("names the saved origin and config repair after HTTP %s", async (status) => {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(status === 503 ? { message: "service temporarily unavailable" } : {}))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing address")
  const origin = `http://127.0.0.1:${address.port}`
  const c = await client(origin)
  const failure = await c.request("GET", "/api/user", undefined, { anonymous: true }).catch((error) => c.failure(error))
  expect(failure).toMatchObject({ code: "backend_unavailable", httpStatus: status })
  const message = (failure as Error).message
  expect(message).toContain(c.session.configPath)
  expect(message).toContain(c.session.authPath)
  expect(message).toContain("smthrs config set api_origin <origin>")
  expect(message).toContain(origin)
  if (status === 503) expect(message).toContain("service temporarily unavailable")
  else expect(message).toContain(origin)
})
it("names a saved unresolvable origin and its config without dumping the transport error", async () => {
  const c = await client("https://smithers-cli-origin.invalid")
  const failure = await c.request("GET", "/api/user", undefined, { anonymous: true }).catch((error) => c.failure(error))
  expect(failure).toMatchObject({ code: "backend_unavailable" })
  const message = (failure as Error).message
  expect(message).toContain("https://smithers-cli-origin.invalid")
  expect(message).toContain(c.session.configPath)
  expect(message).toContain("smthrs config set api_origin <origin>")
  expect(message).not.toMatch(/fetch failed|ENOTFOUND|EAI_AGAIN/)
})

for (const override of [false, true]) {
  it.each(["http", "dns"])(
    `keeps an explicit %s destination separate from config (environment override: ${override})`,
    async (kind) => {
      const server = createServer((_req, res) => {
        res.writeHead(503, { "content-type": "application/json" })
        res.end(JSON.stringify({ message: "explicit service unavailable" }))
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      cleanup.push(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing address")
      const origin = kind === "dns" ? "https://smithers-explicit-origin.invalid" : `http://127.0.0.1:${address.port}`
      const c = await client(
        "https://saved-origin.invalid",
        override ? { SMITHERS_API_ORIGIN: "https://environment-origin.invalid" } : {}
      )
      const failure = await c.request("GET", "/api/user", undefined, { anonymous: true, origin }).catch((error) =>
        c.failure(error)
      )
      expect(failure).toMatchObject({ code: "backend_unavailable" })
      const message = (failure as Error).message
      expect(message).toContain(origin)
      expect(message).toContain("Check the explicit request origin")
      expect(message).not.toContain("api_origin")
      expect(message).not.toContain(c.session.configPath)
      expect(message).not.toContain("SMITHERS_API_ORIGIN")
      if (kind === "http") expect(message).toContain("explicit service unavailable")
    }
  )
}

for (const override of [false, true]) {
  it.each(["http", "dns"])(
    `retains configured %s provenance in pagination (environment override: ${override})`,
    async (kind) => {
      const server = createServer((_req, res) => {
        res.writeHead(503, { "content-type": "application/json" })
        res.end(JSON.stringify({ message: "configured service unavailable" }))
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      cleanup.push(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing address")
      const origin = kind === "dns" ? "https://smithers-configured-origin.invalid" : `http://127.0.0.1:${address.port}`
      const c = await client(origin, {
        SMITHERS_TOKEN: "synthetic-test-credential",
        ...(override ? { SMITHERS_API_ORIGIN: origin } : {})
      })
      const failure = await c.pages(() => "/api/user").catch((error) => c.failure(error))
      expect(failure).toMatchObject({ code: "backend_unavailable" })
      const message = (failure as Error).message
      expect(message).toContain(origin)
      expect(message).toContain(override ? "SMITHERS_API_ORIGIN" : c.session.configPath)
      expect(message).toContain("smthrs config set api_origin <origin>")
      expect(message).not.toContain("explicit request origin")
      expect(message).not.toContain("synthetic-test-credential")
    }
  )
}
