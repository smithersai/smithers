import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const script = resolve(import.meta.dir, "build-native.ts")
const pnpmPin = (JSON.parse(readFileSync(resolve(import.meta.dir, "..", "..", "..", "package.json"), "utf8")) as {
  packageManager: string
}).packageManager
let root = ""

const compile = (argv: ReadonlyArray<string>): void => {
  const result = Bun.spawnSync(["cc", ...argv], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

// A Mach-O "node" that reports a supported release, beside an executable
// pnpm that reports the pinned release, so the build reaches its Node checks.
const fakeNode = (name: string, foreignLibrary?: string): string => {
  const bin = join(root, name, "bin")
  mkdirSync(bin, { recursive: true })
  const source = join(root, name, "node.c")
  writeFileSync(
    source,
    foreignLibrary === undefined
      ? `#include <stdio.h>\nint main(void) { puts("v26.4.0"); return 0; }\n`
      : `#include <stdio.h>\nint foreign(void);\nint main(void) { puts("v26.4.0"); return foreign(); }\n`
  )
  compile(["-o", join(bin, "node"), source, ...(foreignLibrary === undefined ? [] : [foreignLibrary])])
  const pnpm = join(bin, "pnpm")
  writeFileSync(pnpm, `#!/bin/sh\necho ${pnpmPin.slice("pnpm@".length)}\n`)
  chmodSync(pnpm, 0o755)
  return join(bin, "node")
}

const build = (node: string): { exitCode: number; stderr: string } => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("SMITHERS_")) env[name] = value
  }
  const result = Bun.spawnSync(["bun", script], {
    env: { ...env, SMITHERS_BUILD_SHA: "0".repeat(40), SMITHERS_NODE_BINARY: node },
    stdout: "pipe",
    stderr: "pipe"
  })
  return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "smithers-build-native-"))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

test.skipIf(process.platform !== "darwin")("refuses a Node runtime that loads a library outside macOS", () => {
  const library = join(root, "lib", "libforeign")
  mkdirSync(join(root, "lib"), { recursive: true })
  writeFileSync(join(root, "lib", "foreign.c"), "int foreign(void) { return 0; }\n")
  compile(["-dynamiclib", "-install_name", library, "-o", library, join(root, "lib", "foreign.c")])

  const result = build(fakeNode("homebrew", library))

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain(`loads ${library}`)
})

test.skipIf(process.platform !== "darwin")("accepts a Node runtime that loads only macOS system libraries", () => {
  const result = build(fakeNode("official"))

  // The build passes the linkage gate and stops at the next check: the
  // fixture ships no Node license.
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).not.toContain(" loads ")
  expect(result.stderr).toContain("Node license is unavailable")
})
