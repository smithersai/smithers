import * as Fs from "node:fs"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const sourceRoot = Path.join(Path.dirname(fileURLToPath(import.meta.url)), "..", "src")

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  Fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = Path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : []
  })

/**
 * Every place a JSDoc block is followed by another JSDoc block rather than by
 * the declaration it documents, as `<relative path>:<1-indexed line>`.
 *
 * A module docblock — the first block in the file, opening on line 1 — is the
 * exception: it documents the module, and the block under it documents the
 * first export.
 */
const orphanedDocblocks = (file: string, text: string): ReadonlyArray<string> => {
  const lines = text.split("\n")
  const found: Array<string> = []
  let openedAt = -1
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (openedAt === -1) {
      if (!line.startsWith("/**")) continue
      openedAt = index
    }
    if (!line.endsWith("*/")) continue
    let next = index + 1
    while (next < lines.length && lines[next]!.trim() === "") next += 1
    if (openedAt > 0 && next < lines.length && lines[next]!.trim().startsWith("/**")) {
      found.push(`${Path.relative(sourceRoot, file)}:${openedAt + 1}`)
    }
    openedAt = -1
  }
  return found
}

describe("the package's own sources", () => {
  it("closes one-line docblocks before scanning a later declaration", () => {
    const source =
      "/** One line. */\nconst first = 1\n/**\n * Second.\n */\nconst second = 2\n/** Third. */\nconst third = 3"
    expect(orphanedDocblocks(Path.join(sourceRoot, "Fixture.ts"), source)).toEqual([])
  })

  it("finds adjacent one-line and multiline docblocks after the module header", () => {
    const source =
      "/** Module. */\nconst first = 1\n/** Orphan. */\n/**\n * Actual documentation.\n */\nconst second = 2"
    expect(orphanedDocblocks(Path.join(sourceRoot, "Fixture.ts"), source)).toEqual(["Fixture.ts:3"])
  })

  /**
   * A docblock that documents nothing is a copy nobody deleted. eslint and
   * dprint both accept it, and a reader hunting the contract of an export
   * reads the wrong paragraph: release validation found two consecutive
   * blocks above `carriesRpcRequest`, one of them the layer's text repeated
   * verbatim from further down the file.
   */
  it("attach every JSDoc block to the declaration under it", () => {
    const orphans = sourceFiles(sourceRoot).flatMap((file) => orphanedDocblocks(file, Fs.readFileSync(file, "utf8")))
    expect(orphans).toEqual([])
  })
})
