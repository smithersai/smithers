import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startWithPersistentOrigin } from "./NativeOrigin"

const directories: string[] = []
const directory = async () => {
  const dir = await mkdtemp(join(tmpdir(), "smithers-origin-"))
  directories.push(dir)
  return dir
}
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

test("a normal relaunch reuses the first origin; a busy port never silently changes it", async () => {
  const dir = await directory()
  const ports: number[] = []
  const start = async (port: number) => { ports.push(port); return { port: port || 51234, stop: async () => {} } }
  await startWithPersistentOrigin(dir, start)
  await startWithPersistentOrigin(dir, start)
  expect(ports).toEqual([0, 51234])
  await expect(startWithPersistentOrigin(dir, async () => { throw new Error("address in use") })).rejects.toThrow("address in use")
  expect((await readFile(join(dir, "local-origin-port"), "utf8")).trim()).toBe("51234")
})

test("concurrent first launches claim one complete port record and stop the losing server", async () => {
  const dir = await directory()
  let allocated = 51234
  const stopped: number[] = []
  const start = async (requested: number) => {
    const port = requested || allocated++
    return { port, stop: async () => { stopped.push(port) } }
  }
  const hosts = await Promise.all([startWithPersistentOrigin(dir, start), startWithPersistentOrigin(dir, start)])
  expect(hosts[0]!.port).toBe(hosts[1]!.port)
  expect(stopped).toHaveLength(1)
})

test("explicit test ports do not replace the saved origin; corrupt records fail closed", async () => {
  const dir = await directory()
  const start = async (port: number) => ({ port: port || 51234, stop: async () => {} })
  await startWithPersistentOrigin(dir, start)
  expect((await startWithPersistentOrigin(dir, start, 51235)).port).toBe(51235)
  expect((await startWithPersistentOrigin(dir, start)).port).toBe(51234)
  await expect(startWithPersistentOrigin(dir, start, 99999)).rejects.toThrow("SMITHERS_LOCAL_PORT")
  await writeFile(join(dir, "local-origin-port"), "corrupt")
  await expect(startWithPersistentOrigin(dir, start)).rejects.toThrow("refusing to change")
})
