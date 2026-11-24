/**
 * `//packages/ci:toolCaches` fills the caches of the tools the suite starts. It once ended in `true` with every
 * diagnostic sent to /dev/null, so a dprint plugin that could not be fetched left a green prerequisite and a suite
 * that failed for a reason nothing named (R1-Astra-D3-005).
 */
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { toolCachesShell } from "../PACKAGE.ts"

const created: Array<string> = []
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

/** A workspace with the three required programs, each ending as `exits` says, and a `zig` that ends as `zig` says. */
const workspace = (exits: { ci?: number; smthrs?: number; dprint?: number; zig?: number }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tool-caches-")))
  created.push(root)
  const program = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
    chmodSync(join(root, file), 0o755)
  }
  const script = (name: string, code: number) =>
    `#!/bin/sh\necho "${name} ran" >> "${root}/ran"\necho "${name} says why" >&2\nexit ${code}\n`
  program(
    "packages/ci/bin/smithers-ci.mjs",
    `console.error("smithers-ci says why"); process.exit(${exits.ci ?? 0})\n`
  )
  program("node_modules/.bin/smthrs", script("smthrs", exits.smthrs ?? 0))
  program("packages/ci/node_modules/.bin/dprint", script("dprint", exits.dprint ?? 0))
  const bin = join(root, "bin")
  if (exits.zig !== undefined) program("bin/zig", script("zig", exits.zig))
  else mkdirSync(bin)
  const ran = spawnSync("/bin/sh", ["-c", toolCachesShell], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` }
  })
  return { ...ran, root }
}

describe("//packages/ci:toolCaches", () => {
  it("passes in silence when every required program starts, with or without zig", () => {
    for (const zig of [undefined, 0]) {
      const ran = workspace(zig === undefined ? {} : { zig })
      expect(ran.stderr).toBe("")
      expect(ran.stdout).toBe("")
      expect(ran.status).toBe(0)
    }
  })

  it("lets zig's probe fail: it has no build.zig, and fills the cache before it looks for one", () => {
    expect(workspace({ zig: 1 }).status).toBe(0)
  })

  it.each(
    [
      ["ci", "node packages/ci/bin/smithers-ci.mjs --help", "smithers-ci says why"],
      ["smthrs", "node_modules/.bin/smthrs --help", "smthrs says why"],
      ["dprint", "node_modules/.bin/dprint output-file-paths", "dprint says why"]
    ] as const
  )("fails with what %s printed when it fails", (name, command, why) => {
    const ran = workspace({ [name]: 7 })
    expect(ran.status).toBe(7)
    expect(ran.stderr).toContain(`toolCaches: ${command} failed (7)`)
    expect(ran.stderr).toContain(why)
  })

  it("starts nothing after the program that failed", () => {
    const ran = workspace({ smthrs: 3 })
    expect(ran.status).toBe(3)
    expect(ran.stderr).not.toContain("dprint")
  })
})
