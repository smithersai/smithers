// The importer's CLI (ops/issues/import.mjs), run as a child process with fake `gh` and `ssh` first on PATH. Each fake
// records its call; in draft mode any call is a failure, since an agent has the App's machine token and no personal
// GitHub login or lane-host key.
import { describe, expect, test } from "vitest"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const IMPORT = join(import.meta.dirname, "import.mjs")

const FAKE = `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs")
const { basename } = require("node:path")
const cmd = basename(process.argv[1])
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cmd, args }) + "\\n")
if (process.env.FAKE_FAIL === "1") {
  process.stderr.write("fake " + cmd + " called\\n")
  process.exit(1)
}
if (cmd === "ssh") {
  readFileSync(0)
  process.stdout.write(readFileSync(process.env.FAKE_SSH_OUT, "utf8"))
} else if (args[0] === "api") {
  process.stdout.write(args.includes("Accept: application/vnd.github.raw")
    ? "FuzzData feature:a compiler VIP-7: match accepts a missing semicolon; lane vip-match\\n"
    : JSON.stringify([{ name: "data.txt" }]))
} else if (args[0] === "repo") {
  process.stdout.write(JSON.stringify([{ name: "hidden-repo" }]))
} else {
  process.exit(2)
}
`

type Row = { type: string; key?: string; [field: string]: unknown }
type Call = { cmd: string; args: Array<string> }

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "issues-import-"))
  const bin = join(dir, "bin")
  mkdirSync(bin)
  for (const name of ["gh", "ssh"]) {
    writeFileSync(join(bin, name), FAKE)
    chmodSync(join(bin, name), 0o755)
  }
  const file = (name: string, text: string) => {
    const path = join(dir, name)
    writeFileSync(path, text, { mode: 0o600 })
    return path
  }
  const log = file("calls.jsonl", "")
  const fetchLog = file("fetch.jsonl", "")
  const preload = file("fetch.mjs", `
import { appendFileSync } from "node:fs"
const replies = JSON.parse(process.env.FETCH_REPLIES || "{}")
globalThis.fetch = async (url, options) => {
  const repo = new URL(url).pathname.replace("/repos/", "")
  appendFileSync(process.env.FETCH_LOG, JSON.stringify({ url, ...options }) + "\\n")
  const reply = replies[repo] ?? { status: 200, body: { private: false } }
  if (reply.error) throw new Error("injected network failure")
  return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status: reply.status })
}
`)
  const privateRepos = file("private-repos.txt", "hidden-repo\n")
  // These tests' synthetic owners stand for owners a run ties to GitHub: their bare pairs are candidates.
  const watched = file("watched-owners.txt", "stranger\noutside\no\nacme\nother\n")
  // Every run names a private list unless a test removes it: with none, the importer plans nothing.
  const run = (args: Array<string>, env: Record<string, string | undefined> = {}) => {
    const out = join(dir, `plan-${Math.random().toString(36).slice(2)}.jsonl`)
    const result = spawnSync(process.execPath, ["--import", preload, IMPORT, "--out", out, ...(args.includes("--watched-owners") ? [] : ["--watched-owners", watched]), ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: join(dir, `home-${Math.random().toString(36).slice(2)}`), SMITHERS_PRIVATE_REPOS_FILE: privateRepos, ...env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FETCH_LOG: fetchLog },
    })
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call)
    writeFileSync(log, "")
    const plan = result.status === 0 ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row) : []
    const fetchCalls = readFileSync(fetchLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    writeFileSync(fetchLog, "")
    const summary = result.status === 0 ? JSON.parse(result.stdout) : undefined
    const reposFile = `${out}.repos.json`
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, calls, plan, out, fetchCalls, summary, reposFile, queueFile: out.replace(/(\.jsonl)?$/, ".queue-unlinked.jsonl") }
  }
  return { file, run, privateRepos }
}

const DRAFTS = JSON.stringify([
  { draft_id: "a", title: "t3code: the codemod drops a comment", body: "Seen in apps/server.", parent: "Example repos / t3code" },
  { draft_id: "b", title: "t3code: the Vite plugin misses a module", body: "A loader gap.", labels: ["tooling"] },
  { draft_id: "c", title: "t3code: fixed already", body: "Done.", state: "closed" },
])

describe("the importer's CLI", () => {
  test.each([[["--draft"]], [["--source", "fuzz"]]])("plans nothing without a private repository list (%j)", ([mode]) => {
    const { file, run } = setup()
    const drafts = file("t3code-drafts.json", DRAFTS)
    const args = mode === "--draft" ? ["--draft", `t3code=${drafts}`] : ["--source", "fuzz"]
    const { status, stderr, calls, fetchCalls } = run(args, { FAKE_FAIL: "1", SMITHERS_PRIVATE_REPOS_FILE: undefined })
    expect(status).not.toBe(0)
    expect(stderr).toContain("no private repository names")
    expect(calls).toEqual([])
    expect(fetchCalls).toEqual([])
  })
  test("draft mode reads only the named file, spawns no gh and no ssh, and plans exactly its open drafts", () => {
    const { file, run, privateRepos } = setup()
    const drafts = file("t3code-drafts.json", DRAFTS)
    const { status, stderr, calls, plan } = run(["--draft", `t3code=${drafts}`], { FAKE_FAIL: "1", SMITHERS_PRIVATE_REPOS_FILE: privateRepos })
    expect(calls).toEqual([])
    expect(stderr).toBe("")
    expect(status).toBe(0)
    const issues = plan.filter((row) => row.type === "issue")
    expect(issues.map((row) => [row.key, row.parent])).toEqual([["draft:t3code:a", "tree:repos:t3code"], ["draft:t3code:b", "tree:tooling"]])
    expect(plan.filter((row) => row.type === "queue-link" || row.type === "dropped")).toEqual([])
    expect(plan.filter((row) => row.type === "node").map((row) => row.key)).toContain("tree:ship-vibelang")
    expect(plan.at(-1)).toMatchObject({ type: "summary", issues: 2, bySource: { "draft:t3code": 2 }, laneReports: null, fuzzSource: null })
  })

  test("--previous keeps each issue under the parent the last plan filed it under", () => {
    const { file, run } = setup()
    const drafts = file("t3code-drafts.json", DRAFTS)
    const last = file("last-plan.jsonl", [
      { type: "node", key: "tree:repos:t3code:part-1", parent: "tree:repos:t3code" },
      { type: "issue", key: "draft:t3code:a", parent: "tree:repos:t3code:part-1" },
      { type: "summary" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n")
    const { status, stderr, plan } = run(["--draft", `t3code=${drafts}`, "--previous", last], { FAKE_FAIL: "1" })
    expect(stderr).toBe("")
    expect(status).toBe(0)
    expect(plan.filter((row) => row.type === "issue").map((row) => [row.key, row.parent])).toEqual([["draft:t3code:a", "tree:repos:t3code:part-1"], ["draft:t3code:b", "tree:tooling"]])
    expect(plan.find((row) => row.key === "tree:repos:t3code:part-1")).toMatchObject({ type: "node", parent: "tree:repos:t3code", depth: 4 })
  })

  test("counts every draft and plans only open rows, auditing skipped statuses and duplicate references privately", () => {
    const { file, run, privateRepos } = setup()
    const drafts = [
      { draft_id: "open", title: "Still open", status: "OPEN" },
      { draft_id: "missing", title: "Missing status" },
      { draft_id: "fixed", title: "Fixed", status: "resolved" },
      { draft_id: "nonbug", title: "Nonbug", status: "nonbug" },
      { draft_id: "alias", title: "Nonbug", status: "not_a_bug" },
      { draft_id: "dup-draft", title: "Duplicate", status: "dup", duplicate_of_draft: "open" },
      { draft_id: "dup-title", title: "Duplicate", status: "duplicate", duplicate_of_title: "Still open" },
      { draft_id: "dup", title: "Duplicate", status: "DUPLICATE", duplicate_of: "#42" },
      { draft_id: "closed", title: "Closed", state: "closed" },
    ]
    // Two files exercise aggregate counts; repeated titles must still appear individually in the audit.
    const first = file("mixed.jsonl", drafts.slice(0, 4).map((row) => JSON.stringify(row)).join("\n"))
    const second = file("more.json", JSON.stringify(drafts.slice(4)))
    const { status, stderr, stdout, calls, plan, out } = run([
      "--draft", `t3code=${first}`, "--draft", `t3code=${second}`, "--private-repos", privateRepos,
    ], { FAKE_FAIL: "1" })
    expect({ status, stderr, calls }).toEqual({ status: 0, stderr: "", calls: [] })
    expect(plan.filter((row) => row.type === "issue").map((row) => [row.key, row.status]))
      .toEqual([["draft:t3code:open", "open"], ["draft:t3code:missing", "open"]])
    const counts = { open: 2, fixed: 1, nonbug: 2, duplicate: 3, closed: 1 }
    expect(plan.at(-1)).toMatchObject({ statuses: counts, planned: 2 })
    expect(JSON.parse(stdout)).toMatchObject({ statuses: counts, planned: 2 })
    const skipped = `${out}.skipped.jsonl`
    expect(statSync(skipped).mode & 0o777).toBe(0o600)
    expect(readFileSync(skipped, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { key: "draft:t3code:fixed", status: "fixed" },
      { key: "draft:t3code:nonbug", status: "nonbug" },
      { key: "draft:t3code:alias", status: "nonbug" },
      { key: "draft:t3code:dup-draft", status: "duplicate", duplicate_of: "open" },
      { key: "draft:t3code:dup-title", status: "duplicate", duplicate_of: "Still open" },
      { key: "draft:t3code:dup", status: "duplicate", duplicate_of: "#42" },
      { key: "draft:t3code:closed", status: "closed" },
    ])
  })

  const token = `ghp_${"X".repeat(36)}`
  test.each([
    ["t3code", { draft_id: "bad", status: "maybe" }],
    ["t3code", { draft_id: token, status: "maybe" }],
    [token, { draft_id: "bad", status: "maybe" }],
    ["t3code", { draft_id: "bad", status: token }],
    ["t3code", { draft_id: "bad", state: token }],
    ["t3code", { draft_id: "bad", status: { access_token: token } }],
  ])("unknown status refuses the entire import with exit 2 and the row's position alone, without writing outputs: %s %j", (source, bad) => {
    const { file, run, privateRepos } = setup()
    const drafts = file("unknown.json", JSON.stringify([{ draft_id: "good", title: "Open" }, { title: "Unknown", ...bad }]))
    const { status, stderr, stdout, out, calls, fetchCalls } = run(["--draft", `${source}=${drafts}`, "--private-repos", privateRepos], { FAKE_FAIL: "1" })
    expect(status).toBe(2)
    expect(stderr).toBe("draft 1 row 2: unknown-status\n")
    expect(stdout).toBe("")
    expect(calls).toEqual([])
    expect(fetchCalls).toEqual([])
    expect(existsSync(out)).toBe(false)
    expect(existsSync(`${out}.skipped.jsonl`)).toBe(false)
  })

  test("an unknown status names its draft file by the position of its --draft option", () => {
    const { file, run, privateRepos } = setup()
    const first = file("good.json", JSON.stringify([{ draft_id: "good", title: "Open" }]))
    const second = file("bad.json", JSON.stringify([{ draft_id: "bad", title: "Unknown", status: "maybe" }]))
    const { status, stderr } = run(["--draft", `t3code=${first}`, "--draft", `t3code=${second}`, "--private-repos", privateRepos], { FAKE_FAIL: "1" })
    expect({ status, stderr }).toEqual({ status: 2, stderr: "draft 2 row 1: unknown-status\n" })
  })

  test.each([
    ["类型检查崩溃", "格式化错误"],
    ["Parser 类型检查崩溃", "Parser 格式化错误"],
    ["Ошибка типов", "Ошибка форматирования"],
    ["क", "कि"],
    ["!!!", "???"],
    ["🐛", "🎉"],
  ])("plans two issues for titles that differ only outside ASCII letters and digits: %j and %j", (first, second) => {
    const { file, run, privateRepos } = setup()
    const drafts = file("titles.json", JSON.stringify([{ draft_id: "first", title: first }, { draft_id: "second", title: second }]))
    const publicRepos = file("public-repos.txt", "smithersai/vibelang\nsmithersai/smithers\n")
    const { status, stderr, plan, fetchCalls, calls } = run(["--draft", `t3code=${drafts}`, "--private-repos", privateRepos, "--public-repos", publicRepos], { FAKE_FAIL: "1" })
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
    expect(fetchCalls).toEqual([])
    expect(calls).toEqual([])
    expect(plan.filter((row) => row.type === "issue").map((row) => row.title)).toEqual([first, second])
    expect(plan.filter((row) => row.type === "duplicate")).toEqual([])
  })

  test.each([
    ["Parser: fails", "PARSER fails"],
    ["Ошибка: типов", "ОШИБКА типов"],
    ["类型:检查", "类型 检查"],
  ])("still plans one issue for titles equal but for case and punctuation in any script: %j and %j", (first, second) => {
    const { file, run, privateRepos } = setup()
    const drafts = file("titles.json", JSON.stringify([{ draft_id: "first", title: first }, { draft_id: "second", title: second }]))
    const publicRepos = file("public-repos.txt", "smithersai/vibelang\nsmithersai/smithers\n")
    const { status, stderr, plan, fetchCalls, calls } = run(["--draft", `t3code=${drafts}`, "--private-repos", privateRepos, "--public-repos", publicRepos], { FAKE_FAIL: "1" })
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
    expect(fetchCalls).toEqual([])
    expect(calls).toEqual([])
    expect(plan.filter((row) => row.type === "issue").map((row) => row.title)).toEqual([first])
    expect(plan.filter((row) => row.type === "duplicate")).toHaveLength(1)
  })

  test("draft mode refuses a host:path draft and a run without private repository names, before any gh or ssh", () => {
    const { file, run, privateRepos } = setup()
    const remote = run(["--draft", "t3code=nyc-01:~/drafts/t3code.jsonl"], { FAKE_FAIL: "1", SMITHERS_PRIVATE_REPOS_FILE: privateRepos })
    expect(remote.calls).toEqual([])
    expect(remote.status).not.toBe(0)
    expect(remote.stderr).toContain("draft mode reads local files only")
    const unnamed = run(["--draft", `t3code=${file("d.json", DRAFTS)}`], { FAKE_FAIL: "1", SMITHERS_PRIVATE_REPOS_FILE: undefined })
    expect(unnamed.calls).toEqual([])
    expect(unnamed.status).not.toBe(0)
    expect(unnamed.stderr).toContain("no private repository names")
  })

  test("with no draft, it reads the lane host over ssh and main's fuzz gaps through gh, but never lists private repositories", () => {
    const { file, run } = setup()
    const sshOut = file("remote.jsonl", [
      JSON.stringify({ kind: "queue", entry: { id: "1-a", lane: "fix-a", at: "2026-11-01T00:00:00Z", state: "queued", issues: [12] } }),
      JSON.stringify({ kind: "lane-reports", count: 0, oldest: null, newest: null }),
    ].join("\n") + "\n")
    const { status, stderr, calls, plan } = run(["--host", "lanes"], { FAKE_SSH_OUT: sshOut })
    expect(stderr).toBe("")
    expect(status).toBe(0)
    expect(calls.map((call) => [call.cmd, call.args[0]])).toEqual([
      ["ssh", "-o"],
      ["gh", "api"],
      ["gh", "api"],
    ])
    expect(calls[0]!.args).toContain("lanes")
    expect(plan.filter((row) => row.type === "issue").map((row) => row.kind)).toEqual(["fuzz"])
    expect(plan.filter((row) => row.type === "queue-link").map((row) => row.key)).toEqual(["queue:1-a:12"])
  })
})


describe("anonymous repository confirmation", () => {
  const draft = (body: string, more = {}) => JSON.stringify([{ draft_id: "visibility", title: "Confirm repository visibility", body, ...more }])
  const issue = (plan: Row[]) => plan.find((row) => row.type === "issue")
  test("untied repository pairs are confirmed while prose alternatives survive", () => {
    const { file, run } = setup()
    const empty = file("no-watched.txt", "")
    const drafts = file("prose.json", draft("Compare node/bun, ts/tsx and effect/schema with somebody/thing."))
    const prose = run(["--draft", `sample=${drafts}`, "--watched-owners", empty])
    expect(prose.status).toBe(0)
    expect(prose.fetchCalls.map((call) => call.url.split("/repos/")[1])).toEqual(["smithersai/vibelang", "somebody/thing"])
    expect(issue(prose.plan)?.body).toContain("Compare node/bun, ts/tsx and effect/schema with somebody/thing.")
    const tied = run(["--draft", `sample=${drafts}`, "--watched-owners", file("watched-somebody.txt", "somebody\n")], { FETCH_REPLIES: JSON.stringify({ "somebody/thing": { status: 404 } }) })
    expect(tied.fetchCalls.map((call) => call.url.split("/repos/")[1])).toEqual(["smithersai/vibelang", "somebody/thing"])
    expect(issue(tied.plan)?.body).toContain("with [repo].")
  })

  test("scrubs an unlisted private repository invisible to the App and records its 404", () => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", draft("See stranger/hidden and https://github.com/stranger/hidden/issues/2."))}`], {
      FAKE_FAIL: "1", FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.calls).toEqual([])
    expect(issue(result.plan)?.body).not.toContain("stranger/hidden")
    expect(issue(result.plan)?.body).toContain("[repo]")
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(JSON.parse(readFileSync(result.reposFile, "utf8"))).toEqual(result.summary.repositories)
    expect(statSync(result.reposFile).mode & 0o777).toBe(0o600)
    expect(result.plan.at(-1)?.repositories).toEqual(result.summary.repositories)
  })

  test("keeps a confirmed public repository, dedupes case and URLs, and sends no credentials", () => {
    const { file, run } = setup()
    const body = "See stranger/open, STRANGER/Open and https://github.com/stranger/open/issues/1."
    const result = run(["--draft", `sample=${file("draft.json", draft(body))}`], { FAKE_FAIL: "1" })
    expect(result.status).toBe(0)
    expect(issue(result.plan)?.body).toContain(body)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/open", verdict: "public", reason: "HTTP 200 private:false" })
    const calls = result.fetchCalls.filter((call) => call.url === "https://api.github.com/repos/stranger/open")
    expect(calls).toHaveLength(1)
    for (const call of result.fetchCalls) {
      expect(call.method).toBe("GET")
      expect(call.redirect).toBe("error")
      expect(call.credentials).toBe("omit")
      const headers = new Headers(call.headers)
      expect(headers.get("user-agent")).toBeTruthy()
      expect([...headers.keys()].sort()).toEqual(["accept", "user-agent"])
    }
  })

  test.each([403, 429])("stops after HTTP %i and scrubs all unasked references", (status) => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", draft("smithersai/vibelang then stranger/limited then stranger/later."))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/limited": { status } }),
    })
    expect(result.status).toBe(0)
    expect(result.fetchCalls.some((call) => call.url.endsWith("/stranger/later"))).toBe(false)
    expect(issue(result.plan)?.body).toContain("smithersai/vibelang then [repo] then [repo].")
    const verdicts = result.summary.repositories
    expect(verdicts).toContainEqual({ repo: "stranger/limited", verdict: "unconfirmed", reason: `HTTP ${status}; rate limit` })
    expect(verdicts).toContainEqual({ repo: "stranger/later", verdict: "unconfirmed", reason: `not requested after HTTP ${status}` })
    const filed = JSON.stringify(result.plan.filter((row) => ["issue", "node", "queue-link"].includes(row.type)))
    expect(filed).not.toContain("stranger/limited")
    expect(filed).not.toContain("stranger/later")
  })

  test("an explicit private list overrides a public response, including a built-in public name", () => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", draft("See smithersai/alchemy and stranger/ui."))}`,
      "--private-repos", file("forced.txt", "alchemy\nstranger/ui\n")])
    expect(result.status).toBe(0)
    expect(issue(result.plan)?.body).not.toContain("smithersai/alchemy")
    expect(issue(result.plan)?.body).not.toContain("stranger/ui")
    for (const repo of ["smithersai/alchemy", "stranger/ui"]) {
      expect(result.summary.repositories).toContainEqual({ repo, verdict: "private", reason: "explicit private list" })
    }
  })

  test.each([
    [{ status: 500 }, "HTTP 500"],
    [{ error: true }, "network error"],
    [{ status: 200, raw: "not JSON" }, "invalid response"],
    [{ status: 200, body: {} }, "HTTP 200 without private:false"],
  ])("fails closed on an unverifiable reply %j", (reply, reason) => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", draft("stranger/unknown"))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/unknown": reply }),
    })
    expect(result.status).toBe(0)
    expect(issue(result.plan)?.body).not.toContain("stranger/unknown")
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/unknown", verdict: "unconfirmed", reason })
  })

  test("checks encoded references, exact fields, and duplicate drafts before discarding them", () => {
    const { file, run } = setup()
    const drafts = JSON.stringify([
      { draft_id: "a", title: "First", body: "stranger%2Fhidden" },
      { draft_id: "b", title: "Second", body: "ok", links: [{ kind: "review", ref: "stranger/hidden" }] },
      { draft_id: "b", title: "Duplicate", body: "stranger/duplicate" },
    ])
    const result = run(["--draft", `sample=${file("draft.json", drafts)}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 }, "stranger/duplicate": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    // The encoded body is redacted token by token in every reading; the link's exact ref drops its draft.
    expect(result.plan.filter((row) => row.type === "issue").map((row) => [row.key, String(row.body).split("\n")[0]])).toEqual([["draft:sample:a", "[repo]"]])
    expect(JSON.stringify(result.plan.filter((row) => row.type === "issue"))).not.toMatch(/stranger|%2F/i)
    expect(result.summary.repositories).toEqual(expect.arrayContaining([
      { repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" },
      { repo: "stranger/duplicate", verdict: "private", reason: "HTTP 404" },
    ]))
  })
})

describe("repository references outside issue bodies", () => {
  test("drops an unconfirmed destination and its generated tree instead of trusting the static public list", () => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "A draft", body: "A body" }]))}`], {
      FETCH_REPLIES: JSON.stringify({ "smithersai/vibelang": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.plan.filter((row) => ["node", "issue"].includes(row.type))).toEqual([])
    expect(result.summary.repositories).toContainEqual({ repo: "smithersai/vibelang", verdict: "private", reason: "HTTP 404" })
  })

  test("checks generated node bodies and private references in keys", () => {
    const { file, run } = setup()
    const rows = [
      { draft_id: "tracking", title: "Migrate t3code", role: "node", body: "See stranger/hidden", parent: "Example repos / t3code" },
      { draft_id: "stranger/hidden", title: "An ordinary draft", body: "Fine" },
    ]
    const result = run(["--draft", `t3code=${file("draft.json", JSON.stringify(rows))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    const node = result.plan.find((row) => row.key === "tree:repos:t3code")
    expect(node?.about).toContain("[repo]")
    expect(result.plan.filter((row) => row.type === "issue")).toEqual([])
  })

  test("reports references in discarded drafts and omits credentials from verdicts", () => {
    const { file, run } = setup()
    const synthetic = "ghp_0123456789abcdefABCDEF0123"
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([
      { title: "Closed", body: "stranger/closed", state: "closed" },
      { title: "Credentials", body: `https://github.com/stranger/${synthetic}?token=${synthetic}` },
    ]))}`])
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/closed", verdict: "public", reason: "HTTP 200 private:false" })
    expect(JSON.stringify(result.summary.repositories)).not.toContain(synthetic)
    expect(JSON.stringify(result.fetchCalls)).not.toContain(synthetic)
  })
})

describe("repository confirmation review regressions", () => {
  test.each([
    "https://github.com/smithersai/vibelang/../../stranger/hidden",
    "https://github.com/smithersai/vibelang/%2e%2e/%2e%2e/stranger/hidden",
    "https://github.com:443/stranger/hidden",
    String.raw`https://github.com/smithersai/vibelang/..\../stranger/hidden`,
    "[public](https://github.com/smithersai/vibelang)[private](https://github.com/stranger/hidden)",
  ])("checks the complete URL's actual destination: %s", (url) => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "URL destination", body: url }]))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(result.plan.find((row) => row.type === "issue")?.body).not.toContain("stranger/hidden")
  })

  test("checks object keys and never includes an untrusted key in diagnostics", () => {
    const { file, run } = setup()
    const synthetic = "ghp_0123456789abcdefABCDEF0123"
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([
      { title: "Private property", body: "Body", links: [{ kind: "review", ref: "safe", "stranger/hidden": "ok" }] },
      { title: "Credential property", body: "Body", links: [{ kind: "review", ref: "safe", [synthetic]: "stranger/hidden" }] },
    ]))}`], { FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }) })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(result.plan.filter((row) => row.type === "issue")).toEqual([])
    expect(JSON.stringify(result.summary)).not.toContain(synthetic)
    expect(JSON.stringify(result.plan.filter((row) => row.type === "dropped").map((row) => row.problems))).not.toContain(synthetic)
  })

  test("reports repository names even when another scrub rule redacts them", () => {
    const { file, run } = setup()
    // `mini` is also a host name the host rule masks; tied here as a watched owner.
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "A reference", body: "mini/public" }]))}`, "--watched-owners", file("mini.txt", "mini\n")])
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "mini/public", verdict: "public", reason: "HTTP 200 private:false" })
  })
})

describe("decoded URL credentials and controls", () => {
  test.each(["%73mm_", "%2573mm_", "smm%5f", "GHp_"])("never requests or reports a decoded credential: %s", (prefix) => {
    const { file, run } = setup()
    const tail = "a".repeat(43)
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([
      { title: "Encoded URL", body: `https://github.com/stranger/${prefix}${tail}` },
    ]))}`])
    expect(result.status).toBe(0)
    expect(JSON.stringify(result.fetchCalls)).not.toContain(tail)
    expect(JSON.stringify(result.summary.repositories)).not.toContain(tail)
    expect(readFileSync(result.reposFile, "utf8")).not.toContain(tail)
  })

  test.each(["\t", "\r", "\n"])("checks a URL destination across control character %j", (control) => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([
      { title: "URL control", body: `https://github.com/stranger/open/${control}../../stranger/hidden` },
    ]))}`], { FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }) })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(JSON.stringify(result.plan.filter((row) => ["node", "issue", "queue-link"].includes(row.type)))).not.toContain("stranger/hidden")
  })
})

test.each(["stranger/open", "https://github.com/stranger/open"])("keeps a confirmed public reference at the end of a body: %s", (body) => {
  const { file, run } = setup()
  const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "Public reference", body }]))}`])
  expect(result.status).toBe(0)
  expect(result.plan.filter((row) => row.type === "issue")).toHaveLength(1)
  expect(result.plan.find((row) => row.type === "issue")?.body).toContain(`${body}\n\nkey: draft:sample:`)
})

describe("credential context before candidate extraction", () => {
  test.each([
    "https://github.com/%67hp_PAYLOAD/repo",
    "https://github.com/%2567hp_PAYLOAD/repo",
    "%67hp_PAYLOAD/repo",
    "https://github.com/stranger/open?%74oken=privacy/PAYLOAD",
    "token%3A privacy/PAYLOAD",
  ])("never extracts a credential payload from %s", (template) => {
    const { file, run } = setup()
    const payload = "a".repeat(36)
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([
      { title: "Credential context", body: template.replace("PAYLOAD", payload) },
    ]))}`])
    expect(result.status).toBe(0)
    expect(JSON.stringify(result.fetchCalls)).not.toContain(payload)
    expect(JSON.stringify(result.summary.repositories)).not.toContain(payload)
    expect(readFileSync(result.reposFile, "utf8")).not.toContain(payload)
  })
})

describe("complete URLs and shared credential boundaries", () => {
  test("an embedded hostname cannot truncate the primary URL before normalization", () => {
    const { file, run } = setup()
    const body = "https://github.com/stranger/open/github.com/../../decoy/public"
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "Embedded hostname", body }]))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/decoy": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/decoy", verdict: "private", reason: "HTTP 404" })
    expect(result.plan.find((row) => row.type === "issue")?.body).toContain("[repo]")
    expect(result.plan.find((row) => row.type === "issue")?.body).not.toContain(body)
  })

  test.each([
    "https://github.com/_ghp_PAYLOAD/repo",
    "https://github.com/_GHp_PAYLOAD/repo",
    "https://github.com/%5fghp%5fPAYLOAD/repo",
    "https://github.com/stranger/_eyJaaaaaaaaaaaa.bbbbbbbbbbbb.PAYLOAD",
  ])("screens credential boundaries before extraction: %s", (template) => {
    const { file, run } = setup()
    const payload = "c".repeat(36)
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([
      { title: "Credential boundary", body: template.replace("PAYLOAD", payload) },
    ]))}`])
    expect(result.status).toBe(0)
    expect(JSON.stringify(result.fetchCalls)).not.toContain(payload)
    expect(JSON.stringify(result.summary.repositories)).not.toContain(payload)
    expect(readFileSync(result.reposFile, "utf8")).not.toContain(payload)
  })
})

describe("structured URL fields and opaque key blocks", () => {
  test("checks the complete URL field including literal spaces", () => {
    const { file, run } = setup()
    const url = "https://github.com/stranger/open/ /../../../stranger/hidden"
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([
      { title: "Spaced URL", body: "Body", links: [{ kind: "review", ref: "safe", url }] },
    ]))}`], { FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }) })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(result.plan.filter((row) => row.type === "issue")).toEqual([])
  })

  test.each([
    ["-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"],
    ["-----begin rsa private key-----", "-----end rsa private key-----"],
    ["-----BEGIN PGP PRIVATE KEY BLOCK-----", "-----END PGP PRIVATE KEY BLOCK-----"],
    ["-----BEGIN RSA PRIVATE KEY", ""],
    ["-----BEGIN%20RSA%20PRIVATE%20KEY-----", "-----END%20RSA%20PRIVATE%20KEY-----"],
  ])("never discovers repository-shaped private-key payloads: %s", (begin, end) => {
    const { file, run } = setup()
    const payload = "privacy/keypayload"
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([
      { title: "Private key", body: `${begin}\n${payload}\n${end}` },
    ]))}`])
    expect(result.status).toBe(0)
    expect(JSON.stringify(result.fetchCalls)).not.toContain(payload)
    expect(JSON.stringify(result.summary.repositories)).not.toContain(payload)
    expect(readFileSync(result.reposFile, "utf8")).not.toContain(payload)
  })

  test.each([404, 200])("resolves GitHub API repository URLs, status %i", (status) => {
    const { file, run } = setup()
    const url = "https://api.github.com/repos/stranger/example"
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "API reference", body: url }]))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/example": { status, body: { private: false } } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/example", verdict: status === 200 ? "public" : "private", reason: status === 200 ? "HTTP 200 private:false" : "HTTP 404" })
    if (status === 200) expect(result.plan.find((row) => row.type === "issue")?.body).toContain(url)
    else expect(result.plan.find((row) => row.type === "issue")?.body).not.toContain(url)
  })
})

describe("GitHub URL hosts", () => {
  test.each([
    "https://raw.github.com/stranger/hidden/main/file.txt",
    "https://codeload.github.com/stranger/hidden/zip/main",
    "https://api.github.com/prefix/open/../../repos/stranger/hidden",
  ])("checks the repository after host-aware URL normalization: %s", (url) => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "GitHub host", body: url }]))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(result.plan.find((row) => row.type === "issue")?.body).not.toContain("stranger/hidden")
  })

  test("refuses an unknown GitHub host instead of treating it as github.com", () => {
    const { file, run } = setup()
    const url = "https://unknown.github.com/stranger/open"
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "Unknown host", body: url }]))}`])
    expect(result.status).toBe(0)
    expect(result.plan.find((row) => row.type === "issue")?.body).not.toContain(url)
  })
})


describe("credential spans before destructive redaction", () => {
  test.each([
    "token: AAAAAAAAAAAAAAAA&#43;privacy/keypayload",
    "token: AAAAAAAAAAAAAAAA%2Bprivacy/keypayload",
    "token: ghp_AAAAAAAAAAAAAAAAAAAA+privacy/keypayload",
    "token&#58; AAAAAAAAAAAAAAAA&amp;#43;privacy/keypayload",
  ])("never discovers a suffix of a complete decoded credential: %s", (body) => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "Credential span", body }]))}`])
    expect(result.status).toBe(0)
    expect(JSON.stringify(result.fetchCalls)).not.toContain("privacy/keypayload")
    expect(JSON.stringify(result.summary.repositories)).not.toContain("privacy/keypayload")
    expect(readFileSync(result.reposFile, "utf8")).not.toContain("privacy/keypayload")
  })
})


describe("credential property context", () => {
  test.each([
    ["password", "privacy/keypayload"],
    ["pass%77ord", "privacy/keypayload"],
    ["apiKey", "privacy/keypayload"],
    ["access_token", ["privacy/keypayload"]],
    ["secrets", { nested: "privacy/keypayload" }],
    ["authorization", { nested: ["privacy/keypayload"] }],
  ])("keeps credential values opaque under %s", (key, value) => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([
      { title: "Credential property", state: "closed", [key]: value },
    ]))}`])
    expect(result.status).toBe(0)
    expect(JSON.stringify(result.fetchCalls)).not.toContain("privacy/keypayload")
    expect(JSON.stringify(result.summary.repositories)).not.toContain("privacy/keypayload")
    expect(readFileSync(result.reposFile, "utf8")).not.toContain("privacy/keypayload")
  })
})


test("refuses a credential-named property without probing its values or destination", () => {
  const { file, run } = setup()
  const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([
    { repo: "stranger/open", title: "Credential link", body: "stranger/open", links: [{ kind: "review", ref: "safe", password: "stranger/open" }] },
  ]))}`])
  expect(result.status).toBe(0)
  expect(result.plan.filter((row) => row.type === "issue")).toEqual([])
  expect(result.summary.repositories.some((entry: { repo: string }) => entry.repo === "stranger/open")).toBe(false)
})

describe("GitHub empty-port URLs", () => {
  test.each([
    ["body", "https://github.com:/stranger/hidden"],
    ["url", "https://github.com:/stranger/hidden"],
    ["body", "https://github.com%3A/stranger/hidden"],
    ["url", "https://github.com%3A/stranger/hidden"],
  ])("checks %s with empty port %s", (field, url) => {
    const { file, run } = setup()
    const row = field === "body" ? { title: "Empty port", body: url } : { title: "Empty port", body: "Body", links: [{ kind: "review", ref: "safe", url }] }
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([row]))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(JSON.stringify(result.plan.filter((row) => ["node", "issue", "queue-link"].includes(row.type)))).not.toContain("stranger/hidden")
    if (field === "url") expect(result.plan.filter((row) => row.type === "issue")).toEqual([])
  })
})


describe("lossless repository normalization", () => {
  test.each([
    ["body", "https://github.com/stranger/open."],
    ["url", "https://github.com/stranger/open."],
    ["url", "https://github.com/stranger/open%2e"],
  ])("does not authorize a trailing-dot destination through its public prefix: %s %s", (field, url) => {
    const { file, run } = setup()
    const row = field === "body" ? { title: "Trailing dot", body: url } : { title: "Trailing dot", body: "Body", links: [{ kind: "review", ref: "safe", url }] }
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([row]))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/open.": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/open.", verdict: "private", reason: "HTTP 404" })
    expect(JSON.stringify(result.plan.filter((row) => ["node", "issue", "queue-link"].includes(row.type)))).not.toContain(url)
    if (field === "url") expect(result.plan.filter((row) => row.type === "issue")).toEqual([])
  })

  test.each(["stranger/open.git", "open.git", "STRANGER/OPEN.GIT"])("normalizes a forced-private entry consistently: %s", (name) => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "Forced private", body: "stranger/open" }]))}`,
      "--private-repos", file("private.txt", name)])
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/open", verdict: "private", reason: "explicit private list" })
    expect(result.plan.find((row) => row.type === "issue")?.body).not.toContain("stranger/open")
  })
})


describe("complete destinations and source provenance", () => {
  test.each(["stranger/open.", "stranger/open.."])("checks the complete repo destination: %s", (repo) => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "Exact destination", body: "Body", repo }]))}`], {
      FETCH_REPLIES: JSON.stringify({ [repo]: { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo, verdict: "private", reason: "HTTP 404" })
    expect(result.plan.filter((row) => row.type === "issue")).toEqual([])
  })

  test.each([["title", 185], ["body", 7985]])("keeps original credential context across %s clipping", (field, count) => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([
      { title: "Clipped credential", body: "Body", [field]: "x".repeat(count) + " token: a/babcdefghijklmnop" },
    ]))}`])
    expect(result.status).toBe(0)
    expect(JSON.stringify(result.fetchCalls)).not.toContain("repos/a/")
    expect(result.summary.repositories.some((entry: { repo: string }) => entry.repo.startsWith("a/"))).toBe(false)
    expect(readFileSync(result.reposFile, "utf8")).not.toContain("a/babc")
  })
})


describe("original exact fields and normalized URL hosts", () => {
  test.each(["\t", "\r", "\n"])("rejects an original private title URL before whitespace normalization: %j", (control) => {
    const { file, run } = setup()
    const title = `https://github.com/stranger/open/${control}../../stranger/hidden`
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title, body: "Body" }]))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(result.plan.filter((row) => row.type === "issue")).toEqual([])
  })

  test.each([
    ["body", "https://ｇithub.com/stranger/hidden"],
    ["url", "https://ｇithub.com/stranger/hidden"],
    ["body", "https://github。com/stranger/hidden"],
    ["url", "https://github。com/stranger/hidden"],
    ["body", "https:/ｇithub.com/stranger/hidden"],
    ["url", "https:/ｇithub.com/stranger/hidden"],
  ])("checks normalized hosts in %s: %s", (field, url) => {
    const { file, run } = setup()
    const row = field === "body" ? { title: "Normalized host", body: url } : { title: "Normalized host", body: "Body", links: [{ kind: "review", ref: "safe", url }] }
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([row]))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(JSON.stringify(result.plan.filter((row) => ["node", "issue", "queue-link"].includes(row.type)))).not.toContain("stranger/hidden")
    if (field === "url") expect(result.plan.filter((row) => row.type === "issue")).toEqual([])
  })

  test("keeps an ordinary external URL without a repository lookup", () => {
    const { file, run } = setup()
    const url = "https://example.org/docs/page"
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "External link", body: url }]))}`])
    expect(result.status).toBe(0)
    expect(result.plan.find((row) => row.type === "issue")?.body).toContain(url)
    expect(result.summary.repositories).toEqual([{ repo: "smithersai/vibelang", verdict: "public", reason: "HTTP 200 private:false" }])
  })
})


describe("control-normalized credentials and protocol-relative URLs", () => {
  test.each(["\t", "\r", "\n", "%09", "&#9;"])("screens normalized credential context before all discovery: %j", (control) => {
    const { file, run } = setup()
    const payload = "a".repeat(20)
    const body = `https://github.com/gh${control}p_${payload}/repo`
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "Split credential", body }]))}`])
    expect(result.status).toBe(0)
    expect(JSON.stringify(result.fetchCalls)).not.toContain(payload)
    expect(JSON.stringify(result.summary.repositories)).not.toContain(payload)
    expect(readFileSync(result.reposFile, "utf8")).not.toContain(payload)
  })

  test.each(["body", "url"])("checks a protocol-relative normalized GitHub host in %s", (field) => {
    const { file, run } = setup()
    const url = "//ｇithub.com/stranger/hidden"
    const row = field === "body" ? { title: "Relative authority", body: url } : { title: "Relative authority", body: "Body", links: [{ kind: "review", ref: "safe", url }] }
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([row]))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(JSON.stringify(result.plan.filter((row) => ["node", "issue", "queue-link"].includes(row.type)))).not.toContain("stranger/hidden")
  })
})


describe("written references and operator source validation", () => {
  test.each(["body", "url"])("requires a verdict for written names before dot-segment resolution in %s", (field) => {
    const { file, run } = setup()
    const url = "https://github.com/stranger/hidden/../../stranger/open"
    const row = field === "body" ? { title: "Written reference", body: url } : { title: "Written reference", body: "Body", links: [{ kind: "review", ref: "safe", url }] }
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([row]))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(JSON.stringify(result.plan.filter((row) => ["node", "issue", "queue-link"].includes(row.type)))).not.toContain("stranger/hidden")
  })

  test.each(["\t", "\r"])("validates original operator findings before title normalization: %j", (control) => {
    const { file, run } = setup()
    const text = `### RC-1 [major] https://github.com/stranger/open/${control}../../stranger/hidden\nDetails\n`
    const remote = file("scoped.jsonl", JSON.stringify({ kind: "scoped", scope: "compiler", text }) + "\n")
    const result = run(["--source", "lane-host"], { FAKE_SSH_OUT: remote, FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }) })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(result.plan.filter((row) => row.type === "issue")).toEqual([])
  })
})


describe("private diagnostics and per-finding validation", () => {
  test("omits rejected credentials from every plan row and diagnostic", () => {
    const { file, run } = setup()
    const credential = "ghp_" + "a".repeat(36)
    const rows = [
      { title: credential, body: "Body" },
      { draft_id: credential, title: "First", body: "Body" },
      { draft_id: credential, title: "Duplicate", body: "Body" },
    ]
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify(rows))}`])
    expect(result.status).toBe(0)
    expect(result.plan.some((row) => row.type === "dropped")).toBe(true)
    expect(result.plan.some((row) => row.type === "duplicate")).toBe(true)
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(readFileSync(result.reposFile, "utf8")).not.toContain(credential)
  })

  test("keeps unrelated scoped findings and redacts a body path", () => {
    const { file, run } = setup()
    const text = "### RC-1 [major] Safe finding\nDetails in /tmp/private-log\n### RC-2 [major] https://github.com/stranger/open/\t../../stranger/hidden\nDetails\n### RC-3 [major] FIXED old finding\nstranger/hidden\n"
    const remote = file("scoped.jsonl", JSON.stringify({ kind: "scoped", scope: "compiler", text }) + "\n")
    const result = run(["--source", "lane-host"], { FAKE_SSH_OUT: remote, FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }) })
    expect(result.status).toBe(0)
    const issues = result.plan.filter((row) => row.type === "issue")
    expect(issues.map((row) => row.key)).toEqual(["review:compiler:RC-1"])
    expect(issues[0]?.body).toContain("[path]")
    expect(JSON.stringify(issues)).not.toContain("stranger/hidden")
  })

  test("keeps safe findings from another review file in the same round", () => {
    const { file, run } = setup()
    const remote = file("round.jsonl", [
      { kind: "round", reviewer: "astra", round: 2, text: "### ASTRA-1 [major] Safe finding\nA safe body\n" },
      { kind: "round", reviewer: "opus", round: 2, text: "### OPUS-1 [major] stranger/hidden\nBody\n" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n")
    const result = run(["--source", "lane-host"], { FAKE_SSH_OUT: remote, FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }) })
    expect(result.status).toBe(0)
    expect(result.plan.filter((row) => row.type === "issue").map((row) => row.key)).toEqual(["review:spec:r2-ASTRA-1"])
  })
})


test("omits credentials from unlinked queue diagnostics", () => {
  const { file, run } = setup()
  const credential = "ghp_" + "b".repeat(36)
  const remote = file("queue.jsonl", JSON.stringify({ kind: "queue", entry: {
    id: credential, lane: "held-fix", at: "2026-11-01T00:00:00Z", state: "held", reason: credential, issues: [],
  } }) + "\n")
  const result = run(["--source", "lane-host"], { FAKE_SSH_OUT: remote })
  expect(result.status).toBe(0)
  expect(JSON.stringify(result)).not.toContain(credential)
  expect(readFileSync(result.queueFile, "utf8")).not.toContain(credential)
})


describe("references after prose punctuation", () => {
  test.each([
    ["body", "See...stranger/hidden"],
    ["title", "See...stranger/hidden"],
    ["body", "...github.com/stranger/hidden"],
    ["title", "...github.com/stranger/hidden"],
    ["body", "See%2e%2e%2estranger%2fhidden"],
    ["body", "See.stranger/hidden"],
    ["body", "See...https://github.com/stranger/hidden"],
  ])("checks %s after punctuation: %s", (field, value) => {
    const { file, run } = setup()
    const result = run(["--draft", `sample=${file("draft.json", JSON.stringify([{ title: "Punctuation", body: "Body", [field]: value }]))}`], {
      FETCH_REPLIES: JSON.stringify({ "stranger/hidden": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.summary.repositories).toContainEqual({ repo: "stranger/hidden", verdict: "private", reason: "HTTP 404" })
    expect(JSON.stringify(result.plan.filter((row) => ["node", "issue", "queue-link"].includes(row.type)))).not.toContain(value)
    if (field === "title") expect(result.plan.filter((row) => row.type === "issue")).toEqual([])
  })
})

describe("review fixes at the CLI boundary", () => {
  test("checks tree destinations and --repo before draft references, and reports every unconfirmed name", () => {
    const { file, run } = setup()
    const draft = file("budget.json", JSON.stringify([{ title: "Paths remain useful", body: "apps/mvp/ops @effect/platform src/a/b.ts stranger/limited stranger/later" }]))
    const result = run(["--draft", `sample=${draft}`, "--repo", "other/target"], {
      FETCH_REPLIES: JSON.stringify({ "stranger/limited": { status: 429 } }),
    })
    expect(result.status).toBe(0)
    expect(result.fetchCalls.slice(0, 2).map((c) => c.url)).toEqual([
      "https://api.github.com/repos/smithersai/vibelang", "https://api.github.com/repos/other/target",
    ])
    expect(result.summary.unconfirmedRepositories).toEqual(["stranger/limited", "stranger/later"])
    expect(result.summary.repositoryRequests).toBe(result.fetchCalls.length)
    expect(result.plan.find((row) => row.type === "issue")?.body).toContain("apps/mvp/ops @effect/platform src/a/b.ts")
  })
  test("reads an exact mode-600 public allowlist, persists no forced grants, and refuses unsafe modes", () => {
    const { file, run } = setup()
    const draft = file("allow.json", JSON.stringify([{ title: "Allow references", body: "stranger/open stranger/hidden other/open" }]))
    const allowlist = file("public.txt", "stranger/open\nstranger/hidden\n")
    const denylist = file("private.txt", "stranger/hidden\n")
    const result = run(["--draft", `sample=${draft}`, "--public-repos", allowlist, "--private-repos", denylist], {
      FETCH_REPLIES: JSON.stringify({ "other/open": { status: 404 } }),
    })
    expect(result.status).toBe(0)
    expect(result.fetchCalls.some((c) => /stranger\/(open|hidden)$/.test(c.url))).toBe(false)
    expect(result.plan.find((row) => row.type === "issue")?.body).toContain("stranger/open [repo] [repo]")
    chmodSync(allowlist, 0o644)
    const refused = run(["--draft", `sample=${draft}`, "--public-repos", allowlist])
    expect(refused.status).not.toBe(0)
    expect(refused.fetchCalls).toEqual([])
    expect(refused.stderr).toContain("mode 600")
  })
  test("a second CLI process reuses public verdicts at the default cache path", () => {
    const { file, run } = setup()
    const home = mkdtempSync(join(tmpdir(), "import-home-"))
    const draft = file("cache.json", JSON.stringify([{ title: "Cached visibility", body: "stranger/open" }]))
    const first = run(["--draft", `sample=${draft}`], { HOME: home })
    expect(first.status).toBe(0)
    expect(first.fetchCalls.length).toBeGreaterThan(0)
    const second = run(["--draft", `sample=${draft}`], { HOME: home })
    expect(second.status).toBe(0)
    expect(second.fetchCalls).toEqual([])
    expect(second.summary.repositoryRequests).toBe(0)
    expect(second.plan.some((row) => row.type === "issue")).toBe(true)
    expect(statSync(join(home, ".cache/smithers/public-repos.json")).mode & 0o777).toBe(0o600)
  })
})

test("explicit draft destinations are prioritized before a body that stops confirmation", () => {
  const { file, run } = setup()
  const drafts = file("destinations.json", JSON.stringify([
    { title: "First destination", body: "stranger/limited", repo: "destination/first" },
    { title: "Second destination", body: "Body", repo: "destination/second" },
  ]))
  const result = run(["--draft", `sample=${drafts}`], { FETCH_REPLIES: JSON.stringify({ "stranger/limited": { status: 429 } }) })
  expect(result.status).toBe(0)
  expect(result.fetchCalls.slice(0, 3).map((c) => c.url)).toEqual([
    "https://api.github.com/repos/smithersai/vibelang", "https://api.github.com/repos/destination/first", "https://api.github.com/repos/destination/second",
  ])
  expect(result.plan.filter((row) => row.type === "issue").map((r) => r.repo)).toEqual(["destination/first", "destination/second"])
})
