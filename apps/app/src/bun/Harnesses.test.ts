import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { currentHarnessHost, wrapProbe } from "./Harnesses"
import { SANDBOX_EXEC } from "./Sandbox"
import type { SandboxHost } from "./Sandbox"

/*
 * The table itself lives in @smthrs/harness-detect and is asserted there over
 * fixtures. What is left here is the half that touches this machine: the
 * seatbelt wrapper around a probe, and the host's own filesystem reads.
 */

const seatbelt: SandboxHost = { platform: "darwin", disabled: false, log: () => {} }
const unenforced: SandboxHost = { platform: "linux", disabled: true, log: () => {} }

describe("wrapProbe", () => {
  test("runs a version probe under the probe profile", () => {
    const argv = wrapProbe(["/opt/homebrew/bin/claude", "--version"], seatbelt)
    expect(argv[0]).toBe(SANDBOX_EXEC)
    expect(argv[1]).toBe("-p")
    // The probe policy: no network, and writes confined to scratch.
    expect(argv[2]).toContain("(deny network*)")
    expect(argv.slice(-2)).toEqual(["/opt/homebrew/bin/claude", "--version"])
  })

  test("excepts the probes the profile is known to break", () => {
    // amp writes under ~/.cache on every invocation; `opencode models` opens its own log.
    expect(wrapProbe(["/usr/local/bin/amp", "--version"], seatbelt)).toEqual(["/usr/local/bin/amp", "--version"])
    expect(wrapProbe(["/Users/u/.opencode/bin/opencode", "models"], seatbelt))
      .toEqual(["/Users/u/.opencode/bin/opencode", "models"])
    // The exception is per subcommand: opencode --version stays sandboxed.
    expect(wrapProbe(["/Users/u/.opencode/bin/opencode", "--version"], seatbelt)[0]).toBe(SANDBOX_EXEC)
  })

  test("passes the argv through where seatbelt does not apply", () => {
    expect(wrapProbe(["/usr/bin/codex", "--version"], unenforced)).toEqual(["/usr/bin/codex", "--version"])
    expect(wrapProbe([], unenforced)).toEqual([])
  })
})

describe("currentHarnessHost", () => {
  test("reads this process's environment and home", () => {
    const host = currentHarnessHost({ HOME: "/Users/fixture", PATH: "/usr/bin" })
    expect(host.home).toBe("/Users/fixture")
    expect(host.env.PATH).toBe("/usr/bin")
    expect(host.platform).toBe(process.platform)
    expect(currentHarnessHost({}).home).toBe(homedir())
  })

  test("reads real files and answers null or [] for what is not there", () => {
    const host = currentHarnessHost({ HOME: homedir() })
    expect(host.isFile(import.meta.path)).toBe(true)
    expect(host.isFile(import.meta.dir)).toBe(false)
    expect(host.isFile("/no/such/path")).toBe(false)
    expect(host.readText(import.meta.path)).toBe(readFileSync(import.meta.path, "utf8"))
    expect(host.readText("/no/such/path")).toBeNull()
    expect(host.listDir(import.meta.dir)).toContain("Harnesses.ts")
    expect(host.listDir("/no/such/dir")).toEqual([])
  })

  test("a probe of a binary that is not there resolves null rather than throwing", async () => {
    expect(await currentHarnessHost({}).version("/no/such/binary")).toBeNull()
  })
})
