import * as Effect from "effect/Effect"
import { constants } from "node:fs"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import * as Exec from "../src/Exec.ts"
import { PublicationFileSystem } from "../src/internal/PublicationFileSystem.ts"

let root: string
const retained: Array<string> = []
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "honest-generator-failures-")))
  await Fs.writeFile(join(root, "value"), "original")
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  for (const directory of retained.splice(0)) await Fs.rm(directory, { recursive: true, force: true })
})
const run = (program: string): Exec.Payload => ({
  cwd: ".",
  argv: [process.execPath, "-e", program],
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: 10000
})

it.each(["root-replaced", "snapshot-stat", "snapshot-open", "backup-inside"] as const)(
  "refuses unsafe snapshot acquisition before starting the generator: %s",
  async (fault) => {
    const io: typeof Fs = {
      ...Fs,
      lstat: async (...args) => {
        if (fault === "root-replaced" && args[0] === root) return Fs.lstat(join(root, "value"), args[1] as never)
        if (fault === "snapshot-stat" && args[0] === join(root, "value")) throw new Error("snapshot stat refused")
        return Fs.lstat(...args)
      },
      open: async (...args) => {
        if (fault === "snapshot-open" && args[0] === join(root, "value")) throw new Error("snapshot open refused")
        return Fs.open(...args)
      },
      mkdtemp: async (...args) =>
        fault === "backup-inside" ? Fs.mkdtemp(join(root, "backup-")) : Fs.mkdtemp(String(args[0]))
    } as typeof Fs
    const error = await Effect.runPromise(
      Effect.flip(Compose.checkGenerator({ workspaceRoot: root }, {
        changes: ["value"],
        run: run("require('node:fs').writeFileSync('started', 'yes')")
      })).pipe(Effect.provideService(PublicationFileSystem, io))
    )
    expect(error).toMatchObject({ reason: "unreadable" })
    if (!("message" in error)) throw new Error("expected a drift error")
    expect(error.message).toMatch(
      fault === "root-replaced"
        ? /root was replaced/
        : fault === "backup-inside"
        ? /backup must be outside/
        : /snapshot .* refused/
    )
    expect(await Fs.readdir(root)).toEqual(["value"])
  }
)

it("retains a recovery backup when restoration cannot open the destination", async () => {
  const io: typeof Fs = {
    ...Fs,
    open: async (...args) => {
      if (args[0] === join(root, "value") && (Number(args[1]) & constants.O_WRONLY) !== 0) {
        throw new Error("restore refused")
      }
      return Fs.open(...args)
    }
  }
  const error = await Effect.runPromise(
    Effect.flip(Compose.checkGenerator({ workspaceRoot: root }, {
      changes: ["value"],
      run: run("require('node:fs').writeFileSync('value', 'changed')")
    })).pipe(Effect.provideService(PublicationFileSystem, io))
  )
  if (!("message" in error)) throw new Error("expected a drift error")
  expect(error.message).toContain("backup retained at")
  const backup = error.message.split("backup retained at ")[1]!
  retained.push(backup)
  expect(await Fs.readdir(backup)).toContain("manifest.json")
})

it("reports directory permission drift and restores its original mode", async () => {
  await Fs.mkdir(join(root, "out"), { mode: 0o755 })
  const before = (await Fs.stat(join(root, "out"))).mode & 0o777
  const error = await Effect.runPromise(Effect.flip(Compose.checkGenerator({ workspaceRoot: root }, {
    changes: ["out"],
    run: run("require('node:fs').chmodSync('out', 0o700)")
  })))
  if (!("message" in error)) throw new Error("expected a drift error")
  expect(error.message).toContain("not readable as text")
  expect((await Fs.stat(join(root, "out"))).mode & 0o777).toBe(before)
})

it("allows a no-output generator check without inventing drift", async () => {
  await expect(Effect.runPromise(Compose.checkGenerator({ workspaceRoot: root }, { changes: [], run: run("void 0") })))
    .resolves.toBeUndefined()
  expect(await Fs.readFile(join(root, "value"), "utf8")).toBe("original")
})

it.each(["parent-absent", "parent-io", "fifo"] as const)(
  "handles an unrecoverable declared output before starting a generator: %s",
  async (fault) => {
    await Fs.mkdir(join(root, "nested"))
    await Fs.writeFile(join(root, "nested/value"), "original")
    if (fault === "fifo") {
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      await Fs.rm(join(root, "nested/value"))
      await promisify(execFile)("mkfifo", [join(root, "nested/value")])
    }
    const io: typeof Fs = {
      ...Fs,
      lstat: async (...args) => {
        if (args[0] === join(root, "nested") && fault !== "fifo") {
          throw Object.assign(new Error("parent unavailable"), { code: fault === "parent-absent" ? "ENOENT" : "EIO" })
        }
        return Fs.lstat(...args)
      }
    } as typeof Fs
    const effect = Compose.checkGenerator({ workspaceRoot: root }, {
      changes: ["nested/value"],
      run: run("require('node:fs').writeFileSync('started', 'yes')")
    }).pipe(Effect.provideService(PublicationFileSystem, io))
    if (fault === "parent-absent") {
      await Effect.runPromise(effect)
      expect(await Fs.readFile(join(root, "started"), "utf8")).toBe("yes")
    } else {
      const error = await Effect.runPromise(Effect.flip(effect))
      if (!("message" in error)) throw new Error("expected drift error")
      expect(error.message).toMatch(/parent unavailable|not recoverable/)
      expect(await Fs.readdir(root)).not.toContain("started")
    }
  }
)

it("refuses a declared output outside the workspace", async () => {
  const error = await Effect.runPromise(Effect.flip(Compose.checkGenerator({ workspaceRoot: root }, {
    changes: ["../escape"],
    run: run("throw new Error('must not run')")
  })))
  if (!("message" in error)) throw new Error("expected drift error")
  expect(error.message).toMatch(/escapes|workspace/)
})

it("bounds output directory depth before running a generator", async () => {
  const path = Array.from({ length: 257 }, () => "d").join("/")
  await Fs.mkdir(join(root, path), { recursive: true })
  const error = await Effect.runPromise(Effect.flip(Compose.checkGenerator({ workspaceRoot: root }, {
    changes: [path],
    run: run("require('node:fs').writeFileSync('started','yes')")
  })))
  if (!("message" in error)) throw new Error("expected drift error")
  expect(error.message).toContain("depth limit")
  expect(await Fs.readdir(root)).not.toContain("started")
})
it("retains recovery bytes when a parent disappears during file restoration", async () => {
  await Fs.mkdir(join(root, "nested"))
  await Fs.writeFile(join(root, "nested/value"), "original")
  const io: typeof Fs = {
    ...Fs,
    rm: async (...args) => {
      const result = await Fs.rm(...args)
      if (args[0] === join(root, "nested/value")) await Fs.rm(join(root, "nested"), { recursive: true, force: true })
      return result
    }
  }
  const error = await Effect.runPromise(
    Effect.flip(Compose.checkGenerator({ workspaceRoot: root }, {
      changes: ["nested/value"],
      run: run("require('node:fs').writeFileSync('nested/value','changed')")
    })).pipe(Effect.provideService(PublicationFileSystem, io))
  )
  if (!("message" in error)) throw new Error("expected drift error")
  expect(error.message).toContain("parent is missing during restore")
  const backup = error.message.split("backup retained at ")[1]!
  retained.push(backup)
  expect(await Fs.readFile(join(backup, "files/nested/value"), "utf8")).toBe("original")
})
it("rejects a wrong descriptor type while restoring a file mode", async () => {
  let opens = 0
  const io: typeof Fs = {
    ...Fs,
    open: async (...args) => {
      if (args[0] === join(root, "value") && ++opens === 4) return Fs.open(root, constants.O_RDONLY)
      return Fs.open(...args)
    }
  }
  const error = await Effect.runPromise(
    Effect.flip(Compose.checkGenerator({ workspaceRoot: root }, {
      changes: ["value"],
      run: run("require('node:fs').chmodSync('value',0o700)")
    })).pipe(Effect.provideService(PublicationFileSystem, io))
  )
  if (!("message" in error)) throw new Error("expected drift error")
  expect(error.message).toContain("changed while its mode was being restored")
  retained.push(error.message.split("backup retained at ")[1]!)
})
