// The importer's CLI (ops/issues/import.mjs), run as a child process with fake `gh` and `ssh` first on PATH. Each fake
// records its call; in draft mode any call is a failure, since an agent has the App's machine token and no personal
// GitHub login or lane-host key.
import { describe, expect, test } from "vitest"
import { existsSync, statSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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
  const privateRepos = file("private-repos.txt", "hidden-repo\n")
  const run = (args: Array<string>, env: Record<string, string | undefined> = {}) => {
    const out = join(dir, `plan-${Math.random().toString(36).slice(2)}.jsonl`)
    const result = spawnSync(process.execPath, [IMPORT, "--out", out, ...args], {
      encoding: "utf8",
      env: { ...process.env, SMITHERS_PRIVATE_REPOS_FILE: undefined, ...env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log },
    })
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call)
    writeFileSync(log, "")
    const plan = result.status === 0 ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row) : []
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, calls, plan, out }
  }
  return { file, run, privateRepos }
}

const DRAFTS = JSON.stringify([
  { draft_id: "a", title: "t3code: the codemod drops a comment", body: "Seen in apps/server.", parent: "Example repos / t3code" },
  { draft_id: "b", title: "t3code: the Vite plugin misses a module", body: "A loader gap.", labels: ["tooling"] },
  { draft_id: "c", title: "t3code: fixed already", body: "Done.", state: "closed" },
])

describe("the importer's CLI", () => {
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

  test("unknown status refuses the entire import with exit 2 and its draft key, without writing outputs", () => {
    const { file, run, privateRepos } = setup()
    const drafts = file("unknown.json", JSON.stringify([
      { draft_id: "good", title: "Open" },
      { draft_id: "bad", title: "Unknown", status: "maybe" },
    ]))
    const { status, stderr, stdout, out, calls } = run(["--draft", `t3code=${drafts}`, "--private-repos", privateRepos], { FAKE_FAIL: "1" })
    expect(status).toBe(2)
    expect(stderr).toContain('draft:t3code:bad has unknown status "maybe"')
    expect(stdout).toBe("")
    expect(calls).toEqual([])
    expect(existsSync(out)).toBe(false)
    expect(existsSync(`${out}.skipped.jsonl`)).toBe(false)
  })

  test("draft mode refuses a host:path draft and a run without private repository names, before any gh or ssh", () => {
    const { file, run, privateRepos } = setup()
    const remote = run(["--draft", "t3code=nyc-01:~/drafts/t3code.jsonl"], { FAKE_FAIL: "1", SMITHERS_PRIVATE_REPOS_FILE: privateRepos })
    expect(remote.calls).toEqual([])
    expect(remote.status).not.toBe(0)
    expect(remote.stderr).toContain("draft mode reads local files only")
    const unnamed = run(["--draft", `t3code=${file("d.json", DRAFTS)}`], { FAKE_FAIL: "1" })
    expect(unnamed.calls).toEqual([])
    expect(unnamed.status).not.toBe(0)
    expect(unnamed.stderr).toContain("SMITHERS_PRIVATE_REPOS_FILE")
  })

  test("with no draft, it reads the lane host over ssh and main's fuzz gaps and the private repository list through gh", () => {
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
      ["gh", "repo"],
      ["gh", "repo"],
    ])
    expect(calls[0]!.args).toContain("lanes")
    expect(plan.filter((row) => row.type === "issue").map((row) => row.kind)).toEqual(["fuzz"])
    expect(plan.filter((row) => row.type === "queue-link").map((row) => row.key)).toEqual(["queue:1-a:12"])
  })
})
