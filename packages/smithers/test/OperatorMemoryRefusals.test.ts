import { Cli } from "incur"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createMemoryCli } from "../src/operator/Memory.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-memory-refusals-"))
  roots.push(root)
  return root
}
const invoke = async (root: string, ...args: Array<string>) => {
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

it("refuses a namespace identified twice before it writes", async () => {
  const root = await fixture()
  const refused = await invoke(root, "set", "theme", "dark", "--namespace", "user:alice", "--id", "bob")
  expect(refused.code).toBe(1)
  expect(refused.data.message).toBe("Use either --namespace kind:id or --namespace kind --id id")
  expect((await invoke(root, "list", "--namespace", "user:alice")).data).toEqual([])
  expect((await invoke(root, "list", "--namespace", "user", "--id", "bob")).data).toEqual([])
})

it("refuses a non-JSON fact value only when JSON is required", async () => {
  const root = await fixture()
  const strict = await invoke(root, "set", "theme", "dark", "--value-json")
  expect(strict.code).toBe(1)
  expect(strict.data.message).toBe("The fact value is not valid JSON")
  expect((await invoke(root, "get", "theme")).code).toBe(1)
  expect((await invoke(root, "set", "theme", "dark")).code).toBe(0)
  expect((await invoke(root, "get", "theme")).data.value).toBe("dark")
})

it("refuses unknown notes and threads by name", async () => {
  const root = await fixture()
  const note = await invoke(root, "notes", "get", "absent")
  expect(note.code).toBe(1)
  expect(note.data.message).toBe("Unknown note absent")
  const thread = await invoke(root, "threads", "show", "absent")
  expect(thread.code).toBe(1)
  expect(thread.data.message).toBe("Unknown thread absent")
})

it("recalls from an explicit bank instead of the namespace's own bank", async () => {
  const root = await fixture()
  expect(
    (await invoke(root, "notes", "add", "amber guide", "--note-id", "flow-guide", "--namespace", "flow:alpha")).code
  )
    .toBe(0)
  const keys = async (...flags: Array<string>) =>
    (await invoke(root, "recall", "amber", ...flags)).data.map((row: { key: string }) => row.key)
  expect(await keys()).toEqual([])
  expect(await keys("--bank", "alpha")).toEqual(["flow-guide"])
  expect(await keys("--bank", "alpha", "--method", "fts")).toEqual(["flow-guide"])
})
