import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as External from "../src/external.ts"

describe("external editor", () => {
  it("passes the file safely under a path with spaces, keeps editor arguments, and removes the file", () => {
    const parent = join(mkdtempSync(join(tmpdir(), "tui-editor-")), "with space")
    mkdirSync(parent)
    expect(External.edit("draft", "printf 'edited\\n' >", parent)).toBe("edited")
    expect(readdirSync(parent)).toEqual([])
  })

  it("keeps the draft when the editor fails, and still removes the file", () => {
    const parent = mkdtempSync(join(tmpdir(), "tui-editor-"))
    expect(External.edit("draft", "false", parent)).toBeUndefined()
    expect(readdirSync(parent)).toEqual([])
    expect(existsSync(parent)).toBe(true)
  })
})

describe("bounded quit", () => {
  it("returns when the work settles", async () => {
    const started = Date.now()
    await External.bounded(Promise.resolve(), 5_000)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("returns after the bound when the work hangs", async () => {
    const started = Date.now()
    await External.bounded(new Promise(() => {}), 100)
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
  })

  it("returns when the work rejects", async () => {
    await External.bounded(Promise.reject(new Error("dispose failed")), 5_000)
  })
})
