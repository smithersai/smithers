import * as Fs from "node:fs"
import { findPackageJSON } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "vitest"
import { markStart, reaperPath, supervisorPath, unsupervised } from "../src/internal/ObservedReads.ts"

test("reports an installation without a supervisor and leaves reaping unavailable", () => {
  const dir = Fs.mkdtempSync(join(tmpdir(), "observed-installation-"))
  try {
    const manifest = join(dir, "package.json")
    const entry = join(dir, "entry.mjs")
    Fs.writeFileSync(manifest, "{\"name\":\"@smthrs/build-cli\",\"exports\":\"./entry.mjs\"}")
    Fs.writeFileSync(entry, "")
    const moduleUrl = pathToFileURL(entry).href

    expect(findPackageJSON("@smthrs/build-cli", moduleUrl)).toBe(manifest)
    expect(findPackageJSON(moduleUrl, moduleUrl)).toBe(manifest)
    expect(supervisorPath("linux", "x64", {}, moduleUrl)).toBeUndefined()
    expect(unsupervised("linux", "x64", {}, moduleUrl)).toBe(
      "this installation of @smthrs/build-cli holds no smthrs-observe for linux-x64"
    )
    expect(reaperPath(undefined, moduleUrl)).toBeUndefined()

    // An incomplete installation can also lack the CLI entry itself.
    const missingEntry = pathToFileURL(join(dir, "missing.mjs")).href
    expect(() => findPackageJSON(missingEntry, missingEntry)).toThrow(expect.objectContaining({
      code: "ERR_MODULE_NOT_FOUND"
    }))
    expect(supervisorPath("linux", "x64", {}, missingEntry)).toBeUndefined()
  } finally {
    Fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("waits for the next tick of a coarse filesystem clock while alternating the marker contents", () => {
  const dir = Fs.mkdtempSync(join(tmpdir(), "observed-marker-"))
  try {
    const file = join(dir, "start")
    const times = [1_000, 1_000, 1_000, 2_000]
    const writes: Array<string> = []
    const started = markStart(file, times.length - 1, (path) => {
      writes.push(Fs.readFileSync(path, "utf8"))
      return times[writes.length - 1]!
    })

    expect(writes).toEqual(["", "\n", "", "\n"])
    expect(started).toBe(2_000)
  } finally {
    Fs.rmSync(dir, { recursive: true, force: true })
  }
})
