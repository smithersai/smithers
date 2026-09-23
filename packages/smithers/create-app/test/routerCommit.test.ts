/**
 * `writeRoutes` publishes both generated tables or neither.
 *
 * A rename that fails after the first table was already replaced cannot be
 * produced with real permissions, because both tables share one directory, so
 * this file injects it: `node:fs` is the real module except that `renameSync`
 * refuses the target a test names.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultDirs } from "../src/app.ts"
import { writeRoutes } from "../src/router.ts"
import { appTrees } from "./support/appTree.ts"
import { layers } from "./support/layers.ts"

const refuse = vi.hoisted(() => ({ target: undefined as string | undefined }))

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (refuse.target !== undefined && to === refuse.target) {
        throw Object.assign(new Error(`ENOSPC: no space left on device, rename '${from}' -> '${to}'`), {
          code: "ENOSPC"
        })
      }
      fs.renameSync(from, to)
    }
  }
})

const { write: appTree, remove } = appTrees("smthrs-router-commit-")

afterEach(() => {
  refuse.target = undefined
  remove()
})

describe("writeRoutes commit", () => {
  it("restores the first table when the second rename fails", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    writeRoutes({ root, dirs: defaultDirs })
    const before = {
      "routes.gen.ts": readFileSync(join(root, "routes.gen.ts"), "utf8"),
      "routes.ui.gen.ts": readFileSync(join(root, "routes.ui.gen.ts"), "utf8")
    }
    mkdirSync(join(root, "app/panes"), { recursive: true })
    writeFileSync(join(root, "app/panes/balances.tsx"), "export const Pane = {}\n")
    refuse.target = join(root, "routes.ui.gen.ts")

    expect(() => writeRoutes({ root, dirs: defaultDirs })).toThrow(/ENOSPC/)
    expect(readFileSync(join(root, "routes.gen.ts"), "utf8")).toBe(before["routes.gen.ts"])
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toBe(before["routes.ui.gen.ts"])
    expect(existsSync(join(root, "routes.gen.ts.tmp"))).toBe(false)
    expect(existsSync(join(root, "routes.ui.gen.ts.tmp"))).toBe(false)
  })

  it("removes a first table that did not exist before when the second rename fails", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    refuse.target = join(root, "routes.ui.gen.ts")

    expect(() => writeRoutes({ root, dirs: defaultDirs })).toThrow(/ENOSPC/)
    expect(existsSync(join(root, "routes.gen.ts"))).toBe(false)
    expect(existsSync(join(root, "routes.ui.gen.ts"))).toBe(false)
    expect(existsSync(join(root, "routes.gen.ts.tmp"))).toBe(false)
    expect(existsSync(join(root, "routes.ui.gen.ts.tmp"))).toBe(false)
  })
})
