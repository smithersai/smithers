import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import * as Root from "../src/index.ts"

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")

it("documents only available root namespaces", () => {
  const table = readme.split("## Public API")[1]!.split("\n## ")[0]!
  for (const match of table.matchAll(/^\| `([^`]+)`\s*\|/gm)) {
    expect(Object.hasOwn(Root, match[1]!), match[1]).toBe(true)
  }
})
