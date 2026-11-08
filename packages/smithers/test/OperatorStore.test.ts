import { Effect } from "effect"
import { Cli } from "incur"
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"
import { createCredentialsCli } from "../src/operator/Credentials.ts"
import * as Store from "../src/operator/Store.vibe"
import * as Project from "../src/Project.ts"

const roots: Array<string> = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-operator-store-"))
  roots.push(root)
  return root
}
const modes = (root: string) => {
  const file = NodeControl.databasePath(root)
  return Object.fromEntries(
    [Project.stateDirectory(root), file, `${file}-wal`, `${file}-shm`]
      .filter(existsSync)
      .map((path) => [path, statSync(path).mode & 0o777])
  )
}

beforeEach(() => {
  vi.stubEnv("SMITHERS_REMOTE", undefined)
  vi.stubEnv("SMITHERS_CREDENTIAL_KEY", Buffer.alloc(32, 42).toString("base64"))
  vi.stubEnv("SMITHERS_OPERATOR_TEST_SECRET", "fixture-secret")
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("operator store permissions", () => {
  it("creates private state when credentials add is the first command under umask 022", async () => {
    const root = fixture()
    const previous = process.umask(0o022)
    let output = ""
    let code = 0
    try {
      expect(existsSync(Project.stateDirectory(root))).toBe(false)
      await Cli.create("smthrs").command(createCredentialsCli()).serve([
        "credentials",
        "add",
        "fixture",
        "--name",
        "Fixture",
        "--secret-env",
        "SMITHERS_OPERATOR_TEST_SECRET",
        "--root",
        root,
        "--json"
      ], {
        stdout: (value) => {
          output += value
        },
        exit: (value) => {
          code = value
        }
      })
      expect(code).toBe(0)
      expect(JSON.parse(output)).toEqual({ id: "fixture", name: "Fixture" })
      expect(modes(root)).toEqual({
        [Project.stateDirectory(root)]: 0o700,
        [NodeControl.databasePath(root)]: 0o600
      })
    } finally {
      process.umask(previous)
    }
  })

  it("hardens existing SQLite files while preserving the parent permissions", async () => {
    const root = fixture()
    const file = NodeControl.databasePath(root)
    const previous = process.umask(0o022)
    const inspect = Effect.sync(() => modes(root))
    try {
      await Effect.runPromise(inspect.pipe(Effect.provide(Store.databaseLayer(root))))
      chmodSync(Project.stateDirectory(root), 0o755)
      chmodSync(file, 0o644)
      expect(await Effect.runPromise(inspect.pipe(Effect.provide(Store.databaseLayer(root))))).toEqual({
        [Project.stateDirectory(root)]: 0o755,
        [file]: 0o600,
        [`${file}-wal`]: 0o600,
        [`${file}-shm`]: 0o600
      })
    } finally {
      process.umask(previous)
    }
  })
})
