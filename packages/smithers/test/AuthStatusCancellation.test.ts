/** A cancelled auth-status read cancels its initial credential lookup, not only HTTP. */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { auth } from "../src/internal/backend/Auth.ts"
import { Client } from "../src/internal/backend/Client.ts"

it("passes cancellation into the real session while its native credential lookup is pending", async () => {
  const home = await mkdtemp(join(tmpdir(), "auth-status-cancel-"))
  const controller = new AbortController()
  try {
    const client = new Client({
      environment: { HOME: home, XDG_CONFIG_HOME: home, PATH: process.env.PATH },
      signal: controller.signal
    })
    // Bind the origin so Session.resolve enters its native credential lookup.
    // This reserved hostname has no credential and no network request is needed.
    client.session.saveConfig({ api_origin: "https://auth-cancel.example.test" })
    const result = auth["auth status"]!(client, {}, { context: true })
    controller.abort()
    await expect(result).rejects.toMatchObject({ _tag: "/cli/Refused", code: "cancelled" })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
