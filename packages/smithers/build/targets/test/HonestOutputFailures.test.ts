import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import * as Generated from "../src/GeneratedFile.ts"
import * as Scaffold from "../src/NewPackage.ts"
import * as ToolBuild from "../src/ToolBuild.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "honest-output-failures-")))
  await Fs.mkdir(join(root, "out"))
  await Fs.writeFile(join(root, "out/value"), "original")
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const io = ToolBuild.defaultCaptureIo

it("refuses a listed child that disappears before capture", async () => {
  const faulty: ToolBuild.CaptureIo = {
    ...io,
    lstat: async (path) => {
      if (path === join(root, "out/value")) throw Object.assign(new Error("disappeared"), { code: "ENOENT" })
      return io.lstat(path)
    }
  }
  await expect(ToolBuild.measureOutput(root, ".", "out", { io: faulty })).rejects.toThrow(/entry was replaced/)
  expect(await Fs.readFile(join(root, "out/value"), "utf8")).toBe("original")
})

it("refuses a directory that disappears after its contents were read", async () => {
  let directoryReads = 0
  const faulty: ToolBuild.CaptureIo = {
    ...io,
    lstat: async (path) => {
      if (path === join(root, "out") && ++directoryReads >= 3) {
        throw Object.assign(new Error("directory disappeared"), { code: "ENOENT" })
      }
      return io.lstat(path)
    }
  }
  await expect(ToolBuild.measureOutput(root, ".", "out", { io: faulty })).rejects.toThrow(/directory was replaced/)
  expect(await Fs.readFile(join(root, "out/value"), "utf8")).toBe("original")
})

it.each(["missing", "outside"] as const)("refuses output realpath resolution that becomes %s", async (fault) => {
  const faulty: ToolBuild.CaptureIo = {
    ...io,
    realpath: async (path) => {
      if (path === join(root, "out")) {
        if (fault === "missing") throw new Error("no longer resolvable")
        return tmpdir()
      }
      return io.realpath(path)
    }
  }
  await expect(ToolBuild.measureOutput(root, ".", "out", { io: faulty })).rejects.toThrow(/resolves outside/)
})

it("refuses a cache whose realpath escapes the workspace", async () => {
  await Fs.mkdir(join(root, "cache"))
  const faulty: ToolBuild.CaptureIo = {
    ...io,
    realpath: (path) => path === join(root, "cache") ? Promise.resolve(tmpdir()) : io.realpath(path)
  }
  await expect(ToolBuild.measureOutput(root, ".", "out", { io: faulty, cacheDirectory: "cache" })).rejects.toThrow(
    /cache directory resolves outside/
  )
})

it("tolerates an absent optional cache while measuring an output", async () => {
  const report = await ToolBuild.measureOutput(root, ".", "out", { cacheDirectory: "missing-cache" })
  expect(report).toMatchObject({ path: "out", fileCount: 1 })
})

it("reports scaffold publication failure and removes its private temporary directory", async () => {
  const result = await Effect.runPromise(Effect.flip(Scaffold.scaffold({
    workspaceRoot: root,
    packageName: "created",
    io: {
      rename: async () => {
        throw new Error("publication refused")
      }
    }
  }, { directory: "packages", version: "1.0.0", license: "MIT", fields: {} })))
  expect(result.message).toContain("publication refused")
  expect(await Fs.readdir(join(root, "packages"))).toEqual([])
})

it("refuses output capture that was cancelled before it started", async () => {
  const signal = AbortSignal.abort()
  await expect(ToolBuild.measureOutput(root, ".", "out", { signal })).rejects.toThrow(/cancelled/)
  await expect(ToolBuild.measureOutputs(root, ".", ["out"], { signal })).rejects.toThrow(/cancelled/)
})

it("refuses a symbolic link declared as the output itself", async () => {
  await Fs.symlink(join(root, "out/value"), join(root, "alias"))
  await expect(ToolBuild.measureOutput(root, ".", "alias")).rejects.toThrow(/symbolic link/)
})

it("rejects malformed output manifests before checking filesystem content", async () => {
  expect(ToolBuild.readOutputManifest({ cwd: ".", paths: ["out"] }, new Date())).toMatch(/manifest/)
  const output = { path: "out", fileCount: 1, contentDigest: "a".repeat(64) }
  expect(
    ToolBuild.readOutputManifest({ cwd: ".", paths: ["out"] }, { outputs: Object.assign([output], { extra: true }) })
  ).toMatch(/manifest/)
  const duplicate = { path: "a", fileCount: 0, contentDigest: "a".repeat(64) }
  expect(ToolBuild.readOutputManifest({ cwd: ".", paths: ["a", "a"] }, { outputs: [duplicate, duplicate] })).toMatch(
    /twice/
  )
  expect(await ToolBuild.verifyOutputs(root, { cwd: "..", paths: ["out"] }, {})).toMatch(/cwd|workspace/)
  expect(await ToolBuild.verifyOutputs(root, { cwd: ".", paths: ["out"] }, new Date())).toMatch(/manifest/)
})

it("tolerates another cleanup removing a stale scaffold before its lstat", async () => {
  const packages = join(root, "packages")
  await Fs.mkdir(packages)
  const stale = [join(packages, ".smthrs-scaffold-a.tmp"), join(packages, ".smthrs-scaffold-b.tmp")]
  for (const directory of stale) {
    await Fs.mkdir(directory)
    await Fs.utimes(directory, new Date(0), new Date(0))
  }
  const report = await Effect.runPromise(Scaffold.scaffold({
    workspaceRoot: root,
    packageName: "created",
    io: {
      remove: async () => {
        for (const directory of stale) await Fs.rm(directory, { recursive: true, force: true })
      }
    }
  }, { directory: "packages", version: "1.0.0", license: "MIT", fields: {} }))
  expect(report.directory).toBe("packages/created")
  expect(await Fs.readdir(packages)).toEqual(["created"])
})

it("does not report a successful digest when a host read rejects with undefined", async () => {
  let closed = 0
  const faulty: ToolBuild.CaptureIo = {
    ...io,
    openFile: async (path) => {
      const file = await io.openFile(path)
      return {
        ...file,
        read: async () => {
          throw undefined
        },
        close: async () => {
          await file.close()
          closed++
        }
      }
    }
  }
  await expect(ToolBuild.measureOutput(root, ".", "out/value", { io: faulty })).rejects.toThrow(/could not be digested/)
  expect(closed).toBe(1)
  expect(await Fs.readFile(join(root, "out/value"), "utf8")).toBe("original")
})

it.each(["parent-stat", "parent-mkdir", "destination-stat"] as const)(
  "reports real permission failures while scaffolding: %s",
  async (fault) => {
    const parent = join(root, "restricted")
    await Fs.mkdir(parent)
    await Fs.chmod(parent, fault === "parent-mkdir" ? 0o500 : 0)
    try {
      const error = await Effect.runPromise(Effect.flip(Scaffold.scaffold({
        workspaceRoot: root,
        packageName: "created"
      }, {
        directory: fault === "destination-stat" ? "restricted" : "restricted/child",
        version: "1.0.0",
        license: "MIT",
        fields: {}
      })))
      expect(error.message).toMatch(/EACCES|permission denied/)
    } finally {
      await Fs.chmod(parent, 0o700)
    }
    expect(await Fs.readdir(parent)).toEqual([])
  }
)
it("does not overwrite a destination created while scaffold files are being written", async () => {
  await Fs.mkdir(join(root, "packages"))
  let raced = false
  const error = await Effect.runPromise(Effect.flip(Scaffold.scaffold({
    workspaceRoot: root,
    packageName: "created",
    io: {
      writeFile: async (workspace, file, signal) => {
        await Effect.runPromise(Generated.writeGeneratedFile(workspace, file), { signal })
        if (!raced) {
          raced = true
          await Fs.mkdir(join(root, "packages/created"))
          await Fs.writeFile(join(root, "packages/created/peer"), "kept")
        }
      }
    }
  }, { directory: "packages", version: "1.0.0", license: "MIT", fields: {} })))
  expect(error.message).toContain("already exists")
  expect(await Fs.readdir(join(root, "packages"))).toEqual(["created"])
  expect(await Fs.readFile(join(root, "packages/created/peer"), "utf8")).toBe("kept")
})
it("refuses a FIFO included in a declared output tree", async () => {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  await promisify(execFile)("mkfifo", [join(root, "out/pipe")])
  await expect(ToolBuild.measureOutput(root, ".", "out")).rejects.toThrow(/not a file or a directory/)
})

it("keeps unrelated parent entries while reclaiming scaffold temporaries", async () => {
  await Fs.mkdir(join(root, "packages"))
  await Fs.writeFile(join(root, "packages/keep"), "unrelated")
  const report = await Effect.runPromise(
    Scaffold.scaffold({ workspaceRoot: root, packageName: "created" }, {
      directory: "packages",
      version: "1.0.0",
      license: "MIT",
      fields: {}
    })
  )
  expect(report.directory).toBe("packages/created")
  expect(await Fs.readFile(join(root, "packages/keep"), "utf8")).toBe("unrelated")
})

it("captures the same real output through a host exposing numeric rather than bigint stats", async () => {
  const numeric: ToolBuild.CaptureIo = {
    ...io,
    lstat: (path) => Fs.lstat(path),
    openFile: async (path) => {
      const handle = await Fs.open(path, "r")
      return {
        stat: () => handle.stat(),
        read: async (into) => (await handle.read(into, 0, into.length, null)).bytesRead,
        close: () => handle.close()
      }
    }
  }
  expect(await ToolBuild.measureOutput(root, ".", "out", { io: numeric })).toEqual(
    await ToolBuild.measureOutput(root, ".", "out")
  )
})
it.each(
  [
    ["size", -1n],
    ["size", -1],
    ["mtimeNs", -1n],
    ["ctimeNs", -1n],
    ["mtimeMs", NaN],
    ["ctimeMs", NaN],
    ["mtimeMs", "invalid"],
    ["ctimeMs", -1]
  ] as const
)("rejects unusable host %s metadata without returning a successful manifest", async (field, value) => {
  const faulty: ToolBuild.CaptureIo = {
    ...io,
    openFile: async (path) => {
      const file = await io.openFile(path)
      return {
        ...file,
        stat: async () => {
          const stats = field.endsWith("Ns") || typeof value === "bigint"
            ? await Fs.lstat(path, { bigint: true })
            : await Fs.lstat(path)
          return Object.assign(stats, { [field]: value })
        }
      }
    }
  }
  await expect(ToolBuild.measureOutput(root, ".", "out", { io: faulty })).rejects.toBeInstanceOf(ToolBuild.OutputError)
  expect(await Fs.readFile(join(root, "out/value"), "utf8")).toBe("original")
})
