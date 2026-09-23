import { describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Search from "../src/search.ts"

const tree = () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-search-"))
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a - b\n")
  writeFileSync(join(cwd, "dots.txt"), "axb\n")
  writeFileSync(join(cwd, "we:ird.js"), "needle here\n")
  mkdirSync(join(cwd, "many"))
  for (let file = 0; file < 30; file++) {
    writeFileSync(join(cwd, "many", `f${file}.txt`), Array.from({ length: 10 }, () => "repeated").join("\n") + "\n")
  }
  return cwd
}

describe("rg search", () => {
  const cwd = tree()

  it("finds a literal by default", async () => {
    const outcome = await Search.run({ cwd, query: "a - b" }).done
    expect(outcome._tag).toBe("done")
    if (outcome._tag !== "done") return
    expect(outcome.hits).toHaveLength(1)
    expect(outcome.hits[0]).toMatchObject({ path: "math.js", line: 1 })
    expect(outcome.hits[0]!.text).toContain("a - b")
    expect(outcome.truncated).toBe(false)
  })

  it("treats dots literally unless a regex is given", async () => {
    const literal = await Search.run({ cwd, query: "a.b" }).done
    expect(literal._tag === "done" ? literal.hits : undefined).toEqual([])
    const regex = await Search.run({ cwd, query: "/a.b/", regex: "a.b" }).done
    expect(regex._tag === "done" ? regex.hits.map((hit) => hit.path) : undefined).toContain("dots.txt")
  })

  it("keeps a colon inside a path", async () => {
    const outcome = await Search.run({ cwd, query: "needle" }).done
    expect(outcome._tag === "done" ? outcome.hits : undefined).toEqual([{ path: "we:ird.js", line: 1, text: "needle here" }])
  })

  it("stops at the cap and says so", async () => {
    const outcome = await Search.run({ cwd, query: "repeated", limit: 50 }).done
    expect(outcome._tag).toBe("done")
    if (outcome._tag !== "done") return
    expect(outcome.hits).toHaveLength(50)
    expect(outcome.truncated).toBe(true)
  })

  it("types a bad pattern and a missing rg", async () => {
    expect(await Search.run({ cwd, query: "/(/", regex: "(" }).done).toMatchObject({
      _tag: "failed",
      reason: "bad-pattern",
      message: "unclosed group"
    })
    expect(await Search.run({ cwd, query: "x", command: "rg-does-not-exist" }).done).toMatchObject({
      _tag: "failed",
      reason: "missing-rg"
    })
  })

  it("resolves cancelled once when cancelled before rg finishes", async () => {
    const shim = join(mkdtempSync(join(tmpdir(), "tui-slow-rg-")), "rg")
    writeFileSync(shim, "#!/bin/sh\nsleep 30\n")
    chmodSync(shim, 0o755)
    const started = Date.now()
    const running = Search.run({ cwd, query: "x", command: shim })
    running.cancel()
    running.cancel()
    expect(await running.done).toEqual({ _tag: "cancelled" })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("returns no hits, not a failure, when nothing matches", async () => {
    expect(await Search.run({ cwd, query: "zzz-not-here" }).done).toEqual({ _tag: "done", hits: [], truncated: false })
  })
})
