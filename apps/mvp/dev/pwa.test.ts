import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer as httpServer } from "node:http"
import { join } from "node:path"
import { createServer } from "vite"
import { expect, test } from "vitest"

// Exercise the real app config and PWA generator after an earlier generator left a registration file behind.
// That file is not served in dev when main.tsx imports virtual:pwa-register. Precaching it fails installation.
test("dev worker installs from the served shell, excluding stale generator output", async () => {
  const root = join(import.meta.dirname, "..")
  const directory = join(root, "node_modules", ".vite-pwa-dev")
  await mkdir(directory, { recursive: true })
  const stale = join(directory, "registerSW.js")
  const previous = await readFile(stale).catch(() => undefined)
  await writeFile(stale, "// obsolete registration")
  let vite: Awaited<ReturnType<typeof createServer>> | undefined
  let server: ReturnType<typeof httpServer> | undefined
  try {
    vite = await createServer({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] } })
    server = httpServer(vite.middlewares)
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}`
    const worker = await fetch(`${origin}/dev-sw.js?dev-sw`)
    expect(worker.status).toBe(200)
    const source = await worker.text()
    expect(source).toContain('"url": "index.html"')
    expect(source).not.toContain('"url": "registerSW.js"')
    expect((await fetch(`${origin}/index.html`)).status).toBe(200)
    expect(source).toContain("self.skipWaiting()")
    expect(source).toContain("workbox.clientsClaim()")
  } finally {
    await vite?.close()
    if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (previous === undefined) await rm(stale)
    else await writeFile(stale, previous)
  }
}, 60_000)
