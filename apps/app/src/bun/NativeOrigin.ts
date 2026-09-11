import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

interface LocalHost {
  readonly port: number
  readonly stop: () => Promise<void>
}

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code

/** Browser storage belongs to an origin, including its port. Keep that origin across launches. */
export const startWithPersistentOrigin = async <T extends LocalHost>(
  stateDir: string,
  start: (port: number) => Promise<T>,
  override?: number
): Promise<T> => {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 0 || override > 65535) {
      throw new Error("SMITHERS_LOCAL_PORT must be an integer between 0 and 65535.")
    }
    return start(override)
  }
  await mkdir(stateDir, { recursive: true })
  const path = join(stateDir, "local-origin-port")
  const readPort = async (): Promise<number | undefined> => {
    let raw: string
    try { raw = await readFile(path, "utf8") } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined
      throw error
    }
    const port = Number(raw.trim())
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`The saved Smithers origin in ${path} is invalid; refusing to change the saved-data origin.`)
    }
    return port
  }
  const saved = await readPort()
  if (saved !== undefined) return start(saved)
  const host = await start(0)
  const staged = `${path}.${crypto.randomUUID()}`
  try {
    // Claim the first origin before opening the window. Concurrent launches must agree.
    await writeFile(staged, `${host.port}\n`, { flag: "wx", mode: 0o600 })
    await link(staged, path)
    return host
  } catch (error) {
    await host.stop()
    if (!hasCode(error, "EEXIST")) throw error
    const winner = await readPort()
    if (winner === undefined) throw new Error("The saved Smithers origin disappeared during startup.")
    return start(winner)
  } finally {
    // Cleanup cannot invalidate a successfully published origin or strand its server.
    await unlink(staged).catch(() => undefined)
  }
}
