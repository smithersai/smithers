import { expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Watch from "../src/watch.ts"

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const mdx = "---\ndescription: Review\n---\nReview it.\n"

it("refreshes once after a new flow.mdx, once after a burst, and never after dispose", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-watch-"))
  mkdirSync(join(cwd, "flows"))
  let refreshes = 0
  const watcher = Watch.flows(cwd, () => refreshes++, 100)
  await settle(50)
  mkdirSync(join(cwd, "flows", "review"))
  writeFileSync(join(cwd, "flows", "review", "flow.mdx"), mdx)
  await settle(400)
  expect(refreshes).toBe(1)
  for (let n = 0; n < 10; n++) {
    writeFileSync(join(cwd, "flows", "review", "flow.mdx"), `${mdx}${n}\n`)
    await settle(10)
  }
  await settle(400)
  expect(refreshes).toBe(2)
  watcher.dispose()
  writeFileSync(join(cwd, "flows", "review", "flow.mdx"), `${mdx}after\n`)
  await settle(400)
  expect(refreshes).toBe(2)
})

it("notices flows/ created after the TUI started", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-watch-late-"))
  let refreshes = 0
  const watcher = Watch.flows(cwd, () => refreshes++, 100)
  await settle(50)
  mkdirSync(join(cwd, "flows", "review"), { recursive: true })
  await settle(400)
  expect(refreshes).toBe(1)
  writeFileSync(join(cwd, "flows", "review", "flow.mdx"), mdx)
  await settle(400)
  expect(refreshes).toBe(2)
  watcher.dispose()
})
