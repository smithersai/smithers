import * as NativeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Resolution from "../src/internal/NearestRealpath.ts"
import * as SafeFs from "../src/SafeFs.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "nearest-realpath-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const host: Resolution.Host = {
  realpath: NativeFs.realpathSync,
  dirname: Path.dirname,
  basename: Path.basename,
  resolve: Path.resolve,
  errorCode: SafeFs.errorCode
}

describe("nearest existing ancestor resolution", () => {
  it("preserves absent suffixes under a real resolved ancestor", async () => {
    const file = Path.join(root, "regular")
    await Fs.writeFile(file, "file")
    expect(Resolution.resolve(host, Path.join(file, "child"))).toBe(Path.join(file, "child"))
    expect(Resolution.resolve(host, Path.join(root, "missing/child"))).toBe(Path.join(root, "missing/child"))
  })

  it.runIf(process.platform !== "win32")("preserves a native symlink-loop refusal", async () => {
    const loop = Path.join(root, "loop")
    await Fs.symlink("loop", loop)
    expect(() => Resolution.resolve(host, Path.join(loop, "child"))).toThrow(/ELOOP/)
  })

  it.runIf(process.platform !== "win32")("stops at a missing Windows drive root using Windows path policy", () => {
    const windows = { ...host, dirname: Path.win32.dirname, basename: Path.win32.basename, resolve: Path.win32.resolve }
    expect(() => Resolution.resolve(windows, "Z:\\smithers-absent-drive-policy\\child")).toThrow(/ENOENT/)
  })
})
