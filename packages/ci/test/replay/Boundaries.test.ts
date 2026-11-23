import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { launcherEnvironment, searchPath, withEnvironment } from "../../src/replay/Environment.ts"
import { recordText } from "../../src/replay/Record.ts"
import { publicRemote } from "../../src/replay/Summary.vibe"

afterEach(() => vi.unstubAllEnvs())

describe("the launcher boundary", () => {
  it("hands workflow variables to env alongside the workload arguments", () => {
    const workload = { PATH: "/work/bin", LABEL: "two words", OPTIONAL: undefined }
    expect(withEnvironment(workload, ["tool", "--arg"])).toEqual([
      "/usr/bin/env",
      "-i",
      "--",
      "PATH=/work/bin",
      "LABEL=two words",
      "tool",
      "--arg"
    ])
    expect(launcherEnvironment).toEqual({ PATH: "/usr/bin:/bin" })
  })

  it("discovers only absolute directories when PATH is present", () => {
    vi.stubEnv("PATH", ".:/one::relative:/two")
    expect(searchPath()).toEqual(["/one", "/two"])
    vi.stubEnv("PATH", undefined)
    expect(searchPath()).toEqual([])
  })
})

describe("a disposable clone's public origin", () => {
  it("drops URL userinfo, queries and fragments while preserving local filenames", () => {
    expect(publicRemote("https://user@example.test/project?version=local#section")).toBe("https://example.test/project")
    expect(publicRemote("/local/project#1")).toBe("/local/project#1")
  })
})

describe("the run record reader", () => {
  it("bounds regular files, rejects links, and closes its handle on every path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "replay-record-"))
    const record = join(directory, "record")
    try {
      writeFileSync(record, "{}")
      expect(await recordText(record)).toBe("{}")
      expect(await recordText(record, 1)).toBeUndefined()
      expect(await recordText(directory)).toBeUndefined()
      if (process.platform === "linux") expect(await recordText("/proc/self/stat")).toBeUndefined()
      symlinkSync(record, join(directory, "alias"))
      await expect(recordText(join(directory, "alias"))).rejects.toThrow()
      linkSync(record, join(directory, "second"))
      expect(await recordText(record)).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
