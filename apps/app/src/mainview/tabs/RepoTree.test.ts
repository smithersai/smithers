import { describe, expect, test } from "bun:test"
import type { RepoTreeRow } from "../state/AppState"
import { copyTreesOf } from "./RepoTree"

const row = (copyId: string, path: string, entries: RepoTreeRow["entries"], expanded = true, state: RepoTreeRow["state"] = "loaded"): RepoTreeRow => ({
  id: `${copyId}#${path}`,
  copyId,
  path,
  expanded,
  state,
  entries,
  loadedAt: 0
})

describe("copyTreesOf: every copy's tree from one pass over the rows", () => {
  test("interleaved rows of two copies index apart, each in path order with its own collapsed set", () => {
    const treeOf = copyTreesOf([
      row("b", "", [{ name: "docs", kind: "dir" }, { name: "b.md", kind: "file" }]),
      row("a", "src", [{ name: "index.ts", kind: "file" }]),
      row("b", "docs", [], false, "loading"),
      row("a", "", [{ name: "lib", kind: "dir" }, { name: "src", kind: "dir" }, { name: "a.md", kind: "file" }])
    ])

    const a = treeOf("a")
    expect(a.root?.path).toBe("")
    expect(a.directories).toEqual(["lib", "src"])
    expect(a.nodes).toEqual(["a.md", "src/index.ts"])
    // `lib` has no row and `src` is expanded, so only `lib` is collapsed.
    expect([...a.collapsed]).toEqual(["lib"])
    expect([...a.rows.keys()].sort()).toEqual(["", "src"])

    const b = treeOf("b")
    expect(b.directories).toEqual(["docs"])
    // A directory still loading lists nothing under it and stays collapsed.
    expect(b.nodes).toEqual(["b.md"])
    expect([...b.collapsed]).toEqual(["docs"])
  })

  test("a copy with no rows is the empty tree", () => {
    const empty = copyTreesOf([row("a", "", [])])("unknown")
    expect(empty.root).toBeUndefined()
    expect(empty.nodes).toEqual([])
    expect(empty.directories).toEqual([])
    expect(empty.rows.size).toBe(0)
  })
})
