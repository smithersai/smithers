import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { overTrackedFile, recoverTrackedFile } from "./flow-graph-fixture-source"

const MODULE = fileURLToPath(new URL("./flow-graph-fixture-source.ts", import.meta.url))
const ORIGINAL = "export const label = \"steady\"\n"
const EDITED = "export const label = \"steady-edited\"\n"

let dir: string
let source: string
let journal: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fixture-source-"))
  source = join(dir, "Fixture.ts")
  journal = join(dir, "journal")
  await writeFile(source, ORIGINAL)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * A second process that edits the source and then waits, the way a graph
 * spec holds its edit while the page reads the host. It prints `edited` once
 * the bytes are on disk; closing its stdin lets the body finish.
 */
const holdEdit = async () => {
  const script = `
    const { overTrackedFile } = await import(${JSON.stringify(MODULE)})
    await overTrackedFile(${JSON.stringify(source)}, async (_original, edit) => {
      edit(${JSON.stringify(EDITED)})
      process.stdout.write("edited\\n")
      await new Promise((resolve) => process.stdin.once("end", resolve).resume())
    }, ${JSON.stringify(journal)})
  `
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "inherit"] })
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("edited")) resolve() })
    child.once("close", (code) => reject(new Error(`holder exited ${code} before editing`)))
  })
  return { child, closed }
}

test("restores the file and forgets the edit when the body throws", async () => {
  await expect(overTrackedFile(source, async (_original, edit) => {
    edit(EDITED)
    throw new Error("assertion failed")
  }, journal)).rejects.toThrow("assertion failed")
  expect(await readFile(source, "utf8")).toBe(ORIGINAL)
  expect(await readdir(journal).catch(() => [])).toEqual([])
})

test("a SIGKILLed edit is put back before the next run reads the file", async () => {
  const { child, closed } = await holdEdit()
  child.kill("SIGKILL")
  await closed
  // SIGKILL runs no handler: the edit is still on disk, which is the defect.
  expect(await readFile(source, "utf8")).toBe(EDITED)

  let seen: string | undefined
  await overTrackedFile(source, async (original) => { seen = original }, journal)
  expect(seen).toBe(ORIGINAL)
  expect(await readFile(source, "utf8")).toBe(ORIGINAL)
})

test("a host starting after a SIGKILLed edit restores the file", async () => {
  const { child, closed } = await holdEdit()
  child.kill("SIGKILL")
  await closed
  expect(recoverTrackedFile(source, journal)).toBe("restored")
  expect(await readFile(source, "utf8")).toBe(ORIGINAL)
  expect(recoverTrackedFile(source, journal)).toBe("clean")
})

test("a second edit of the same file refuses while the first one holds it", async () => {
  const { child, closed } = await holdEdit()
  try {
    let entered = false
    await expect(overTrackedFile(source, async () => { entered = true }, journal))
      .rejects.toThrow(`pid ${child.pid}`)
    expect(entered).toBe(false)
    // A live edit is not a crash: startup recovery leaves it alone.
    expect(recoverTrackedFile(source, journal)).toBe("held")
    expect(await readFile(source, "utf8")).toBe(EDITED)
  } finally {
    child.stdin!.end()
    await closed
  }
  expect(await readFile(source, "utf8")).toBe(ORIGINAL)
})
