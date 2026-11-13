import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { psGroupSnapshot } from "../src/internal/PsSnapshot.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"

const target = 4321
const start = "Sat Sep  5 12:00:00 2026"
const own = process.pid + " 77 S " + start
const member = target + " " + target + " S " + start

describe.skipIf(process.platform === "win32")("live process identity probe", () => {
  it("selects the kernel reader only on Linux", () => {
    expect(ProcessReaper.groupSnapshotFor("darwin")).toBe(ProcessReaper.groupSnapshotFor("freebsd"))
    expect(ProcessReaper.groupSnapshotFor("linux")).not.toBe(ProcessReaper.groupSnapshotFor("darwin"))
    expect(ProcessReaper.groupSnapshotFor(process.platform)(process.pid)).toBeDefined()
  })

  for (
    const [name, text, status] of [
      ["probe failed", "", 1],
      ["malformed row", own + "\ninvalid", 0],
      ["unsafe pid", own + "\n999999999999999999 " + target + " S " + start, 0],
      ["unsafe group", own + "\n" + target + " 999999999999999999 S " + start, 0],
      ["invalid start time", own + "\n" + target + " " + target + " S unknown", 0],
      ["missing own identity", member, 0],
      ["invalid own group", process.pid + " 0 S " + start + "\n" + member, 0],
      ["empty table", "", 0]
    ] as const
  ) {
    it("refuses an unanswered identity check: " + name, () => {
      withProbe(text, status, (executable) => expect(psGroupSnapshot(executable)(target)).toBeUndefined())
    })
  }

  it("refuses an executable that is missing or killed", () => {
    expect(psGroupSnapshot(join(tmpdir(), "missing-smithers-probe", "ps"))(target)).toBeUndefined()
    withProbe("", 0, (executable) => {
      writeFileSync(executable, "#!/bin/sh\nkill -KILL $$\n", { mode: 0o755 })
      expect(psGroupSnapshot(executable)(target)).toBeUndefined()
    })
  })

  it("reads group identities through the configured executable with the pinned environment", () => {
    withProbe(own + "\n" + member + "\n4322 " + target + " Z " + start, 0, (executable) => {
      expect(psGroupSnapshot(executable)(target)).toEqual({
        ownGroup: 77,
        members: [
          { pid: target, startedAtMs: Date.UTC(2026, 8, 5, 12), zombie: false },
          { pid: 4322, startedAtMs: Date.UTC(2026, 8, 5, 12), zombie: true }
        ]
      })
      const request = JSON.parse(readFileSync(executable + ".request", "utf8"))
      delete request.env.__CF_USER_TEXT_ENCODING
      expect(request).toEqual({
        args: ["-A", "-o", "pid=,pgid=,stat=,lstart="],
        env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" }
      })
    })
  })
})

/** A real fixed-path process with a controlled reply, never a PATH substitution. */
const withProbe = (stdout: string, status: number, use: (executable: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), "process-probe-"))
  const executable = join(directory, "ps")
  try {
    writeFileSync(
      executable,
      "#!" + process.execPath + "\n" +
        "const fs = require(\"node:fs\");" +
        "fs.writeFileSync(__filename + \".request\", JSON.stringify({ args: process.argv.slice(2), env: process.env }));" +
        "process.stdout.write(" + JSON.stringify(stdout) + ");" +
        "process.exitCode = " + status + ";\n",
      { mode: 0o755 }
    )
    use(executable)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
