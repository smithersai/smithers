// Filing a plan (ops/issues/file.mjs): order, stages, and resuming from the state file without creating twice.
import { describe, expect, test } from "vitest"
// @ts-expect-error: a plain .mjs script, untyped.
import { fileAll, readState, rowsOf } from "./file.mjs"
// @ts-expect-error: a plain .mjs script, untyped.
import { clientOf } from "./track.mjs"

const identity = { login: "agent-bot", cookie: "c", personId: "p", runnerToken: "r", githubToken: "g" }
const plan = [
  { type: "node", key: "tree:root", repo: "acme/plan", title: "Ship it", about: "The goal." },
  { type: "issue", key: "draft:a:1", repo: "acme/plan", title: "A draft", body: "b", labels: ["x"], links: [{ kind: "session", ref: "lane:fix-1" }], parent: "tree:root" },
  { type: "issue", key: "queue:q-1", repo: "acme/code", title: "A queue entry", body: "b", labels: [], links: [], parent: "tree:root" },
  { type: "dropped", key: "z" },
]

/** A fake smithers.sh and GitHub: issues get numbers when created, and each issue has at most one parent. */
const world = () => {
  const issues: Array<{ repo: string; number: number; title: string; body: string; write_id: string }> = []
  const parents = new Map<string, string>()
  const mutations: Array<string> = []
  let failAttachOnce = true
  const fetch = async (url: string, init: RequestInit) => {
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
    if (init.method === "POST") mutations.push(url.replace(/^https:\/\/[^/]+/, ""))
    const shape = /\/api\/shapes\/items\?repo=([^&]+)/.exec(url)
    if (shape !== null) {
      const repo = decodeURIComponent(shape[1]!)
      const rows = issues.filter((i) => i.repo === repo).map((i) => ({ headers: { operation: "insert" }, key: `${repo}#${i.number}`, value: { ...i, number: String(i.number), kind: "issue", state: "open" } }))
      return new Response(JSON.stringify([...rows, { headers: { control: "up-to-date" } }]), { status: 200 })
    }
    const writes = /\/api\/repos\/([^/]+)\/([^/]+)\/writes$/.exec(url)
    if (writes !== null) {
      issues.push({ repo: `${writes[1]}/${writes[2]}`, number: issues.length + 1, title: body.title, body: body.body, write_id: body.writeId })
      return new Response(JSON.stringify({ writeId: body.writeId }), { status: 202 })
    }
    const parent = /repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/parent$/.exec(url)
    if (parent !== null) {
      const known = parents.get(`${parent[1]}/${parent[2]}#${parent[3]}`)
      if (known === undefined) return new Response("{}", { status: 404 })
      const [repo, number] = known.split("#")
      return new Response(JSON.stringify({ number: Number(number), url: `https://api.github.com/repos/${repo}/issues/${number}` }), { status: 200 })
    }
    const sub = /repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/sub_issues$/.exec(url)
    if (sub !== null) {
      if (failAttachOnce) {
        failAttachOnce = false
        throw new Error("connection reset")
      }
      const child = issues.find((i) => i.number === body.sub_issue_id)!
      parents.set(`${child.repo}#${child.number}`, `${sub[1]}/${sub[2]}#${sub[3]}`)
      return new Response("{}", { status: 201 })
    }
    const issue = /repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(url)
    if (issue !== null) return new Response(JSON.stringify({ id: Number(issue[3]), sub_issues_summary: { total: 0 } }), { status: 200 })
    if (/\/labels(\?|$)/.test(url)) return new Response(JSON.stringify(init.method === "POST" ? {} : []), { status: init.method === "POST" && !url.includes("/issues/") ? 201 : 200 })
    if (url.endsWith("/links")) return new Response(JSON.stringify({ links: body.links.length, changed: body.links.length }), { status: 200 })
    return new Response("{}", { status: 404 })
  }
  return { issues, parents, mutations, fetch }
}

describe("filing a plan", () => {
  test("files nodes then issues, attaches each under its parent, and resumes after a crash without creating twice", async () => {
    const w = world()
    const lines: Array<string> = []
    const record = (entry: object) => lines.push(JSON.stringify(entry))
    const client = () => clientOf({ origin: "https://smithers.test", identity, dryRun: false, fetch: w.fetch, sleep: async () => {}, githubEveryMs: 0, smithersEveryMs: 0 })
    const rows = rowsOf(plan)
    expect(rows.map((row: { key: string }) => row.key)).toEqual(["tree:root", "draft:a:1", "queue:q-1"])
    await expect(fileAll(client(), rows, { state: new Map(), record, sleep: async () => {} })).rejects.toThrow("connection reset")
    expect(w.issues.map((i) => i.title)).toEqual(["Ship it", "A draft"])
    const resumed = await fileAll(client(), rows, { state: readState(lines.join("\n")), record, sleep: async () => {} })
    expect(resumed.refused).toEqual([])
    expect(w.issues.map((i) => i.title)).toEqual(["Ship it", "A draft", "A queue entry"])
    expect([...w.parents.entries()]).toEqual([["acme/plan#2", "acme/plan#1"], ["acme/code#3", "acme/plan#1"]])
    expect(w.issues[1]!.body).toContain("key: draft:a:1")
    const before = w.mutations.length
    const again = await fileAll(client(), rows, { state: readState(lines.join("\n")), record, sleep: async () => {} })
    expect(again.done).toMatchObject({ created: 0, attached: 0, labeled: 0, linked: 0 })
    expect(w.mutations.length).toBe(before)
  })

  test("with its state file lost, the key marker finds each issue again instead of creating it", async () => {
    const w = world()
    const client = () => clientOf({ origin: "https://smithers.test", identity, dryRun: false, fetch: w.fetch, sleep: async () => {}, githubEveryMs: 0, smithersEveryMs: 0 })
    await fileAll(client(), rowsOf(plan), { state: new Map(), record: () => {}, sleep: async () => {} }).catch(() => undefined)
    const second = await fileAll(client(), rowsOf(plan), { state: new Map(), record: () => {}, sleep: async () => {} })
    expect(w.issues).toHaveLength(3)
    expect(second.done).toMatchObject({ reused: 2, created: 1 })
  })
})
