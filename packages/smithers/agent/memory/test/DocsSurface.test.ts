import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

const namespaces = [...read("../src/index.ts").matchAll(/^export \* as (\w+) from /gmu)].map((match) => match[1]!)

describe("documented namespace tables", () => {
  it("reads the root namespaces from index.ts", () => {
    expect(namespaces.length).toBeGreaterThan(0)
  })

  it.each(["../README.md", "../docs/surface.md"])("%s lists every root namespace", (path) => {
    const text = read(path)
    expect(namespaces.filter((name) => !text.includes(`| \`${name}\``))).toEqual([])
  })
})
