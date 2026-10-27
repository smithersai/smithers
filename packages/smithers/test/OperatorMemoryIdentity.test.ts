import { Cli } from "incur"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createMemoryCli } from "../src/operator/Memory.ts"

it("reuses an omitted message timestamp across retries and still rejects conflicting content", async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-message-identity-"))
  const invoke = async (...args: Array<string>) => {
    let output = ""
    let code = 0
    await Cli.create("smthrs").command(createMemoryCli()).serve(["memory", ...args, "--root", root, "--json"], {
      stdout: (text) => {
        output += text
      },
      exit: (value) => {
        code = value
      }
    })
    return { code, data: JSON.parse(output) }
  }
  try {
    const append = (...flags: Array<string>) => invoke("messages", "add", "history", "hello", ...flags)
    const original = await append("--message-id", "retry")
    expect(original.code).toBe(0)
    // A real store open/close and the intervening write ensure a later invocation.
    expect((await append("--message-id", "other")).code).toBe(0)
    const retry = await append("--message-id", "retry")
    expect(retry).toEqual(original)
    expect((await append("--message-id", "retry", "--at", String(original.data.at))).code).toBe(0)
    for (const flags of [["--role", "assistant"], ["--at", String(original.data.at + 1)]]) {
      const conflict = await append("--message-id", "retry", ...flags)
      expect(conflict.code).toBe(1)
      expect(conflict.data.message).toContain("already exists")
    }
    expect((await invoke("messages", "add", "history", "changed", "--message-id", "retry")).code).toBe(1)
    expect((await append("--message-id", "zero", "--at", "0")).code).toBe(0)
    expect((await append("--message-id", "zero")).data.at).toBe(0)
    const generated = await append()
    expect(generated.code).toBe(0)
    expect(generated.data.id).toBeTypeOf("string")
    expect((await invoke("messages", "list", "history")).data).toHaveLength(4)
    const overlapping = await Promise.all(Array.from({ length: 8 }, () => append("--message-id", "overlap")))
    expect(overlapping.every((result) => result.code === 0)).toBe(true)
    expect(overlapping.every((result) => result.data.at === overlapping[0]!.data.at)).toBe(true)
    expect((await invoke("messages", "list", "history")).data).toHaveLength(5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
