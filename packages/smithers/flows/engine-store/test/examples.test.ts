import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { quickstart } from "../examples/quickstart.ts"

describe("examples", () => {
  const directories: Array<string> = []
  const scratch = () => {
    const directory = mkdtempSync(join(tmpdir(), "engine-store-quickstart-"))
    directories.push(directory)
    const root = join(directory, ".quickstart")
    return { filename: join(root, ".flows", "engine.db"), root }
  }

  // The quickstart is a SQLite program; an operator's PostgreSQL settings
  // must not redirect it to a shared server.
  beforeEach(() => {
    vi.stubEnv("SMITHERS_BACKEND", "sqlite")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it("quickstart runs the sealed step once and replays it on a second engine", async () => {
    const { filename, root } = scratch()
    expect(existsSync(root)).toBe(false)
    expect(await quickstart(filename, root)).toEqual({ first: "42", second: "42", executions: 1 })
    expect(existsSync(filename)).toBe(true)
  })

  it("quickstart over a file that already holds the attempt replays on both engines", async () => {
    const { filename, root } = scratch()
    await quickstart(filename, root)
    expect(await quickstart(filename, root)).toEqual({ first: "42", second: "42", executions: 0 })
  })

  it("the documented TypeScript blocks run in a fresh directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "engine-store-docs-"))
    directories.push(directory)
    const markdown = readFileSync(new URL("../docs/quickstart.md", import.meta.url), "utf8")
    const source = [...markdown.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((match) => match[1]).join("\n")
    const script = join(directory, "quickstart.ts")
    writeFileSync(script, source)
    const require = createRequire(import.meta.url)
    const packages = new Set([...source.matchAll(/from "([^"]+)"/g)].map((match) => {
      const parts = match[1]!.split("/")
      return parts.slice(0, match[1]!.startsWith("@") ? 2 : 1).join("/")
    }))
    for (const name of packages) {
      const destination = join(directory, "node_modules", name)
      mkdirSync(dirname(destination), { recursive: true })
      symlinkSync(dirname(require.resolve(`${name}/package.json`)), destination, "dir")
    }
    const result = spawnSync(process.execPath, [
      "--import",
      createRequire(import.meta.url).resolve("vibelang/register"),
      script
    ], {
      cwd: directory,
      env: { PATH: process.env.PATH, SMITHERS_BACKEND: "sqlite" },
      encoding: "utf8",
      timeout: 45_000
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain("{ first: '42', second: '42', executions: 1 }")
    expect(existsSync(join(directory, ".quickstart/.flows/engine.db"))).toBe(true)
  })
})
