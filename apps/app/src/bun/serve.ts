/*
 * The local server without a window: what the Playwright T1 tier boots
 * (`bun src/bun/serve.ts`). Reads SMITHERS_LOCAL_PORT (default 0 = random)
 * and SMITHERS_CHAT_STUB, serves apps/app/dist (or SMITHERS_DIST_DIR), and
 * prints SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:<port> when listening.
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
  chatStub: Bun.env.SMITHERS_CHAT_STUB === "1",
  cloudMode: Bun.env.SMITHERS_LOCAL_MODE === "hybrid" ? "hybrid" : "offline",
  // This process has no native picker. Manual path entry is an explicit
  // development/test capability, never the packaged app's default.
  allowManualRepositoryPaths: true
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
