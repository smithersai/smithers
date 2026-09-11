import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPtyManager } from "./Pty"
import type { PtyManager, PtyManagerOptions } from "./Pty"

let root = ""
const owners: PtyManager[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "smithers-pty-lifetime-"))
})
afterEach(async () => {
  const results = await Promise.allSettled(owners.splice(0).map((owner) => owner.dispose()))
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
  if (errors.length > 0) {
    throw new AggregateError(errors, "PTY fixtures did not stop; their owned directory was retained.")
  }
  await rm(root, { recursive: true, force: true })
})
const manager = (overrides: Partial<PtyManagerOptions> = {}) => {
  const owner = createPtyManager({
    home: root,
    env: {},
    shell: "/bin/sh",
    harnesses: async () => [],
    publish: () => {},
    sandboxHost: { platform: "linux", disabled: true, log: () => {} },
    killGraceMs: 100,
    log: () => {},
    ...overrides
  })
  owners.push(owner)
  return owner
}
const input = () => ({ kind: "terminal", cwd: root, cols: 80, rows: 24 } as const)

describe("PTY admission and manager lifetime", () => {
  test("in-flight preparation reserves capacity before the first await", async () => {
    const gate = Promise.withResolvers<ReadonlyArray<string>>()
    const owner = manager({ maxSessions: 1, pathPrepend: () => gate.promise })
    const first = owner.create(input())
    const second = owner.create(input())
    gate.resolve([])
    const results = await Promise.all([first, second])
    expect(results.filter((result) => result.status === "ok")).toHaveLength(1)
    expect(results.filter((result) => result.status === "error")).toEqual([
      expect.objectContaining({ code: "capacity_reached" })
    ])
    expect(owner.list()).toHaveLength(1)
  })

  test("transferring a reservation to a child never counts the same launch twice", async () => {
    const owner = manager({ maxSessions: 2 })
    const results = await Promise.all([owner.create(input()), owner.create(input())])
    expect(results.every((result) => result.status === "ok")).toBe(true)
    expect(owner.list()).toHaveLength(2)
  })

  test("dispose closes admission and a never-answering setup cannot keep it pending", async () => {
    const gate = Promise.withResolvers<ReadonlyArray<string>>()
    const owner = manager({ pathPrepend: () => gate.promise })
    const creating = owner.create(input())
    const disposal = owner.dispose()
    expect(owner.dispose()).toBe(disposal)
    await disposal
    expect(await creating).toMatchObject({ status: "error", code: "manager_closed" })
    expect(await owner.create(input())).toMatchObject({ status: "error", code: "manager_closed" })
    gate.resolve([])
    await Bun.sleep(10)
    expect(owner.list()).toEqual([])
  })

  test("late role resolution after dispose cannot even start harness detection", async () => {
    const roles = Promise.withResolvers<ReadonlyArray<never>>()
    let reads = 0
    const owner = manager({
      roles: () => roles.promise,
      harnesses: async () => {
        reads += 1
        return []
      }
    })
    const creating = owner.create({ ...input(), kind: "harness", roleId: "implementation" })
    await owner.dispose()
    expect(await creating).toMatchObject({ status: "error", code: "manager_closed" })
    roles.resolve([])
    await Bun.sleep(10)
    expect(reads).toBe(0)
    expect(owner.list()).toEqual([])
  })

  test("setup failure releases its reservation", async () => {
    let calls = 0
    const owner = manager({
      maxSessions: 1,
      pathPrepend: async () => {
        if (calls++ === 0) throw new Error("setup failed")
        return []
      }
    })
    await expect(owner.create(input())).rejects.toThrow("setup failed")
    expect((await owner.create(input())).status).toBe("ok")
  })

  test("a closing child still occupies capacity until it has exited", async () => {
    let output = ""
    const owner = manager({
      maxSessions: 1,
      killGraceMs: 150,
      publish: (_topic, message) => {
        const frame = message as { type: string; data?: string }
        if (frame.type === "pty.output") output += frame.data ?? ""
      }
    })
    const started = await owner.create(input())
    if (started.status !== "ok") throw new Error(started.message)
    // dash can print its initial prompt immediately before the first command's
    // output. Delimit the acknowledgement ourselves, without accepting the
    // terminal's echo of the input as proof that the HUP trap was installed.
    expect(owner.write(started.session.sessionId, "trap '' HUP; printf '\\n%s\\n' ready-for-kill\n")).toBe(true)
    const deadline = Date.now() + 2000
    while (!/(?:^|\r?\n)ready-for-kill\r?\n/.test(output)) {
      if (Date.now() > deadline) throw new Error(`fixture shell did not become ready: ${JSON.stringify(output)}`)
      await Bun.sleep(5)
    }
    const closing = owner.kill(started.session.sessionId)
    expect(owner.get(started.session.sessionId)).toBeUndefined()
    expect(() => process.kill(started.session.pid, 0)).not.toThrow()
    expect(await owner.create(input())).toMatchObject({ status: "error", code: "capacity_reached" })
    await closing
    expect((await owner.create(input())).status).toBe("ok")
  })

  test("observer failures cannot strand a successfully spawned child or its capacity", async () => {
    const owner = manager({
      maxSessions: 1,
      publish: () => {
        throw new Error("observer failed")
      },
      log: () => {
        throw new Error("logger failed")
      }
    })
    const first = await owner.create(input())
    if (first.status !== "ok") throw new Error(first.message)
    expect(await owner.kill(first.session.sessionId)).toBe(true)
    expect((await owner.create(input())).status).toBe("ok")
  })

  test("invalid capacities fail as configuration errors and zero explicitly disables admission", async () => {
    for (const maxSessions of [-1, 0.5, NaN, Infinity]) {
      expect(() => manager({ maxSessions })).toThrow("maxSessions")
    }
    expect(await manager({ maxSessions: 0 }).create(input())).toMatchObject({
      status: "error",
      code: "capacity_reached"
    })
  })
})
