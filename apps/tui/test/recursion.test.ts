import { expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Host from "../src/host.ts"
import * as Runtime from "../src/runtime.ts"
import * as Session from "../src/session.ts"
import { Workspace } from "../src/workspace.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

it("lets a worker delegate twice, wait for both, and projects their live tree", async () => {
  const controls = new Map<string, (answer: Host.Outcome) => void>()
  const runtime = new Map<string, Runtime.Ports>()
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-tree-")), judged: false,
    compaction: async () => undefined, dispose: async () => {},
    run: (input) => {
      runtime.set(input.source!, input.runtime!)
      return { done: new Promise((resolve) => controls.set(input.source!, resolve)), cancel: () => {} }
    }
  }
  const workspace = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: () => {} })
  workspace.request({ id: "root", title: "Review", prompt: "Review the repo" })
  await tick()
  const ports = runtime.get("root")!
  const bindings = await Effect.runPromise(Runtime.source(ports).bindings())
  const delegate = bindings.find((binding) => binding.descriptor.name === "agent.delegate")!
  const wait = bindings.find((binding) => binding.descriptor.name === "agent.wait")!
  for (const id of ["a", "b"]) {
    const receipt = await Effect.runPromise(delegate.run({ input: { id, title: id, prompt: id } } as never))
    expect(receipt).toMatchObject({ outcome: "success", value: { id: `root/${id}` } })
  }
  await tick()
  expect(workspace.snapshot().tabs.map((tab) => [tab.id, tab.parent, tab.depth])).toEqual([
    ["root", undefined, 0], ["root/a", "root", 1], ["root/b", "root", 1]
  ])
  expect(workspace.tree("root").rows.map((row) => row.label)).toEqual([
    expect.stringContaining("● Review"), expect.stringContaining("● a"), expect.stringContaining("● b")
  ])
  const waiting = Effect.runPromise(wait.run({ input: { ids: ["a", "b"] } } as never))
  await tick()
  expect(workspace.snapshot().tabs[0]?.status).toBe("waiting")
  controls.get("root/a")!({ _tag: "done", answer: "A" })
  controls.get("root/b")!({ _tag: "done", answer: "B" })
  expect(await waiting).toMatchObject({ outcome: "success", value: [
    { id: "root/a", status: "done", answer: "A" }, { id: "root/b", status: "done", answer: "B" }
  ] })
  const tree = workspace.tree("root")
  expect(tree.rows.map((row) => row.label)).toEqual([
    expect.stringContaining("Review"), expect.stringContaining("a"), expect.stringContaining("b")
  ])
  expect(tree.id).toBe("tree:root")
  expect(tree.rows[0]?.label).toContain("2/2 children")
})

it("refuses depth four with a typed error and queues the seventh worker", async () => {
  const records: Session.Record[] = []
  const contacted: string[] = []
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-pool-")), judged: false,
    compaction: async () => undefined, dispose: async () => {},
    run: (input) => { contacted.push(input.source!); return { done: new Promise(() => {}), cancel: () => {} } }
  }
  const workspace = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: (record) => records.push(record) })
  for (let i = 0; i < 7; i++) workspace.request({ id: `root${i}`, title: `Root ${i}`, prompt: `Task ${i}` })
  expect(workspace.snapshot().tabs[6]?.status).toBe("queued")
  const persisted = Session.restore(records).workspace
  await tick()
  const root = workspace.snapshot().tabs[0]!
  workspace.requestChild(root, { id: "child", title: "Child", prompt: "Task child" })
  expect(workspace.snapshot().tabs.at(-1)?.status).toBe("queued")
  void workspace.wait(root.id, ["child"])
  await tick()
  expect(contacted).toContain("root6")
  expect(workspace.snapshot().tabs[0]?.status).toBe("waiting")
  const restored = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: () => {}, restored: persisted })
  expect(restored.snapshot().tabs[6]?.status).toBe("queued")
  const bindings = await Effect.runPromise(Runtime.source({
    publish: () => {},
    delegate: (request) => workspace.requestChild({ ...root, depth: 3 }, request),
    read: workspace.read,
    list: () => workspace.snapshot().tabs
  }).bindings())
  const delegate = bindings.find((binding) => binding.descriptor.name === "agent.delegate")!
  expect(await Effect.runPromise(delegate.run({ input: { id: "too-deep", title: "No", prompt: "No" } } as never)))
    .toMatchObject({ outcome: "failure", message: expect.stringContaining("AgentDepthExceeded") })
})
