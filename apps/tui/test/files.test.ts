import { expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Editor from "../src/editor.ts"
import * as Files from "../src/files.ts"
import * as Palette from "../src/palette.ts"

it("shows palette commands immediately and fills files after asynchronous enumeration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-files-"))
  const saved = process.env.PATH
  writeFileSync(join(cwd, "git"), '#!/bin/sh\n/bin/sleep 0.4\nprintf "a.ts\\n"\n', { mode: 0o755 })
  process.env.PATH = cwd
  try {
    let refreshed = 0
    const files = Files.lister(cwd, Date.now, () => refreshed++)
    const sources = { commands: Editor.commands, files, sessions: [], tabs: [], hits: [], now: Date.now() }
    const started = Date.now()
    const initial = Palette.rows(Palette.parse(""), sources)
    expect(Date.now() - started).toBeLessThan(200)
    expect(initial.every((row) => row.value.kind === "command")).toBe(true)
    expect(initial.length).toBe(Editor.commands.length)
    await Bun.sleep(10)
    expect(refreshed).toBe(0)
    for (let n = 0; n < 200 && refreshed === 0; n++) await Bun.sleep(10)
    expect(refreshed).toBe(1)
    expect(Palette.rows(Palette.parse(""), sources).at(-1)?.value).toEqual({ kind: "file", path: "a.ts" })
  } finally {
    process.env.PATH = saved
    rmSync(cwd, { recursive: true, force: true })
  }
})

it("times out file enumeration without blocking timers", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-files-timeout-"))
  const saved = process.env.PATH
  for (const command of ["git", "rg"]) {
    writeFileSync(join(cwd, command), '#!/bin/sh\nexec /bin/sleep 0.4\n', { mode: 0o755 })
  }
  process.env.PATH = cwd
  try {
    let timerRan = false
    const timer = setTimeout(() => { timerRan = true }, 5)
    const started = Date.now()
    expect(await Files.list(cwd, 30)).toEqual([])
    expect(timerRan).toBe(true)
    expect(Date.now() - started).toBeLessThan(300)
    clearTimeout(timer)
  } finally {
    process.env.PATH = saved
    rmSync(cwd, { recursive: true, force: true })
  }
})
