/**
 * The throwaway-tree helper four suites share.
 *
 * Each suite used to carry its own copy, so the one thing they all depend on is
 * pinned here once: `write` lays out nested paths under a fresh root with the
 * suite's prefix, and `remove` deletes every root written since it last ran.
 */
import { describe, expect, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { appTrees } from "./support/appTree.ts"

describe("appTrees", () => {
  it("writes nested files under a fresh root named with the prefix", () => {
    const trees = appTrees("smthrs-app-tree-")
    const root = trees.write({ "AGENT.ts": "root\n", "flows/echo/flow.ts": "nested\n" })
    expect(basename(root).startsWith("smthrs-app-tree-")).toBe(true)
    expect(readFileSync(join(root, "AGENT.ts"), "utf8")).toBe("root\n")
    expect(readFileSync(join(root, "flows/echo/flow.ts"), "utf8")).toBe("nested\n")
    expect(trees.write({})).not.toBe(root)
    trees.remove()
  })

  it("removes every root written since the last removal", () => {
    const trees = appTrees("smthrs-app-tree-")
    const first = trees.write({ "a.ts": "" })
    const second = trees.write({})
    trees.remove()
    expect([existsSync(first), existsSync(second)]).toEqual([false, false])
    const third = trees.write({})
    trees.remove()
    expect(existsSync(third)).toBe(false)
  })
})
