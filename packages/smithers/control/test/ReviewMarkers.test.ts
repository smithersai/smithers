/**
 * The internal `@slop` review marker never ships.
 *
 * `factory/flows/slop-sweep.ts` tags every unreviewed export with `@slop`. The
 * marker is a note to maintainers, and a published declaration carrying it
 * tells every user the control-plane surface was never reviewed.
 */
import * as Fs from "node:fs"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const sourceRoot = Path.join(Path.dirname(fileURLToPath(import.meta.url)), "..", "src")

const sources = (directory: string): ReadonlyArray<string> =>
  Fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = Path.join(directory, entry.name)
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : []
  })

describe("review markers", () => {
  it("ships no @slop marker in src", () => {
    const marked = sources(sourceRoot).filter((file) => Fs.readFileSync(file, "utf8").includes("@slop"))
    expect(marked.map((file) => Path.relative(sourceRoot, file))).toEqual([])
  })
})
