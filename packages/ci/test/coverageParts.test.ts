/**
 * `//packages/ci:test` runs as four parts, and each source is held to 100% coverage by exactly one of them
 * (vitest.config.ts). A part once excluded what the earlier parts named, which no later part included: a list that
 * did nothing and read as a hand-off (R1-Fable-D3-058). The hand-off that matters is checked here instead.
 */
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { held, heldBy } from "../vitest.config.ts"
import cli from "../vitest.part-cli.config.ts"
import native from "../vitest.part-native.config.ts"
import replay from "../vitest.part-replay.config.ts"
import rest from "../vitest.part-rest.config.ts"

const root = join(import.meta.dirname, "..")
const sources = (readdirSync(join(root, "src"), { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll("\\", "/"))
  .sort()

/** Whether a pattern of `held` names a file: a directory's `/**`, or the file itself. */
const names = (pattern: string, file: string): boolean =>
  pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : pattern === file

describe("the four parts of //packages/ci:test", () => {
  const parts = Object.keys(held) as Array<keyof typeof held>

  it("hold every source between them, each source in exactly one part", () => {
    expect(sources.length).toBeGreaterThan(100)
    const holders = (file: string) => parts.filter((part) => held[part].some((pattern) => names(pattern, file)))
    expect(sources.filter((file) => holders(file).length > 1)).toEqual([])
    // What no part names is `testRest`'s, so nothing is left to no part.
    const byRest = sources.filter((file) => holders(file).length === 0)
    expect(byRest.length).toBeGreaterThan(0)
    for (const part of parts) expect(sources.some((file) => holders(file).includes(part)), part).toBe(true)
  })

  it("name only sources that exist", () => {
    for (const pattern of Object.values(held).flat()) {
      expect(sources.some((file) => names(pattern, file)), pattern).toBe(true)
    }
  })

  it("leave nothing out of a part but in testRest, which leaves out all the others hold", () => {
    for (const part of parts) expect(heldBy(part)).toEqual({ coverage: [...held[part]] })
    const coverage = (config: typeof rest) =>
      config.test?.coverage as { include: Array<string>; exclude: Array<string> }
    for (const [part, config] of [["cli", cli], ["replay", replay], ["native", native]] as const) {
      expect(coverage(config).include).toEqual([...held[part]])
      expect(coverage(config).exclude.filter((pattern) => pattern.startsWith("src/"))).toEqual([])
    }
    expect(coverage(rest).include).toEqual(["src/**"])
    expect(coverage(rest).exclude.filter((pattern) => pattern.startsWith("src/"))).toEqual(Object.values(held).flat())
  })
})
