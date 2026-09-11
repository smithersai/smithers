/**
 * One name for one file. A mechanical rename once replaced `BUILD.ts` with the
 * phrase "legacy" plus "declaration", which named the live `PACKAGE.ts` as if it were
 * retired and leaked into scaffolded READMEs and runtime errors.
 */
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"

const packageRoot = NodePath.resolve(import.meta.dirname, "..")

const files = async (directory: string): Promise<ReadonlyArray<string>> =>
  (await Fs.readdir(NodePath.join(packageRoot, directory), { recursive: true }))
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".md"))
    .map((entry) => NodePath.join(directory, entry))

describe("declaration vocabulary", () => {
  it("never calls PACKAGE.ts a PACKAGE.ts", async () => {
    const phrase = ["legacy", "declaration"].join(" ")
    const offenders: Array<string> = []
    for (const file of [...await files("src"), ...await files("test"), "README.md"]) {
      const text = await Fs.readFile(NodePath.join(packageRoot, file), "utf8").catch(() => "")
      if (text.includes(phrase)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
