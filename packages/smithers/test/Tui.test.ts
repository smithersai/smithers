/**
 * `smthrs tui`: the hand-off to Bun.
 *
 * A fake Bun records the argument vector it received and exits with a chosen
 * status, so these cases pin what the TUI is started with and that its status
 * becomes the command's, without starting a renderer.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as Tui from "../src/commands/Tui.ts"

const staged: Array<string> = []

afterEach(() => {
  for (const root of staged.splice(0)) rmSync(root, { recursive: true, force: true })
})

const stage = (): { readonly root: string; readonly bun: string; readonly entry: string; readonly log: string } => {
  const root = mkdtempSync(join(tmpdir(), "smithers-tui-"))
  staged.push(root)
  const log = join(root, "argv.json")
  const bun = join(root, "bun")
  writeFileSync(
    bun,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${
      JSON.stringify(log)
    }, JSON.stringify(process.argv.slice(2)))\nprocess.exit(Number(process.env.FAKE_STATUS ?? 0))\n`
  )
  chmodSync(bun, 0o755)
  const entry = join(root, "main.js")
  writeFileSync(entry, "")
  return { root, bun, entry, log }
}

describe("smthrs tui", () => {
  it("starts the entry under Bun with the TUI's own flags and returns its status", async () => {
    const { bun, entry, log } = stage()
    const status = await Tui.run(
      { directory: "repo", model: "openai:gpt-6-sol", continue: true, resume: false, print: "hi" },
      { ...process.env, SMITHERS_BUN: bun, FAKE_STATUS: "7" },
      entry
    )
    expect(status).toBe(7)
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual([
      entry,
      "--model",
      "openai:gpt-6-sol",
      "--continue",
      "--print",
      "hi",
      "repo"
    ])
  })

  it("names Bun when it is not installed", async () => {
    const { root, entry } = stage()
    await expect(Tui.run({}, { SMITHERS_BUN: join(root, "missing-bun") }, entry)).rejects.toMatchObject({
      _tag: "/cli/UnsupportedError",
      message: expect.stringContaining("needs Bun")
    })
  })

  it("refuses an installation without the TUI bundle", async () => {
    const { root, bun } = stage()
    await expect(Tui.run({}, { SMITHERS_BUN: bun }, join(root, "absent.js"))).rejects.toBeInstanceOf(
      CliError.UnsupportedError
    )
  })

  it("runs the checkout source inside the workspace and the bundle when installed", () => {
    const { root } = stage()
    const installed = pathToFileURL(join(root, "node_modules/@smthrs/cli/"))
    expect(Tui.entry(installed)).toBe(join(root, "node_modules/@smthrs/cli/dist/tui/main.js"))
    const workspace = new URL("../", import.meta.url)
    expect(Tui.entry(workspace)).toMatch(/apps\/tui\/src\/main\.tsx$/)
  })
})
