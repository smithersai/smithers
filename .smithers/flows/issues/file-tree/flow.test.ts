/**
 * `issues/file-tree` through the flow API, on the in-memory engine, against a fake smithers.sh: what it files, whom it
 * refuses, and how it recovers a write. The kill-and-resume proof through the real CLI is `resume.test.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { LANES, startFakeSmithers } from "./fake-smithers.mjs"
import FileTree, { advance, type Cursor, type Outcome, layer } from "./flow.ts"
import { step } from "./steps.mjs"

type Row = Record<string, unknown>
const node = (key: string, title: string, parent: string | undefined, depth: number): Row => ({ type: "node", key, repo: "acme/plan", title, about: `${title}.`, parent, depth, labels: ["tree"] })
const issue = (key: string, title: string, repo: string, extra: Row = {}): Row => ({
  type: "issue", kind: "draft", key, repo, title, body: `${title}.`, labels: ["draft"],
  links: [{ kind: "session", ref: `lane:${key.replace(/\W/g, "-")}`, label: "lane" }], parent: "tree:a", depth: 3, ...extra
})
const planRows = (issues: Array<Row>): Array<Row> => [
  node("tree:root", "Ship it", undefined, 1),
  node("tree:a", "Part A", "tree:root", 2),
  ...issues,
  { type: "summary", at: "2026-11-02T00:00:00.000Z", maxDepth: 3 }
]

let sequence = 0
const run = async (fake: { origin: string }, rows: Array<Row>, tokens: Record<string, string> = { "acme/plan": `smm_${"p".repeat(43)}`, "acme/code": `smm_${"c".repeat(43)}` }, lanes: Record<string, string> = LANES) => {
  const dir = mkdtempSync(join(tmpdir(), "file-tree-"))
  const plan = join(dir, "plan.jsonl")
  writeFileSync(plan, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
  const files = Object.fromEntries(Object.entries(tokens).map(([repo, token], index) => {
    const file = join(dir, `token-${index}`)
    writeFileSync(file, `${token}\n`, { mode: 0o600 })
    const [agent, lane] = (lanes[token] ?? "filer/lane-1").split("/")
    return [repo, { file, agent, lane }]
  }))
  const map = join(dir, "tokens.json")
  writeFileSync(map, JSON.stringify(files), { mode: 0o600 })
  process.env.SMITHERS_ISSUE_TOKENS = map
  return Effect.runPromiseExit(
    FileTree.execute({ plan, origin: fake.origin }, { executionId: `file-tree-${++sequence}` }).pipe(
      Effect.provide(Interpreter.layerWithImplementations(FileTree, layer).pipe(Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer)))
    )
  )
}
const ok = (exit: Exit.Exit<unknown, unknown>) => {
  assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
  return exit.value as { filed: number; counts: Record<string, number>; exceptions: Array<string> }
}

test("files nodes then issues as sub-issues with labels and work links, and a second run is the same writes", async () => {
  const fake = await startFakeSmithers()
  try {
    const rows = planRows([issue("draft:x:1", "First thing", "acme/plan"), issue("draft:x:2", "Second thing", "acme/code")])
    assert.deepEqual(ok(await run(fake, rows)).counts, { created: 4, linked: 4, queueLinks: 0, exceptions: 0 })
    const writes = [...fake.writes.values()]
    const made = writes.filter((write) => write.op === "issue/create")
    assert.deepEqual(made.map((write) => write.title), ["Ship it", "Part A", "First thing", "Second thing"])
    assert.deepEqual(made[3].labels, ["draft"])
    assert.match(made[3].body, /^key: draft:x:2$/m)
    const relates = writes.filter((write) => write.op === "issue/relate")
    assert.deepEqual(relates.map((write) => [write.repo, write.number, write.parent]), [
      ["acme/plan", 2, { repo: "acme/plan", number: 1 }],
      ["acme/plan", 3, { repo: "acme/plan", number: 2 }],
      ["acme/code", 1, { repo: "acme/plan", number: 2 }]
    ])
    assert.equal(fake.links.size, 2)
    const count = fake.writes.size
    assert.deepEqual(ok(await run(fake, rows)).counts, { created: 4, linked: 4, queueLinks: 0, exceptions: 0 })
    assert.equal(fake.writes.size, count, "the same write ids, nothing new")
  } finally {
    await fake.close()
  }
})

test("posts every work link, 50 to a request, and finds a row's issue by its key before making one", async () => {
  const fake = await startFakeSmithers()
  try {
    const links = Array.from({ length: 51 }, (_, i) => ({ kind: "session", ref: `lane:l${i}`, label: "lane" }))
    // The second node was filed some other way, by another lane: its key's marker is on an issue already.
    fake.shapeExtra.push({ repo: "acme/plan", key: "acme/plan#77", value: { number: "77", body: "Part A.\n\nkey: tree:a\n", title: "Part A", state: "closed", kind: "issue" } })
    const rows = planRows([issue("draft:x:1", "First thing", "acme/plan", { links })])
    const result = ok(await run(fake, rows))
    assert.equal(result.exceptions.length, 0, JSON.stringify(result.exceptions))
    assert.equal([...fake.links.keys()].filter((key) => key.includes(" session lane:l")).length, 51)
    // The fake refuses more than 50 to a request, as the server does: the 51 went as 50, then 1.
    assert.ok(fake.linkBatches.some((size: number, i: number) => size === 50 && fake.linkBatches[i + 1] === 1), JSON.stringify(fake.linkBatches))
    const made = [...fake.writes.values()].filter((write) => write.op === "issue/create").map((write) => write.title)
    assert.deepEqual(made, ["Ship it", "First thing"], "Part A was found, not made again")
    const relates = [...fake.writes.values()].filter((write) => write.op === "issue/relate")
    assert.ok(relates.some((write) => write.number === 77), "the found issue is placed under its parent")
  } finally {
    await fake.close()
  }
})

test("a new token for the lane sends the same ids: a filed plan files nothing again, and another lane finds the issues by key", async () => {
  const rotated = `smm_${"r".repeat(43)}`
  const other = `smm_${"o".repeat(43)}`
  const lanes = { ...LANES, [rotated]: "filer/lane-1", [other]: "filer/lane-2" }
  const fake = await startFakeSmithers({ liveTokens: [...Object.keys(LANES), rotated, other], lanes })
  try {
    const rows = planRows([issue("draft:x:1", "First thing", "acme/plan")])
    assert.deepEqual(ok(await run(fake, rows, { "acme/plan": `smm_${"p".repeat(43)}` })).exceptions, [])
    const ids = [...fake.writes.keys()]
    // The token expires and the lane gets a new one: the same plan sends the same ids, and the server answers each as
    // the write it already is.
    fake.revoked.add(`smm_${"p".repeat(43)}`)
    fake.shapeExtra.length = 0
    const before = new Map(fake.submissions)
    assert.deepEqual(ok(await run(fake, rows, { "acme/plan": rotated }, lanes)).exceptions, [])
    assert.deepEqual([...fake.writes.keys()], ids, "no new write")
    assert.equal([...fake.writes.values()].filter((write) => write.op === "issue/create").length, 3, "one issue per row")
    assert.ok([...fake.submissions].every(([id, count]) => count >= (before.get(id) ?? 0)))
    // Another lane finds every row's issue by its key and makes none.
    assert.deepEqual(ok(await run(fake, rows, { "acme/plan": other }, lanes)).exceptions, [])
    assert.equal([...fake.writes.values()].filter((write) => write.op === "issue/create").length, 3)
  } finally {
    await fake.close()
  }
})

test("a write still pending when its token is revoked settles refused, as the server settles it, and the run says so", async () => {
  const rotated = `smm_${"r".repeat(43)}`
  const lanes = { ...LANES, [rotated]: "filer/lane-1" }
  const fake = await startFakeSmithers({ liveTokens: [...Object.keys(LANES), rotated], lanes })
  try {
    const rows = planRows([issue("draft:x:1", "First thing", "acme/plan")])
    fake.pending = (write: { title?: string }) => write.title === "First thing"
    const first = await Promise.race([run(fake, rows, { "acme/plan": `smm_${"p".repeat(43)}` }), new Promise((resolve) => setTimeout(resolve, 3_000))])
    assert.equal(first, undefined, "the first run is still watching its pending write")
    fake.revoked.add(`smm_${"p".repeat(43)}`)
    // The new token sends the same id: the server keeps the write's own token, which is revoked, so it settles refused.
    const result = ok(await run(fake, rows, { "acme/plan": rotated }, lanes))
    assert.ok(result.exceptions.some((exception) => exception.includes("revoked")), JSON.stringify(result.exceptions))
    assert.equal([...fake.writes.values()].filter((write) => write.op === "issue/create" && write.title === "First thing").length, 1, "not filed twice")
  } finally {
    await fake.close()
  }
})

test("a plan's timestamp must be a timestamp: nothing unchecked goes out with a link", async () => {
  const fake = await startFakeSmithers()
  try {
    const rows = planRows([issue("draft:x:1", "First thing", "acme/plan")]).map((row) => (row.type === "summary" ? { ...row, at: `smm_${"f".repeat(43)}` } : row))
    const exit = await run(fake, rows)
    assert.ok(Exit.isFailure(exit), "refused before any write")
    assert.equal(fake.writes.size, 0)
    assert.ok(!JSON.stringify(exit).includes("f".repeat(20)), "the refusal does not quote it")
  } finally {
    await fake.close()
  }
})

test("a row key shaped like a credential is refused before anything runs or records it, invisible joiners and all", async () => {
  // A word joiner (U+2060) or zero-width space shows nothing: the page still shows the whole credential.
  for (const secret of [`ghp_${"q".repeat(36)}`, `smm_\u2060${"q".repeat(43)}`, `gh\u200bp_${"q".repeat(36)}`]) {
    const fake = await startFakeSmithers()
    try {
      const rows = planRows([issue("draft:x:1", "First thing", "acme/plan")]).map((row) => (row.key === "tree:a" ? { ...row, key: secret } : row.parent === "tree:a" ? { ...row, parent: secret } : row))
      const exit = await run(fake, rows)
      assert.ok(Exit.isFailure(exit), JSON.stringify(secret))
      assert.equal(fake.writes.size, 0)
      assert.ok(!JSON.stringify(exit).includes("q".repeat(20)))
    } finally {
      await fake.close()
    }
  }
})

test("refuses a dead token before any write", async () => {
  const fake = await startFakeSmithers()
  try {
    const exit = await run(fake, planRows([issue("draft:x:1", "First thing", "acme/plan")]), { "acme/plan": `smm_${"d".repeat(43)}` })
    assert.ok(Exit.isFailure(exit))
    assert.match(JSON.stringify(exit.cause), /machine token for acme\/plan is not live/)
    assert.equal(fake.log.filter((entry: { method: string }) => entry.method === "POST").length, 0)
  } finally {
    await fake.close()
  }
})

test("a refused write ends the row as an exception, never retried; a server's wait is waited out", async () => {
  const fake = await startFakeSmithers()
  try {
    fake.script((method: string, path: string) => method === "POST" && path === "/api/repos/acme/code/writes", [[403, { code: "forbidden" }, {}]])
    fake.script((method: string, path: string) => method === "POST" && path === "/api/repos/acme/plan/writes", [[429, {}, { "retry-after": "1" }]])
    const started = Date.now()
    const report = ok(await run(fake, planRows([issue("draft:x:2", "Second thing", "acme/code"), issue("draft:x:3", "Third thing", "acme/plan")])))
    assert.ok(Date.now() - started >= 1000)
    assert.equal(report.counts.exceptions, 1)
    assert.match(report.exceptions[0]!, /refused: HTTP 403 forbidden/)
    assert.equal(fake.posts(/^\/api\/repos\/acme\/code\/writes$/).length, 1)
  } finally {
    await fake.close()
  }
})

test("a write that settled failed is an exception the report names, and the run goes on", async () => {
  const fake = await startFakeSmithers()
  try {
    const rows = planRows([issue("draft:x:1", "First thing", "acme/plan", { links: [] }), issue("draft:x:2", "Second thing", "acme/plan", { links: [] })])
    fake.afterWrite = (write: { title?: string; status: string; failure: string | null }) => {
      if (write.title === "First thing") {
        write.status = "failed"
        write.failure = "exhausted"
      }
    }
    const report = ok(await run(fake, rows))
    assert.equal(report.counts.exceptions, 1)
    assert.match(report.exceptions[0]!, /exhausted/)
    assert.equal(report.counts.created, 3)
  } finally {
    await fake.close()
  }
})

test("after the issues, posts a queue entry's work link on the issue it names, and files no issue for it", async () => {
  const fake = await startFakeSmithers()
  try {
    const rows = planRows([issue("draft:x:1", "First thing", "acme/plan", { links: [] })])
    rows.splice(-1, 0, { type: "queue-link", kind: "queue-link", key: "queue:q-1:7", repo: "acme/plan", issue: 7, link: { kind: "queue", ref: "q-1", label: "q-1 (queued)", state: "queued" } })
    const report = ok(await run(fake, rows))
    assert.equal(report.counts.queueLinks, 1)
    assert.equal(report.counts.created, 3)
    assert.deepEqual(fake.links.get("acme/plan#7 queue q-1"), { kind: "queue", ref: "q-1", label: "q-1 (queued)", state: "queued", at: "2026-11-02T00:00:00.000Z" })
    assert.match(fake.log.filter((entry: { method: string }) => entry.method === "POST").at(-1)!.path, /issues\/7\/links$/)
  } finally {
    await fake.close()
  }
})


test("a recorded pruning outcome survives JSON replay, preserves needed failed parents, and cleans legacy cursors on a retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-tree-live-parents-"))
  const plan = join(dir, "plan.jsonl")
  const rows = planRows([issue("draft:x:1", "Leaf", "acme/plan")])
  writeFileSync(plan, rows.map(row => JSON.stringify(row)).join("\n") + "\n")
  const { readPlan } = await import("./steps.mjs")
  let cursor: typeof Cursor.Type = {
    plan, sha: readPlan(plan).sha, total: 3, index: 2, stage: "create", submitted: false, attempt: 0,
    number: null, waitMs: 0, nodes: { "tree:root": 1, "tree:a": null, "old:leaf": 99 },
    dryRun: true, origin: "http://unused", counts: { created: 2, linked: 1, queueLinks: 0, exceptions: 0 }, exceptions: []
  }
  // Submit is an unfinished action outcome, so cleanup must not depend on done.
  const pending = await step(cursor)
  assert.equal(pending.done, false)
  assert.deepEqual(pending.forgetNodes, ["tree:root", "old:leaf"])
  const recorded = JSON.parse(JSON.stringify(pending)) as typeof Outcome.Type
  cursor = advance(cursor, recorded)
  assert.deepEqual(cursor.nodes, { "tree:a": null }, "a required failed parent remains known")
  assert.equal(cursor.attempt, 1)
  cursor = advance(cursor, await step(cursor))
  assert.equal(cursor.stage, "link")
  const missing = await step(cursor)
  assert.equal(missing.exception, "no parent: the row's parent has no issue")
  assert.deepEqual(advance(cursor, missing).nodes, { "tree:a": null })

  // Old journals lack forgetNodes and continue to replay their old cursor.
  const { forgetNodes: _, ...legacy } = recorded
  assert.deepEqual(advance({ ...cursor, nodes: { "old:leaf": 99 } }, legacy).nodes, { "old:leaf": 99 })
})

test("leaf-node receipts are forgotten, while a later descendant still links to its recorded parent", async () => {
  const fake = await startFakeSmithers()
  try {
    const rows = [node("tree:root", "Root", undefined, 1), node("tree:branch", "Branch", "tree:root", 2),
      ...Array.from({ length: 20 }, (_, i) => node(`tree:leaf:${i}`, `Leaf ${i}`, "tree:root", 2)),
      issue("draft:x:1", "Last child", "acme/plan", { parent: "tree:branch", links: [] }),
      { type: "summary", at: "2026-11-02T00:00:00.000Z", maxDepth: 3 }]
    const report = ok(await run(fake, rows))
    assert.deepEqual(report.exceptions, [])
    const relates = [...fake.writes.values()].filter(write => write.op === "issue/relate")
    assert.equal(relates.length, 22)
    assert.deepEqual(relates.at(-1)?.parent, { repo: "acme/plan", number: 2 })
  } finally { await fake.close() }
})
