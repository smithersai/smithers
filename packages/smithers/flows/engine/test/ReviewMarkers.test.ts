import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

const files = (directory: string): Array<string> =>
  readdirSync(join(root, directory), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(directory, file))

// Review bookkeeping is not documentation: it ships in the published .d.ts
// and generated reference pages, and nothing in the repository defines it.
const markers = [/@slop\b/, /Deep reviewed and polished/, /pending review/, /TODO\(/]

describe("review markers", () => {
  it("are absent from the package sources and tests", () => {
    const found = [...files("src"), ...files("test")].flatMap((file) => {
      const text = readFileSync(join(root, file), "utf8")
      return markers.filter((marker) => marker.test(text)).map((marker) => `${file}: ${marker.source}`)
    })
    expect(found.filter((entry) => !entry.startsWith("test/ReviewMarkers.test.ts"))).toEqual([])
  })
})
