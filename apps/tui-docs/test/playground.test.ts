import assert from "node:assert/strict"
import { test } from "node:test"
import { run } from "../src/playground/agent.ts"
import { canonical, Journal, path, seed, storageKey } from "../src/playground/store.ts"
const memory = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    }
  }
}
test("atomic persistence, reload, historical isolation, and branching", () => {
  const storage = memory(), journal = new Journal(storage)
  journal.start("fix", "run")
  journal.update((frame) => {
    frame.files["math.js"] = "fixed"
    frame.events.push({ kind: "answer", text: "future" })
  })
  assert.deepEqual(journal.branch.frames[0]!.files, seed)
  assert.deepEqual(journal.branch.frames[0]!.events, [])
  const restored = new Journal(storage)
  assert.equal(restored.head.files["math.js"], "fixed")
  restored.branchAt(0, "child")
  assert.deepEqual(restored.head.files, seed)
  restored.select("main")
  assert.equal(restored.head.files["math.js"], "fixed")
  const before = structuredClone(restored.state)
  storage.setItem = () => {
    throw new Error("quota")
  }
  assert.throws(() =>
    restored.update((frame) => {
      frame.files["math.js"] = "lost"
    }), /quota/)
  assert.deepEqual(restored.state, before)
})
test("refuses corrupt persisted data and paths outside the volume", () => {
  const storage = memory()
  storage.setItem(storageKey, "broken")
  assert.throws(() => new Journal(storage))
  for (const value of ["../secret", "/secret", "a/b.js", "__proto__", ""]) assert.throws(() => path(value))
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }))
})
test("production agent recovers committed calls and model replies after interruption", async () => {
  const storage = memory(), journal = new Journal(storage), previous = globalThis.fetch
  let requests = 0
  const first =
    "```cell\nawait ctx.call(\"write\", {path:\"math.js\",content:\"export const add = (a, b) => a + b\\n\"});\nconsole.log(await ctx.call(\"check\", {}));\n```"
  const last = "```cell\nctx.done(\"Fixed and checked.\");\n```"
  const controller = new AbortController()
  globalThis.fetch = async (_url, init) => {
    requests++
    if (requests === 2) {
      queueMicrotask(() => controller.abort())
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      )
    }
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: requests === 1 ? first : last } }] })
  }
  try {
    journal.start("Fix addition", "durable-example")
    await run(journal, { baseUrl: "", apiKey: "", model: "" }, () => {}, controller.signal)
    assert.equal(journal.head.run?.status, "failed")
    assert.match(journal.head.files["math.js"]!, /a \+ b/)
    const count = Object.keys(journal.head.run!.calls).length
    assert.equal(count, 2)
    const restored = new Journal(storage)
    await run(restored, { baseUrl: "", apiKey: "", model: "" }, () => {}, new AbortController().signal)
    assert.equal(restored.head.run?.status, "done", restored.head.run?.error)
    assert.equal(requests, 3, "completed first model response was replayed")
    assert.equal(Object.keys(restored.head.run!.calls).length, count, "completed flow calls were not duplicated")
    assert.equal(restored.head.events.filter((e) => e.kind === "flow").length, 2)
  } finally {
    globalThis.fetch = previous
  }
})
test("a provider refusal stays visible and retryable", async () => {
  const previous = globalThis.fetch, journal = new Journal(memory())
  globalThis.fetch = async () => Response.json({ error: "unavailable" }, { status: 503 })
  try {
    journal.start("fix", "refused")
    await run(journal, { baseUrl: "", apiKey: "", model: "" }, () => {}, new AbortController().signal)
    assert.equal(journal.head.run?.status, "failed")
    assert.match(journal.head.run?.error ?? "", /Settings|unavailable/i)
    assert.deepEqual(journal.head.files, seed)
  } finally {
    globalThis.fetch = previous
  }
})
