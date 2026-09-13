import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPtyManager, PTY_EXITED_RETENTION, PTY_SCROLLBACK_BYTES, type PtyManager } from "./Pty"
const managers: PtyManager[] = []
const directories: string[] = []
const until = async (check: () => boolean) => {
  const end = Date.now() + 5000
  while (!check()) { if (Date.now() > end) throw new Error("PTY output timeout"); await Bun.sleep(5) }
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "smithers-replay-"))
  directories.push(home)
  const frames: { type: string; data?: string; start?: number; cursor?: number }[] = []
  const manager = createPtyManager({ home, env: {}, shell: "/bin/sh", harnesses: async () => [],
    sandboxHost: { platform: "linux", disabled: true, log: () => {} },
    publish: (_topic, frame) => frames.push(frame as never), log: () => {} })
  managers.push(manager)
  const input = { kind: "terminal", cwd: home, cols: 80, rows: 24 } as const
  return { manager, input, frames }
}
test("replay preserves ANSI/Unicode, resumes by cursor, and explicitly reports retention gaps", async () => {
  const { manager, input, frames } = await fixture()
  const created = await manager.create(input)
  if (created.status !== "ok") throw new Error(created.message)
  const id = created.session.sessionId
  manager.write(id, "stty -echo; printf '\\033[31mfirst-😀\\033[0m\\n'\n")
  await until(() => manager.replay(id)?.data.includes("\x1b[31mfirst-😀\x1b[0m") === true)
  const first = manager.replay(id)!
  expect(first.data).toContain("\x1b[31mfirst-😀\x1b[0m")
  expect(first.truncated).toBe(false)
  manager.write(id, "printf 'second-😀\\n'\n")
  await until(() => manager.read(id)?.output.includes("second-😀") === true)
  const next = manager.replay(id, first.cursor)!
  expect(next.data).toContain("second-😀")
  expect(next.data).not.toContain("first-😀")
  expect(next.start).toBe(first.cursor)
  manager.write(id, "i=0; while [ \"$i\" -lt 18000 ]; do printf '😀'; i=$((i+1)); done; printf '\\nfinished\\n'; exit 17\n")
  await until(() => manager.get(id)?.alive === false)
  const retained = manager.replay(id, 0)!
  expect(retained.truncated).toBe(true)
  expect(retained.start).toBeGreaterThan(0)
  expect(Buffer.byteLength(retained.data)).toBeLessThanOrEqual(PTY_SCROLLBACK_BYTES)
  expect(retained.data).not.toContain("�")
  expect(retained.data).toContain("finished")
  expect(retained).toMatchObject({ alive: false, code: 17 })
  expect(retained.cursor).toBe(frames.reduce((cursor, frame) => cursor + (frame.data?.length ?? 0), 0))
  expect(manager.replay(id, retained.cursor)?.data).toBe("")
  for (const cursor of [-1, 1.5, Infinity]) expect(() => manager.replay(id, cursor)).toThrow("cursor")
  expect(manager.replay("missing")).toBeUndefined()
})
test("a long-lived owner bounds exited session records without removing live sessions", async () => {
  const { manager, input } = await fixture()
  const live = await manager.create(input)
  if (live.status !== "ok") throw new Error(live.message)
  const completed: string[] = []
  for (let i = 0; i < PTY_EXITED_RETENTION + 2; i++) {
    const created = await manager.create(input)
    if (created.status !== "ok") throw new Error(created.message)
    completed.push(created.session.sessionId)
    manager.write(created.session.sessionId, "exit 0\n")
    await until(() => manager.get(created.session.sessionId)?.alive === false)
  }
  expect(manager.list()).toHaveLength(PTY_EXITED_RETENTION + 1)
  expect(manager.get(live.session.sessionId)?.alive).toBe(true)
  expect(manager.get(completed[0]!)).toBeUndefined()
})
