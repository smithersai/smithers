import { randomBytes, timingSafeEqual } from "node:crypto"
import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from "node:fs"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { startWithPersistentOrigin } from "./NativeOrigin"
import { startLocalServer } from "./server"
import {
  DAEMON_PROTOCOL, DaemonConfigurationSchema, descriptorPath, prepareDaemonDirectory,
  type DaemonConfiguration, type DaemonDescriptor
} from "./LocalDaemonProtocol"

/** Bounded diagnostics contain lifecycle facts, never control secrets or terminal output. */
const daemonLogger = (directory: string) => (line: string): void => {
  try {
    const path = join(directory, "daemon.log")
    if (existsSync(path) && statSync(path).size > 2 * 1024 * 1024) renameSync(path, `${path}.previous`)
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  } catch { /* Diagnostics do not own a process. */ }
}

export const startLocalDaemon = async (configuration: DaemonConfiguration) => {
  const directory = await prepareDaemonDirectory(configuration.stateDir)
  const log = daemonLogger(directory)
  const instance = crypto.randomUUID()
  const token = randomBytes(32).toString("base64url")
  // A private address per generation avoids PID locks and stale-socket reclamation.
  const socketDirectory = await mkdtemp(join(tmpdir(), "smthrs-"))
  chmodSync(socketDirectory, 0o700)
  const socket = join(socketDirectory, "owner.sock")
  let host: Awaited<ReturnType<typeof startLocalServer>> | undefined
  let control: ReturnType<typeof Bun.serve> | undefined
  const finished = Promise.withResolvers<void>()
  void finished.promise.catch(() => {})
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    log(`daemon ${instance}: explicit shutdown requested`)
    await host?.stop()
    // Retire only this descriptor. Another generation is never a cleanup target.
    const path = descriptorPath(configuration.stateDir)
    try {
      const current = JSON.parse(await readFile(path, "utf8")) as { instance?: unknown }
      if (current.instance === instance) await rm(path)
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error
    }
    log(`daemon ${instance}: all owned processes stopped`)
  })()
  const retire = async (): Promise<void> => {
    await control?.stop(false)
    await rm(socketDirectory, { recursive: true, force: true })
    finished.resolve()
  }
  try {
    host = await startWithPersistentOrigin(configuration.stateDir, (port) => startLocalServer({
      ...configuration, port, log
    }), configuration.port)
    control = Bun.serve({
      unix: socket,
      maxRequestBodySize: 16 * 1024,
      fetch: async (request) => {
        const auth = request.headers.get("authorization") ?? ""
        const expected = `Bearer ${token}`
        if (request.headers.has("origin") || Buffer.byteLength(auth) !== Buffer.byteLength(expected) ||
          !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return new Response(null, { status: 403 })
        const path = new URL(request.url).pathname
        if (path === "/health" && request.method === "GET") {
          return Response.json({ instance, protocol: DAEMON_PROTOCOL, origin: host!.origin })
        }
        if (request.method !== "POST" || request.headers.get("content-type") !== "application/json") {
          return new Response(null, { status: 400 })
        }
        if (path === "/authorize-repository") {
          if (stopping !== undefined) return new Response(null, { status: 503 })
          const body = z.object({ path: z.string().min(1).max(4096), access: z.enum(["read", "read-write"]) }).strict()
            .safeParse(await request.json().catch(() => undefined))
          if (!body.success) return new Response(null, { status: 400 })
          return Response.json(await host!.authorizeRepository(body.data.path, body.data.access))
        }
        if (path === "/shutdown") {
          try { await stop() } catch (error) {
            log(`daemon ${instance}: shutdown failed: ${String(error)}`)
            return new Response(null, { status: 500 })
          }
          // Drain the successful reply before closing the private listener.
          setTimeout(() => void retire().catch(finished.reject), 10)
          return Response.json({ ok: true })
        }
        return new Response(null, { status: 404 })
      }
    })
    chmodSync(socket, 0o600)
    const descriptor: DaemonDescriptor = { protocol: DAEMON_PROTOCOL, instance, configuration, origin: host.origin, socket, token }
    const staged = join(directory, `${instance}.json`)
    await writeFile(staged, JSON.stringify(descriptor), { flag: "wx", mode: 0o600 })
    await rename(staged, descriptorPath(configuration.stateDir))
    log(`daemon ${instance}: ready at ${host.origin}`)
    return {
      descriptor,
      finished: finished.promise,
      stop: async () => { await stop(); await retire() }
    }
  } catch (error) {
    log(`daemon ${instance}: startup failed: ${String(error)}`)
    await host?.stop()
    await control?.stop(true)
    await rm(socketDirectory, { recursive: true, force: true })
    throw error
  }
}

export const runLocalDaemon = async (): Promise<void> => {
  const configuration = DaemonConfigurationSchema.parse(JSON.parse(Bun.env.SMITHERS_DAEMON_CONFIGURATION ?? "null"))
  const owner = await startLocalDaemon(configuration)
  const shutdown = () => void owner.stop().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
  await owner.finished
  process.off("SIGTERM", shutdown)
  process.off("SIGINT", shutdown)
}
