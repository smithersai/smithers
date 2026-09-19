/*
 * The local server without a window. Reads SMITHERS_LOCAL_PORT (default
 * 0 = random), serves apps/app/dist (or SMITHERS_DIST_DIR), and prints
 * SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:<port> when listening. It is the
 * real host: the browser tiers boot their own (scripts/browser-test-host.ts)
 * so they can inject a stubbed agent, and this one never stubs anything.
 */
import { defaultDistDir, startLocalServer } from "./server"
import { join, resolve } from "node:path"
import { nativeStateDirectory } from "./NativeState"

const port = Number(Bun.env.SMITHERS_LOCAL_PORT ?? "0")
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`SMITHERS_LOCAL_PORT must be a port number, got ${JSON.stringify(Bun.env.SMITHERS_LOCAL_PORT)}`)
  process.exit(2)
}

const server = await startLocalServer({
  port,
  distDir: defaultDistDir(import.meta.dir),
  // Dev/headless state has its own directory, separate from the native app.
  stateDir: Bun.env.SMITHERS_LOCAL_STATE_DIR?.trim()
    ? resolve(Bun.env.SMITHERS_LOCAL_STATE_DIR)
    : join(nativeStateDirectory(), "headless"),
  cloudMode: Bun.env.SMITHERS_LOCAL_MODE === "hybrid" ? "hybrid" : "offline"
})

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  await server.stop()
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
