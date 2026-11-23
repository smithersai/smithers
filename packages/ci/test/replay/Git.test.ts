/**
 * Every command line in smithers-ci's sources that starts git gives it
 * {@link gitArguments}: no upkeep of its own, wherever it runs.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { gitArguments, noUpkeep } from "../../src/replay/Git.vibe"

const sources = fileURLToPath(new URL("../../src", import.meta.url))

/** Every source file under `directory`, declarations left out. */
const files = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return files(path)
    return /\.(ts|vibe)$/.test(entry.name) && !/\.d\.(vibe\.)?ts$/.test(entry.name) ? [path] : []
  })

describe("how smithers-ci starts git", () => {
  it("puts maintenance and garbage collection off before the command's own arguments", () => {
    expect(gitArguments(["commit", "--quiet"])).toEqual([
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "-c",
      "core.fsmonitor=false",
      "commit",
      "--quiet"
    ])
    expect(gitArguments([])).toEqual(noUpkeep)
  })

  it("is the only way a source starts git", () => {
    // A program name "git" opening a call's or a command line's arguments, then anything but gitArguments.
    const starts = /[([]\s*"git"\s*,\s*(?!gitArguments\(|\.\.\.gitArguments\()(\S+)/g
    const found = files(sources).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(starts)].map((match) => `${relative(sources, file)}: ${match[0]}`)
    )
    expect(found).toEqual([])
    // The search finds what it is for.
    expect([...`exec("git", ["status"])`.matchAll(starts)]).toHaveLength(1)
  })
})
