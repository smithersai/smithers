import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readJournalLines } from "./JournalLines"

const collect = async (path: string, chunkBytes: number): Promise<Array<string>> => {
  const lines: Array<string> = []
  for await (const line of readJournalLines(path, chunkBytes)) lines.push(line)
  return lines
}

test("lines that straddle chunk boundaries, CRLF endings and a partial last line come out whole", async () => {
  const dir = await mkdtemp(join(tmpdir(), "smithers-journal-lines-"))
  try {
    const path = join(dir, "run.jsonl")
    const long = "y".repeat(1000)
    await writeFile(path, `first\r\n${long}\n\nlast-without-newline`)
    for (const chunkBytes of [1, 7, 64, 1 << 20]) {
      expect(await collect(path, chunkBytes)).toEqual(["first", long, "", "last-without-newline"])
    }
    await writeFile(path, "")
    expect(await collect(path, 64)).toEqual([])
    /* A multi-byte character split by the chunk boundary is decoded once, whole. */
    await writeFile(path, "héllo wörld\n")
    expect(await collect(path, 2)).toEqual(["héllo wörld"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a reader that stops early gets only the lines it asked for", async () => {
  const dir = await mkdtemp(join(tmpdir(), "smithers-journal-lines-"))
  try {
    const path = join(dir, "run.jsonl")
    await writeFile(path, "a\nb\nc\n")
    const lines: Array<string> = []
    for await (const line of readJournalLines(path, 2)) {
      lines.push(line)
      if (lines.length === 1) break
    }
    expect(lines).toEqual(["a"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
