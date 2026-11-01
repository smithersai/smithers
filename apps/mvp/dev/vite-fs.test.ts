import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type UserConfig } from "vite"
import { expect, it } from "vitest"
import configOf from "../vite.config.ts"

it("refuses files outside the workspace while serving workspace files", async () => {
  const outside = mkdtempSync(join(tmpdir(), "mvp-vite-fs-"))
  const file = join(outside, "outside.txt")
  writeFileSync(file, "outside workspace")
  const config: UserConfig = typeof configOf === "function"
    ? await configOf({ command: "serve", mode: "development" })
    : await configOf
  const server = await createServer({
    ...config,
    configFile: false,
    // Exercise Vite's real file middleware with the app's server settings; no build or HTTPS plugins needed.
    plugins: [],
    server: { ...config.server, port: 0, strictPort: false, host: "127.0.0.1" },
  })
  try {
    await server.listen()
    const address = server.httpServer!.address()
    if (!address || typeof address === "string") throw new Error("Missing Vite TCP address")
    const origin = `http://127.0.0.1:${address.port}`
    expect((await fetch(`${origin}/@fs/${file}`)).status).toBe(403)
    expect((await fetch(`${origin}/@fs/${join(import.meta.dirname, "../package.json")}`)).status).toBe(200)
  } finally {
    await server.close()
    rmSync(outside, { recursive: true, force: true })
  }
})
