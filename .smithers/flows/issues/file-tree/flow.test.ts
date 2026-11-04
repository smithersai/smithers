/**
 * `issues/file-tree` through the flow API, on the in-memory engine, against a fake smithers.sh: what it files, whom it
 * refuses, and how it recovers a write. The kill-and-resume proof through the real CLI is `resume.test.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import * as Fault from "@smthrs/flow/Fault"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { LANES, startFakeSmithers } from "./fake-smithers.mjs"
import FileTree, { FileRefused, Round, advance, type Cursor, type Outcome, layer } from "./flow.ts"
import { readPlan, step } from "./steps.mjs"

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
const run = async (fake: { origin: string }, rows: Array<Row>, tokens: Record<string, string> = { "acme/plan": `smm_${"p".repeat(43)}`, "acme/code": `smm_${"c".repeat(43)}` }, lanes: Record<string, string> = LANES, signal?: AbortSignal) => {
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
    ), { signal }
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
  const stopped = new AbortController()
  try {
    const rows = planRows([issue("draft:x:1", "First thing", "acme/plan")])
    fake.pending = (write: { title?: string }) => write.title === "First thing"
    const first = await Promise.race([run(fake, rows, { "acme/plan": `smm_${"p".repeat(43)}` }, lanes, stopped.signal), new Promise((resolve) => setTimeout(resolve, 3_000))])
    assert.equal(first, undefined, "the first run is still watching its pending write")
    fake.revoked.add(`smm_${"p".repeat(43)}`)
    // The new token sends the same id: the server keeps the write's own token, which is revoked, so it settles refused.
    const result = ok(await run(fake, rows, { "acme/plan": rotated }, lanes))
    assert.ok(result.exceptions.some((exception) => exception.includes("revoked")), JSON.stringify(result.exceptions))
    assert.equal([...fake.writes.values()].filter((write) => write.op === "issue/create" && write.title === "First thing").length, 1, "not filed twice")
  } finally {
    stopped.abort()
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
    fake.script((method: string, path: string) => method === "POST" && path === "/api/repos/acme/code/writes", [[422, { code: "invalid" }, {}]])
    fake.script((method: string, path: string) => method === "POST" && path === "/api/repos/acme/plan/writes", [[429, {}, { "retry-after": "1" }]])
    const started = Date.now()
    const report = ok(await run(fake, planRows([issue("draft:x:2", "Second thing", "acme/code"), issue("draft:x:3", "Third thing", "acme/plan")])))
    assert.ok(Date.now() - started >= 1000)
    assert.equal(report.counts.exceptions, 1)
    assert.match(report.exceptions[0]!, /draft:x:2:create: refused: HTTP 422 invalid/)
    assert.equal(fake.posts(/^\/api\/repos\/acme\/code\/writes$/).length, 1)
    assert.ok([...fake.writes.values()].some(write => write.title === "Third thing"))
  } finally { await fake.close() }
})

test("row 2 gets a 422 while rows 1 and 3 still file", async () => {
  const fake = await startFakeSmithers()
  try {
    fake.script((method: string, path: string) => method === "POST" && path === "/api/repos/acme/code/writes", [[422, { code: "invalid" }, {}]])
    const report = ok(await run(fake, planRows([
      issue("draft:x:1", "First thing", "acme/plan"), issue("draft:x:2", "Second thing", "acme/code"), issue("draft:x:3", "Third thing", "acme/plan")
    ])))
    assert.deepEqual(report.exceptions, ["draft:x:2:create: refused: HTTP 422 invalid"])
    assert.equal(report.counts.created, 4)
    assert.deepEqual([...fake.writes.values()].filter(write => write.op === "issue/create").map(write => write.title), ["Ship it", "Part A", "First thing", "Third thing"])
    assert.equal(fake.links.size, 2)
  } finally { await fake.close() }
})

test("a failed parent skips children and grandchildren while another branch still files", async () => {
  const fake = await startFakeSmithers()
  try {
    fake.afterWrite = (write: { title?: string }) => {
      if (write.title === "Root") fake.script((method: string, path: string) => method === "POST" && path.endsWith("/writes"), [[409, { code: "conflict" }, {}]])
    }
    const report = ok(await run(fake, [
      node("tree:root", "Root", undefined, 1), node("tree:bad", "Bad", "tree:root", 2), node("tree:good", "Good", "tree:root", 2),
      node("tree:child", "Child", "tree:bad", 3), issue("draft:bad", "Grandchild", "acme/plan", { parent: "tree:child" }),
      issue("draft:good", "Good child", "acme/plan", { parent: "tree:good" }), { type: "summary", maxDepth: 4 }
    ]))
    assert.deepEqual(report.exceptions, ["tree:bad:create: refused: HTTP 409 conflict", "tree:child:create: no parent: tree:bad failed", "draft:bad:create: no parent: tree:child failed"])
    assert.deepEqual([...fake.writes.values()].filter(write => write.op === "issue/create").map(write => write.title), ["Root", "Good", "Good child"])
  } finally { await fake.close() }
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
    number: null, waitMs: 0, nodes: { "tree:root": 1, "tree:a": 7, "old:leaf": 99 },
    dryRun: true, origin: "http://unused", counts: { created: 2, linked: 1, queueLinks: 0, exceptions: 0 }, exceptions: []
  }
  // Submit is an unfinished action outcome, so cleanup must not depend on done.
  const pending = await step(cursor)
  assert.equal(pending.done, false)
  assert.deepEqual(pending.forgetNodes, ["tree:root", "old:leaf"])
  const recorded = JSON.parse(JSON.stringify(pending)) as typeof Outcome.Type
  cursor = advance(cursor, recorded)
  assert.deepEqual(cursor.nodes, { "tree:a": 7 }, "a required parent remains known")
  assert.equal(cursor.attempt, 1)
  cursor = advance(cursor, await step(cursor))
  assert.equal(cursor.stage, "link")
  cursor = { ...cursor, nodes: { "tree:a": null } }
  const missing = await step(cursor)
  assert.equal(missing.exception, "no parent: tree:a failed")
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

// Exercise individual recorded rounds without waiting real minutes. JSON replay is the persisted handoff.
const retryCursor = (fake: { origin: string }, extra = {}): typeof Cursor.Type => {
  const dir = mkdtempSync(join(tmpdir(), "file-tree-retry-"))
  const plan = join(dir, "plan.jsonl")
  writeFileSync(plan, planRows([issue("draft:retry:1", "Retry", "acme/plan")]).map(row => JSON.stringify(row)).join("\n"))
  const token = join(dir, "token")
  writeFileSync(token, `smm_${"p".repeat(43)}`, { mode: 0o600 })
  const map = join(dir, "tokens.json")
  writeFileSync(map, JSON.stringify({ "acme/plan": { file: token, agent: "filer", lane: "lane-1" } }), { mode: 0o600 })
  process.env.SMITHERS_ISSUE_TOKENS = map
  return { plan, sha: readPlan(plan).sha, total: 3, index: 2, stage: "create", submitted: false,
    attempt: 0, number: null, waitMs: 0, nodes: { "tree:a": 7 }, dryRun: false, origin: fake.origin,
    counts: { created: 0, linked: 0, queueLinks: 0, exceptions: 0 }, exceptions: [], ...extra }
}
const replayRound = async (cursor: typeof Cursor.Type) => advance(cursor, JSON.parse(JSON.stringify(await step(cursor))))

test("an accepted write whose response is lost is re-sent with the same id, gets 200 and creates one issue", async () => {
  const fake = await startFakeSmithers()
  try {
    let cursor = retryCursor(fake)
    // The accepted machine write has not settled yet, so the issues shape cannot find it on the next round.
    fake.pending = () => true
    fake.script((method: string, path: string) => method === "POST" && path.endsWith("/writes"), [["reset-after-write", {}, {}]])
    cursor = await replayRound(cursor)
    assert.equal(cursor.submitted, false)
    assert.equal(cursor.waitMs, 2000)
    assert.equal(fake.writes.size, 1, "the write was recorded before the transport failed")
    const [writeId, write] = [...fake.writes.entries()][0]!
    assert.equal(write.op, "issue/create")
    assert.equal(write.status, "pending")
    assert.equal(fake.posts(/writes$/).length, 1)
    assert.equal(fake.posts(/writes$/)[0].status, null, "the client received no acceptance response")

    cursor = await replayRound(JSON.parse(JSON.stringify(cursor)))
    assert.equal(cursor.submitted, true)
    assert.equal(cursor.waitMs, 0)
    assert.equal(fake.writes.size, 1, "re-sending must reuse the accepted write")
    assert.deepEqual(fake.posts(/writes$/).map(entry => [entry.writeId, entry.status]), [[writeId, null], [writeId, 200]])
    assert.equal(fake.submissions.get(writeId), 2)

    fake.pending = () => false
    cursor = await replayRound(cursor)
    assert.equal(cursor.stage, "link")
    assert.equal(cursor.number, write.number)
    assert.equal(cursor.counts.created, 1)
    assert.deepEqual(cursor.exceptions, [])
    const issues = [...fake.writes.values()].filter(write => write.op === "issue/create" && write.status === "done")
    assert.equal(issues.length, 1)
    assert.match(issues[0].body, /^key: draft:retry:1$/m)
  } finally { await fake.close() }
})

for (const status of [503, 429, 502, 504, "reset"]) {
  test(`transient submit ${status} survives a recorded round and succeeds with the same write id`, async () => {
    const fake = await startFakeSmithers()
    try {
      let cursor = retryCursor(fake)
      fake.script((method: string, path: string) => method === "POST" && path.endsWith("/writes"), [[status, { code: "unavailable" }, {}]])
      cursor = await replayRound(cursor)
      assert.equal(cursor.waitMs, 2000)
      assert.equal(cursor.submitted, false)
      cursor = await replayRound(cursor)
      assert.equal(cursor.submitted, true)
      cursor = await replayRound(cursor)
      assert.equal(cursor.stage, "link")
      assert.equal(fake.writes.size, 1)
      assert.equal(new Set(fake.posts(/writes$/).map(entry => entry.writeId)).size, 1)
    } finally { await fake.close() }
  })
}
for (const stage of ["create", "link", "work"] as const) {
  test(`transient ${stage} watch or links preserves state, honors Retry-After cap and exponential backoff`, async () => {
    const fake = await startFakeSmithers()
    try {
      let cursor = retryCursor(fake, { stage, number: stage === "create" ? null : 11 })
      if (stage !== "work") cursor = await replayRound(cursor)
      fake.script((method: string, path: string) => stage === "work" ? path.endsWith("/links") : method === "GET" && path.includes("/writes/"),
        [[503, {}, { "retry-after": "999999" }], [503, {}, {}], [503, {}, { "retry-after": "invalid" }]])
      cursor = await replayRound(cursor)
      assert.equal(cursor.waitMs, 300000)
      assert.equal(cursor.submitted, stage !== "work")
      cursor = await replayRound(cursor)
      assert.equal(cursor.waitMs, 4000)
      cursor = await replayRound(cursor)
      assert.equal(cursor.waitMs, 8000)
      cursor = await replayRound(cursor)
      assert.equal(cursor.stage, stage === "create" ? "link" : stage === "link" ? "work" : "create")
      assert.equal(cursor.waitMs, 0)
    } finally { await fake.close() }
  })
}
test("503 forever exhausts a bounded recorded retry budget with a named cause", async () => {
  const fake = await startFakeSmithers()
  try {
    let cursor = retryCursor(fake)
    fake.script((method: string, path: string) => method === "POST" && path.endsWith("/writes"), Array.from({ length: 50 }, () => [503, { code: "unavailable" }, {}]))
    let failure: unknown
    for (let i = 0; i < 20; i++) {
      try { cursor = await replayRound(cursor) } catch (error) { failure = error; break }
    }
    assert.equal((failure as { code?: string })?.code, "unavailable_exhausted")
    assert.match((failure as Error).message, /create.*12 attempts/)
    assert.match((failure as Error).message, /after the outage, start a fresh run of the same plan; key markers dedupe/)
    assert.equal(fake.posts(/writes$/).length, 12)
  } finally { await fake.close() }
})
for (const status of [400, 404, 409, 413, 422]) {
  for (const stage of ["create", "link", "work"] as const) {
    test(`permanent HTTP ${status} fails only the row at ${stage}`, async () => {
      const fake = await startFakeSmithers()
      try {
        const cursor = retryCursor(fake, { stage, number: stage === "create" ? null : 11 })
        fake.script((method: string, path: string) => method === "POST", [[status, { code: "invalid" }, {}]])
        const next = await replayRound(cursor)
        assert.equal(next.index, cursor.index + 1)
        assert.deepEqual(next.exceptions, [`draft:retry:1:${stage}: refused: HTTP ${status} invalid`])
        assert.equal(fake.log.filter(entry => entry.method === "POST").length, 1)
      } finally { await fake.close() }
    })
  }
}
for (const status of [401, 403]) {
  test(`permanent HTTP ${status} fails on the first step`, async () => {
    const fake = await startFakeSmithers()
    try {
      const cursor = retryCursor(fake)
      fake.script((method: string, path: string) => method === "POST" && path.endsWith("/writes"), [[status, {}, {}]])
      await assert.rejects(step(cursor), { code: "refused", message: `create refused: HTTP ${status}` })
      assert.equal(fake.posts(/writes$/).length, 1)
    } finally { await fake.close() }
  })
}
for (const status of [503, "reset"]) {
  test(`verify ${status} reports unavailable without blaming the token`, async () => {
    const fake = await startFakeSmithers()
    try {
      fake.script((method: string, path: string) => method === "GET" && path.includes("/writes/"), [[status, {}, {}]])
      const exit = await run(fake, planRows([]))
      assert.ok(Exit.isFailure(exit))
      assert.match(JSON.stringify(exit.cause), /identity verification unavailable: HTTP \d+: after the outage, start a fresh run of the same plan/)
      assert.doesNotMatch(JSON.stringify(exit.cause), /not live/)
      assert.equal(fake.writes.size, 0)
    } finally { await fake.close() }
  })
}
for (const status of [400, 404, 413, 422, 401, 403]) {
  test(`shape HTTP ${status} follows row refusal or token fatality policy`, async () => {
    const fake = await startFakeSmithers()
    try {
      const cursor = retryCursor(fake)
      fake.script((method: string, path: string) => path === "/api/shapes/items", [[status, { code: "invalid" }, {}]])
      if ([401, 403].includes(status)) await assert.rejects(step(cursor), { code: "refused" })
      else {
        const next = await replayRound(cursor)
        assert.equal(next.index, cursor.index + 1)
        assert.deepEqual(next.exceptions, [`draft:retry:1:create: refused: HTTP ${status} invalid`])
      }
      assert.equal(fake.posts(/writes$/).length, 0)
    } finally { await fake.close() }
  })
}
test("a permanent shape lookup failure skips its descendants and still files another branch", async () => {
  const fake = await startFakeSmithers()
  try {
    fake.afterWrite = (write: { title?: string }) => {
      if (write.title === "Root") fake.script((method: string, path: string) => path === "/api/shapes/items", [[404, { code: "not_found" }, {}]])
    }
    const report = ok(await run(fake, [node("tree:root", "Root", undefined, 1), node("tree:bad", "Bad", "tree:root", 2),
      node("tree:good", "Good", "tree:root", 2), issue("draft:bad", "Bad child", "acme/plan", { parent: "tree:bad" }),
      issue("draft:good", "Good child", "acme/plan", { parent: "tree:good" }), { type: "summary", maxDepth: 3 }]))
    assert.deepEqual(report.exceptions, ["tree:bad:create: refused: HTTP 404 not_found", "draft:bad:create: no parent: tree:bad failed"])
    assert.deepEqual([...fake.writes.values()].filter(write => write.op === "issue/create").map(write => write.title), ["Root", "Good", "Good child"])
  } finally { await fake.close() }
})
test("503 submit recovers through the actual flow's durable round timer", async () => {
  const fake = await startFakeSmithers()
  try {
    fake.script((method: string, path: string) => method === "POST" && path.endsWith("/writes"), [[503, { code: "unavailable" }, {}]])
    ok(await run(fake, planRows([])))
    const posts = fake.posts(/writes$/)
    assert.ok(posts[1].at - posts[0].at >= 1900)
    assert.equal(posts[0].writeId, posts[1].writeId)
  } finally { await fake.close() }
})
for (const status of [503, "reset"]) {
  test(`shape ${status} and relate submit unavailability return durable retry outcomes`, async () => {
    const fake = await startFakeSmithers()
    try {
      let cursor = retryCursor(fake)
      fake.script((method: string, path: string) => path === "/api/shapes/items", [[status, {}, {}]])
      cursor = await replayRound(cursor)
      assert.equal(cursor.waitMs, 2000)
      cursor = await replayRound(cursor)
      cursor = await replayRound(cursor)
      assert.equal(cursor.stage, "link")
      fake.script((method: string, path: string) => method === "POST" && path.endsWith("/writes"), [[503, {}, {}]])
      cursor = await replayRound(cursor)
      assert.equal(cursor.waitMs, 2000)
      assert.equal(cursor.submitted, false)
      cursor = await replayRound(cursor)
      assert.equal(cursor.submitted, true)
      cursor = await replayRound(cursor)
      assert.equal(cursor.stage, "work")
    } finally { await fake.close() }
  })
}
test("Retry-After seconds, zero and HTTP dates are capped; successful pending looks retain the stage budget", async () => {
  const fake = await startFakeSmithers()
  try {
    let cursor = retryCursor(fake)
    cursor = await replayRound(cursor)
    fake.pending = () => true
    const date = new Date(Date.now() + 3600_000).toUTCString()
    fake.script((method: string, path: string) => method === "GET" && path.includes("/writes/"), [[503, {}, { "retry-after": date }], [200, { status: "pending" }, {}], [503, {}, { "retry-after": "0" }], [429, {}, { "retry-after": "3" }]])
    cursor = await replayRound(cursor)
    assert.equal(cursor.waitMs, 300000)
    cursor = await replayRound(cursor)
    assert.equal(cursor.retryCount, 1)
    cursor = await replayRound(cursor)
    assert.equal(cursor.waitMs, 0)
    cursor = await replayRound(cursor)
    assert.equal(cursor.waitMs, 3000)
    assert.equal(cursor.retryCount, 3)
  } finally { await fake.close() }
})

test("a shape body disconnect cannot advance its offset or duplicate a row filed by another lane", async () => {
  const fake = await startFakeSmithers()
  try {
    let cursor = retryCursor(fake)
    fake.shapeExtra.push({ repo: "acme/plan", key: "acme/plan#77", value: { number: "77", body: "key: draft:retry:1", title: "Retry", state: "closed", kind: "issue" } })
    fake.script((method: string, path: string) => path === "/api/shapes/items", [["reset-body", {}, {}]])
    cursor = await replayRound(cursor)
    assert.equal(cursor.stage, "create")
    assert.equal(cursor.waitMs, 2000)
    assert.equal(cursor.submitted, false)
    assert.equal(fake.writes.size, 0)
    cursor = await replayRound(cursor)
    assert.equal(cursor.stage, "link")
    assert.equal(cursor.number, 77)
    assert.equal(fake.writes.size, 0)
    assert.deepEqual(fake.log.filter(entry => entry.path === "/api/shapes/items").map(entry => entry.offset), ["-1", "-1"])
  } finally { await fake.close() }
})

test("the report retains every failed key beyond 500 exceptions", () => {
  const cursor = retryCursor({ origin: "http://unused" }, { exceptions: Array.from({ length: 500 }, (_, i) => `key:${i}:create: refused`), counts: { created: 0, linked: 0, queueLinks: 0, exceptions: 500 } })
  const next = advance(cursor, { number: null, submitted: false, kind: "refused", waitMs: 0, done: true, exception: "refused: HTTP 422 invalid", nodeKey: null, rowKey: "last:key" })
  assert.equal(next.exceptions.length, 501)
  assert.equal(next.exceptions[0], "key:0:create: refused")
  assert.equal(next.exceptions[500], "last:key:create: refused: HTTP 422 invalid")
})

test("outage exhaustion and verification unavailability are retryable faults; identity refusal stays permanent", () => {
  for (const code of ["unavailable", "unavailable_exhausted"]) {
    assert.equal(Fault.of(new FileRefused({ code, message: "unavailable" })).class, "infra")
  }
  assert.equal(Fault.of(new FileRefused({ code: "identity", message: "not live" })).class, "user")
})

test("an exhausted round settles without entering the engine's automatic infrastructure retry policy", { timeout: 4000 }, async (t) => {
  const fake = await startFakeSmithers()
  try {
    const cursor = retryCursor(fake, { retryCount: 11 })
    fake.script((method: string, path: string) => method === "POST" && path.endsWith("/writes"), Array.from({ length: 20 }, () => [503, {}, {}]))
    const exit = await Effect.runPromiseExit(Round.execute(cursor, { executionId: "exhausted-round" }).pipe(
      Effect.provide(Interpreter.layerWithImplementations(Round, layer).pipe(Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer)))
    ), { signal: t.signal })
    assert.ok(Exit.isFailure(exit))
    assert.match(JSON.stringify(exit.cause), /unavailable_exhausted/)
    assert.equal(fake.posts(/writes$/).length, 1)
  } finally { await fake.close() }
})
