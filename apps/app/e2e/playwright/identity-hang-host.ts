/*
 * The boot-blocking fixture (boot-identity.spec.ts): the real local origin in
 * hybrid mode — identity capability ON — with the identity upstream behind a
 * socket that accepts and never answers, so `/api/auth/session` pends for as
 * long as the server runs. The spec proves first paint never waits on it.
 * Prints SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:<port> when listening.
 */
import { fileURLToPath } from "node:url"
import { startLocalServer } from "../../src/bun/server"

const hanging = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // 255s is Bun's ceiling: the answer outlives every test budget, so the spec
  // can only pass with first paint that never waited on the identity seam.
  idleTimeout: 255,
  fetch: () => new Promise<Response>(() => {})
})

const server = await startLocalServer({
  port: 0,
  distDir: fileURLToPath(new URL("../../dist/", import.meta.url)),
  // chatStub would null the identity upstream (server.ts); the stub is off so
  // the hybrid seam proxies to the hanging socket above. No chat turn is ever
  // started, so the real agent construction never touches the network.
  chatStub: false,
  cloudMode: "hybrid",
  identityUpstream: `http://127.0.0.1:${hanging.port}`,
  cloudApi: null
})

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  hanging.stop(true)
  await server.stop()
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
