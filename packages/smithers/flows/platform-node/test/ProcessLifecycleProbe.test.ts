import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import type * as Cleanup from "../src/internal/ProcessCleanup.ts"
import "../src/ProcessReaper.ts"

const captured = vi.hoisted(() => ({ system: undefined as Cleanup.System | undefined }))
vi.mock("../src/internal/ProcessCleanup.ts", () => ({
  lifecycle: (system: Cleanup.System) => {
    captured.system = system
    return () => undefined
  }
}))

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawnSync: vi.fn()
}))
afterEach(() => vi.restoreAllMocks())

const target = 4321
const start = "Sat Sep  5 12:00:00 2026"
const own = `${process.pid} 77 S ${start}`
const member = `${target} ${target} S ${start}`
const answer = (stdout: string, extra: Record<string, unknown> = {}) =>
  ({
    pid: 888,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
    ...extra
  }) as unknown as ReturnType<typeof spawnSync>

describe.skipIf(process.platform === "win32")("live process identity probe", () => {
  for (
    const [name, output] of [
      ["spawn error", answer("", { error: new Error("ENOENT") })],
      ["probe killed", answer("", { signal: "SIGKILL" })],
      ["probe failed", answer("", { status: 1 })],
      ["malformed row", answer(`${own}\ninvalid`)],
      ["unsafe pid", answer(`${own}\n999999999999999999 ${target} S ${start}`)],
      ["unsafe group", answer(`${own}\n${target} 999999999999999999 S ${start}`)],
      ["invalid start time", answer(`${own}\n${target} ${target} S unknown`)],
      ["missing own identity", answer(member)],
      ["invalid own group", answer(`${process.pid} 0 S ${start}\n${member}`)],
      ["empty table", answer("")]
    ] as const
  ) {
    it(`refuses an unanswered identity check: ${name}`, async () => {
      vi.mocked(spawnSync).mockReturnValue(output)
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
      expect(captured.system!.snapshot(target)).toBeUndefined()
      expect(kill).not.toHaveBeenCalled()
      expect(spawnSync).toHaveBeenCalledWith("/bin/ps", ["-A", "-o", "pid=,pgid=,stat=,lstart="], {
        encoding: "utf8",
        timeout: 2_000,
        killSignal: "SIGKILL",
        env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" }
      })
    })
  }

  it("reads the owner and all group identities without signalling", () => {
    vi.mocked(spawnSync).mockReturnValue(answer(`${own}\n${member}\n4322 ${target} Z ${start}`))
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    expect(captured.system!.snapshot(target)).toEqual({
      ownGroup: 77,
      members: [
        { pid: target, startedAtMs: Date.UTC(2026, 8, 5, 12), zombie: false },
        { pid: 4322, startedAtMs: Date.UTC(2026, 8, 5, 12), zombie: true }
      ]
    })
    expect(kill).not.toHaveBeenCalled()
  })
})
