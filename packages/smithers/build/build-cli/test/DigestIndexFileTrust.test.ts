import * as SafeFs from "@smthrs/targets/SafeFs"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as DigestIndexFile from "../src/internal/DigestIndexFile.ts"

const roots: Array<string> = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await Fs.chmod(Path.join(root, ".flows/plan"), 0o755).catch(() => undefined)
    await Fs.rm(root, { recursive: true, force: true })
  }
})

const workspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-digest-index-trust-")))
  roots.push(root)
  return root
}

const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex")

/** Writes an index whose format and checksum are right but whose rows are `rows`. */
const writeRows = async (root: string, rows: unknown): Promise<void> => {
  const encoded = JSON.stringify(rows)
  const file = DigestIndexFile.path(root, ".flows")
  await Fs.mkdir(Path.dirname(file), { recursive: true })
  await Fs.writeFile(file, JSON.stringify({ format: "smthrs-file-digests/1", check: sha256Of(encoded), rows: encoded }))
}

const loadLogged = async (root: string) => {
  const lines: Array<string> = []
  const index = await DigestIndexFile.load(root, ".flows", (line) => lines.push(line))
  return { index, lines }
}

const digest = "b".repeat(64)

describe("DigestIndexFile.load trusts only well-formed rows", () => {
  it("loads a well-formed row as a settled digest", async () => {
    const root = await workspace()
    await writeRows(root, [["/abs/file", "status-1", digest]])
    const { index, lines } = await loadLogged(root)
    expect(lines).toEqual([])
    expect([...index.rows]).toEqual([["/abs/file", { status: "status-1", digest, settled: true }]])
  })

  it.each([
    ["rows that are not an array", { "/abs/file": ["status", digest] }],
    ["a row that is not a triple", [["/abs/file", "status"]]],
    ["a row that is not an array", ["/abs/file"]],
    ["a relative path", [["relative/file", "status", digest]]],
    ["an empty status", [["/abs/file", "", digest]]],
    ["a status that is not a string", [["/abs/file", 7, digest]]],
    ["a digest that is not hex SHA-256", [["/abs/file", "status", "B".repeat(64)]]],
    ["a digest that is not a string", [["/abs/file", "status", 1]]]
  ])("ignores the index with %s", async (_name, rows) => {
    const root = await workspace()
    await writeRows(root, rows)
    const { index, lines } = await loadLogged(root)
    expect(index.rows.size).toBe(0)
    expect(lines).toEqual(["smthrs: file digest index ignored: malformed row"])
  })

  it.each([["null"], ["42"], ["\"text\""]])("ignores a saved index that is JSON %s, not an object", async (text) => {
    const root = await workspace()
    const file = DigestIndexFile.path(root, ".flows")
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(file, text)
    const { index, lines } = await loadLogged(root)
    expect(index.rows.size).toBe(0)
    expect(lines).toEqual(["smthrs: file digest index ignored: not an object"])
  })

  it("ignores an index it cannot read and logs why", async () => {
    const root = await workspace()
    await Fs.mkdir(DigestIndexFile.path(root, ".flows"), { recursive: true })
    const { index, lines } = await loadLogged(root)
    expect(index.rows.size).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^smthrs: file digest index ignored: .*EISDIR/)
  })

  it("ignores an index over 512 MiB without reading it", async () => {
    const root = await workspace()
    const file = DigestIndexFile.path(root, ".flows")
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    const size = 512 * 1024 * 1024 + 1
    // A sparse file: the size is real to stat, the disk holds no data.
    const handle = await Fs.open(file, "w")
    await handle.truncate(size)
    await handle.close()
    const { index, lines } = await loadLogged(root)
    expect(index.rows.size).toBe(0)
    expect(lines).toEqual([`smthrs: file digest index ignored: ${size} bytes is over ${512 * 1024 * 1024}`])
  })
})

describe("DigestIndexFile.save", () => {
  it("keeps at most maximumRows rows, used rows first", async () => {
    const root = await workspace()
    const total = DigestIndexFile.maximumRows + 2
    const rows: Array<readonly [string, SafeFs.DigestRow]> = []
    for (let i = 0; i < total; i++) rows.push([`/f/${i}`, { status: "s", digest, settled: true }])
    const index = SafeFs.makeDigestIndex(rows)
    const lastFile = `/f/${total - 1}`
    index.used.add(lastFile)
    await DigestIndexFile.save(root, ".flows", index)
    const loaded = await DigestIndexFile.load(root, ".flows")
    expect(loaded.rows.size).toBe(DigestIndexFile.maximumRows)
    const keys = [...loaded.rows.keys()]
    expect(keys[0]).toBe(lastFile)
    expect(keys[1]).toBe("/f/0")
    expect(loaded.rows.has(`/f/${total - 2}`)).toBe(false)
    expect(loaded.rows.has(`/f/${total - 3}`)).toBe(false)
    expect(loaded.rows.has(`/f/${total - 4}`)).toBe(true)
  }, 60_000)

  it("does not rewrite a loaded index when a plan forgets a row it never had", async () => {
    const root = await workspace()
    await writeRows(root, [["/abs/file", "s", digest]])
    const file = DigestIndexFile.path(root, ".flows")
    const before = await Fs.stat(file, { bigint: true })
    const loaded = await DigestIndexFile.load(root, ".flows")
    expect(loaded.rows.delete("/abs/other")).toBe(false)
    await DigestIndexFile.save(root, ".flows", loaded)
    const after = await Fs.stat(file, { bigint: true })
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs])
  })

  it("logs a save whose .gitignore cannot be written and leaves no temporary file", async () => {
    const root = await workspace()
    const directory = Path.dirname(DigestIndexFile.path(root, ".flows"))
    await Fs.mkdir(directory, { recursive: true })
    await Fs.chmod(directory, 0o555)
    const index = SafeFs.makeDigestIndex([["/abs/file", { status: "s", digest, settled: true }]])
    const lines: Array<string> = []
    await DigestIndexFile.save(root, ".flows", index, (line) => lines.push(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^smthrs: file digest index not saved: .*EACCES/)
    await Fs.chmod(directory, 0o755)
    expect(await Fs.readdir(directory)).toEqual([])
  })
})
