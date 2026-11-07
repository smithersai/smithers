import { afterAll, expect, it } from "@effect/vitest"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { contents, main } from "../../examples/40-sandbox-placement.vibe"

const directory = mkdtempSync(join(tmpdir(), "flows-sandbox-placement-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("places an action on a scratch machine and tears its workspace down", async () => {
  const filename = join(directory, "engine.sqlite")
  const root = join(directory, "sandboxes")

  const result = await main({ filename, root })

  expect(result).toBe(Buffer.byteLength(contents))
  expect(existsSync(filename)).toBe(true)
  expect(readdirSync(root)).toEqual([])
}, 60_000)
