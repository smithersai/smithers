import { isAlive, isGroupAlive, killGroup, waitFor } from "@smthrs/testing/Faults"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { probeEngineChild, reapEngineChildren, spawnEngineChild, waitForEngine } from "./engineChild.ts"
import { killResumeFixture } from "./killResumeCase.ts"
import { markers } from "./killResumeFlow.ts"

const fixture = killResumeFixture("child-protocol", 10)
afterAll(async () => {
  await reapEngineChildren()
  rmSync(fixture.directory, { recursive: true, force: true })
})

describe("the engine child-runner protocol", () => {
  it("admits itself with a probe that runs no flow", async () => {
    const child = spawnEngineChild({ ...fixture, executionId: "probe-1", mode: "probe" })
    expect(await child.exited, child.stdout() + child.stderr()).toBe(0)
    // The handshake names the phase and echoes the nonce this spawn minted, so
    // a long-lived process cannot pass admission by claiming a name.
    expect(child.stdout()).toContain(`SMITHERS_ENGINE_HANDSHAKE=probe:${child.nonce}`)
    expect(child.stdout()).toContain("PROBE_STATUS=ok")
    // A probe proves the runner boots the product and nothing else: no markers,
    // no counter lines, no execution.
    expect(fixture.counter()).toEqual([])
    expect(fixture.marker(markers.firstDone)).toBeUndefined()
  }, 120_000)

  it("uses a different handshake phase for an execution, so a probe cannot be replayed as one", async () => {
    const child = spawnEngineChild({ ...fixture, executionId: "execute-1", mode: "execute" })
    expect(await child.exited, child.stdout() + child.stderr()).toBe(0)
    expect(child.stdout()).toContain(`SMITHERS_ENGINE_HANDSHAKE=execute:${child.nonce}`)
    expect(child.stdout()).not.toContain("SMITHERS_ENGINE_HANDSHAKE=probe:")
    expect(child.stdout()).toContain("RESULT_STATUS=succeeded")
    // This time it really ran: both actions dispatched, both markers written.
    expect(fixture.counter()).toEqual(["first", "second"])
    expect(fixture.marker(markers.secondDone)).toBeDefined()
  }, 120_000)

  it("rejects a probe against an unusable database rather than reporting ok", async () => {
    await expect(
      probeEngineChild({ ...fixture, filename: "/dev/null/not-a-directory/run.sqlite", executionId: "probe-2" })
    ).rejects.toThrow(/admission probe failed/)
  }, 120_000)
})

describe("engine child ownership", () => {
  it("reaps a live engine and its contained group after a pre-kill assertion fails", async () => {
    const own = killResumeFixture("child-early-failure", 60_000)
    const child = spawnEngineChild({ ...own, mode: "execute" })
    let group = 0
    try {
      await child.handshake
      await waitForEngine(child, () => own.marker(markers.secondStarted) !== undefined, "the contained action", 60_000)
      group = Number(own.marker(markers.spawnedPid))
      expect(isAlive(child.pid)).toBe(true)
      expect(isGroupAlive(group)).toBe(true)
      await expect((async () => {
        try {
          throw new Error("assertion before deliberate kill")
        } finally {
          await reapEngineChildren()
        }
      })()).rejects.toThrow("assertion before deliberate kill")
      expect(isAlive(child.pid)).toBe(false)
      await waitFor(() => !isGroupAlive(group), "the contained group to exit")
      expect(await child.exited).toBeNull()
      await reapEngineChildren()
    } finally {
      child.process.kill("SIGKILL")
      killGroup(group)
      await reapEngineChildren()
      rmSync(own.directory, { recursive: true, force: true })
    }
  }, 120_000)

  it("bounds handshake and exit waits without losing ownership of the host", async () => {
    const own = killResumeFixture("child-deadline", 60_000)
    const child = spawnEngineChild({ ...own, mode: "execute", deadlineMs: 1 })
    try {
      await expect(child.handshake).rejects.toThrow(/timed out waiting for handshake/)
      await expect(child.exited).rejects.toThrow(/timed out waiting for exit/)
      await reapEngineChildren()
      expect(isAlive(child.pid)).toBe(false)
    } finally {
      child.process.kill("SIGKILL")
      await reapEngineChildren()
      rmSync(own.directory, { recursive: true, force: true })
    }
  })
})
