import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPtyManager, PTY_SCROLLBACK_BYTES } from "./Pty"
import type { PtyManager } from "./Pty"

let root = ""
const owners: PtyManager[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "smithers-pty-unicode-"))
})
afterEach(async () => {
  const results = await Promise.allSettled(owners.splice(0).map((owner) => owner.dispose()))
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
  if (errors.length > 0) throw new AggregateError(errors, "PTY fixtures did not stop; their directory was retained.")
  await rm(root, { recursive: true, force: true })
})

const capture = async (output: string) => {
  const exited = Promise.withResolvers<void>()
  const owner = createPtyManager({
    home: root,
    env: {},
    harnesses: async () => [{
      id: "pi",
      displayName: "fixture",
      binary: "/usr/bin/printf",
      version: null,
      status: "binary-only",
      account: null,
      launch: { argv: ["printf", "%s", output] }
    }],
    publish: (_topic, message) => {
      if ((message as { type: string }).type === "pty.exit") exited.resolve()
    },
    sandboxHost: { platform: "linux", disabled: true, log: () => {} },
    killGraceMs: 100,
    log: () => {}
  })
  owners.push(owner)
  const result = await owner.create({ kind: "harness", harnessId: "pi", cwd: root, cols: 80, rows: 24 })
  if (result.status !== "ok") throw new Error(result.message)
  await exited.promise
  return (tailBytes?: number) => owner.read(result.session.sessionId, tailBytes)!
}

test("PTY tail counts UTF-8 bytes and never returns a partial code point", async () => {
  const read = await capture("start-é-界-😀")
  expect(read().output).toBe("start-é-界-😀")
  for (const [limit, output] of [[0, ""], [1, ""], [2, ""], [3, ""], [4, "😀"], [5, "-😀"], [8, "界-😀"]] as const) {
    expect(read(limit)).toMatchObject({ output, truncated: true, alive: false })
    expect(new TextEncoder().encode(read(limit).output).byteLength).toBeLessThanOrEqual(limit)
  }
  expect(read(Number.MAX_SAFE_INTEGER)).toMatchObject({ output: "start-é-界-😀", truncated: false })
  for (const limit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => read(limit)).toThrow("tailBytes")
  }
})

test("the raw scrollback cap is 64 KiB for non-ASCII output too", async () => {
  const read = await capture("😀".repeat(20_000))
  expect(read()).toMatchObject({ output: "😀".repeat(PTY_SCROLLBACK_BYTES / 4), truncated: true, alive: false })
  expect(new TextEncoder().encode(read().output).byteLength).toBe(PTY_SCROLLBACK_BYTES)
})
