import { createHash } from "node:crypto"
import { lstat, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createConnection } from "node:net"
import { z } from "zod"

export const DAEMON_PROTOCOL = 1
export const DaemonConfigurationSchema = z.object({
  stateDir: z.string(),
  distDir: z.string(),
  port: z.number().int().min(0).max(65535).optional(),
  chatStub: z.boolean(),
  cloudMode: z.enum(["offline", "hybrid"]),
  allowManualRepositoryPaths: z.boolean(),
  build: z.string()
}).strict()
export type DaemonConfiguration = z.infer<typeof DaemonConfigurationSchema>
export const DaemonDescriptorSchema = z.object({
  protocol: z.number().int(),
  instance: z.string().uuid(),
  configuration: DaemonConfigurationSchema,
  origin: z.string().url().refine((value) => /^http:\/\/127\.0\.0\.1:\d+$/.test(value)),
  socket: z.string(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict()
export type DaemonDescriptor = z.infer<typeof DaemonDescriptorSchema>
export const daemonDirectory = (stateDir: string): string => join(stateDir, "local-daemon")
export const descriptorPath = (stateDir: string): string => join(daemonDirectory(stateDir), "owner.json")
export const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code

/** Fail closed on links, shared permissions or a different owner. */
export const assertPrivate = async (path: string, directory: boolean): Promise<void> => {
  const info = await lstat(path)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid())) {
    throw new Error("Smithers daemon state must be private and owned by the current user.")
  }
}
export const prepareDaemonDirectory = async (stateDir: string): Promise<string> => {
  const path = daemonDirectory(stateDir)
  await mkdir(path, { recursive: true, mode: 0o700 })
  await assertPrivate(path, true)
  return path
}
export const readDaemonDescriptor = async (stateDir: string): Promise<DaemonDescriptor | undefined> => {
  const path = descriptorPath(stateDir)
  try {
    await assertPrivate(path, false)
    return DaemonDescriptorSchema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined
    throw error
  }
}
export const daemonBuild = async (entrypoint: string): Promise<string> =>
  createHash("sha256").update(await readFile(entrypoint)).digest("hex")
export const sameConfiguration = (a: DaemonConfiguration, b: DaemonConfiguration): boolean =>
  JSON.stringify(DaemonConfigurationSchema.parse(a)) === JSON.stringify(DaemonConfigurationSchema.parse(b))

/** Native-only Unix transport. Its capability is never the renderer's token. */
export const daemonRequest = async (descriptor: DaemonDescriptor, path: string, body?: unknown): Promise<Response> => {
  await assertPrivate(dirname(descriptor.socket), true)
  return fetch(`http://localhost${path}`, {
    unix: descriptor.socket,
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(path === "/shutdown" ? 15_000 : 3000),
    redirect: "error"
  })
}

/** Bun collapses Unix connection errors; ask the OS before declaring an owner absent. */
export const isDaemonUnavailable = async (error: unknown, descriptor: DaemonDescriptor): Promise<boolean> => {
  if (hasCode(error, "ENOENT") || hasCode(error, "ECONNREFUSED")) return true
  if (!hasCode(error, "FailedToOpenSocket")) return false
  return new Promise((resolve) => {
    const socket = createConnection(descriptor.socket)
    socket.setTimeout(1000)
    socket.once("connect", () => { socket.destroy(); resolve(false) })
    socket.once("timeout", () => { socket.destroy(); resolve(false) })
    socket.once("error", (cause) => resolve(hasCode(cause, "ENOENT") || hasCode(cause, "ECONNREFUSED")))
  })
}
