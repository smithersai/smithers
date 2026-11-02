// The lane helper (ops/issues/track.mjs): identity, matching, links and sub-issues, against a recorded fetch.
import { describe, expect, test } from "vitest"
// @ts-expect-error: a plain .mjs script, untyped.
import { attach, clientOf, findMatch, identityOf, link, linkOf, normalizeTitle, open, parentRefOf, retryWaitOf, verifyIdentity } from "./track.mjs"

type Sent = { url: string; init: RequestInit }
const recorder = (answer: (url: string, init: RequestInit) => [number, unknown]) => {
  const sent: Array<Sent> = []
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, init })
    const [status, body] = answer(url, init)
    return new Response(JSON.stringify(body), { status })
  }
  return { sent, fetch }
}
const identity = { login: "agent-bot", cookie: "c=secret-cookie", personId: "p-1", runnerToken: "secret-runner", githubToken: "secret-gh" }

describe("the lane helper", () => {
  test("refuses to write without an identity file, without a login, or as a person", () => {
    const read = (body: string) => () => body
    expect(() => identityOf(undefined)).toThrow("no identity")
    expect(() => identityOf("/x", read("{}"), () => false)).toThrow("does not exist")
    expect(() => identityOf("/x", read("{}"), () => true)).toThrow("names no login")
    expect(() => identityOf("/x", read('{"login":"RoninJin10"}'), () => true)).toThrow("is a person's")
    expect(identityOf("/x", read('{"login":"agent-bot"}'), () => true)).toMatchObject({ login: "agent-bot" })
  })

  test("a dry run sends nothing and prints each request with its secrets named, not shown", async () => {
    const { sent, fetch } = recorder(() => [500, {}])
    const client = clientOf({ origin: "https://smithers.test", identity, dryRun: true, fetch })
    const result = await open(client, { repo: "acme/widgets", title: "Lint panics", body: "What and why.", key: "fuzz:a:1", labels: ["fuzz-finding"] })
    expect(sent).toEqual([])
    expect(result).toMatchObject({ number: null, reused: false, labelsApplied: true, missingLabels: [] })
    const printed = JSON.stringify(client.requests)
    for (const secret of ["secret-cookie", "secret-runner", "secret-gh", "p-1"]) expect(printed).not.toContain(secret)
    const create = client.requests.find((r: { method: string }) => r.method === "POST")
    expect(create.url).toBe("https://smithers.test/api/repos/acme/widgets/writes")
    expect(create.body).toMatchObject({ op: "issue/create", title: "Lint panics" })
    expect(create.body.body).toContain("key: fuzz:a:1\nlabels: fuzz-finding")
  })

  test("open applies its labels on GitHub, creating the missing ones, and keeps the body marker", async () => {
    const shape = [{ headers: { operation: "insert" }, key: "k4", value: { number: "4", kind: "issue", state: "open", title: "Lint panics", body: "x\nkey: fuzz:a:1\n" } }, { headers: { control: "up-to-date" } }]
    const run = async (createStatus: number) => {
      const { sent, fetch } = recorder((url, init) => {
        if (url.includes("/api/shapes/items")) return [200, shape]
        if (url.endsWith("/repos/acme/widgets/labels?per_page=100&page=1")) return [200, [{ name: "fuzz-finding" }]]
        if (url.endsWith("/repos/acme/widgets/labels") && init.method === "POST") return [createStatus, {}]
        if (url.endsWith("/issues/4/labels")) return [200, []]
        return [404, {}]
      })
      const client = clientOf({ origin: "https://smithers.test", identity, dryRun: false, fetch, githubEveryMs: 0 })
      const result = await open(client, { repo: "acme/widgets", title: "Lint panics", body: "x", key: "fuzz:a:1", labels: ["fuzz-finding", "migrate:alchemy"] })
      return { sent, result }
    }
    const created = await run(201)
    expect(created.result).toMatchObject({ number: 4, reused: true, by: "key", labelsApplied: true, missingLabels: [] })
    const apply = created.sent.find((s) => s.url.endsWith("/issues/4/labels"))!
    expect(JSON.parse(String(apply.init.body))).toEqual({ labels: ["fuzz-finding", "migrate:alchemy"] })
    expect((apply.init.headers as Record<string, string>).authorization).toBe("Bearer secret-gh")
    const refused = await run(403)
    expect(refused.result).toMatchObject({ labelsApplied: false, missingLabels: ["migrate:alchemy"] })
    expect(JSON.parse(String(refused.sent.find((s) => s.url.endsWith("/issues/4/labels"))!.init.body))).toEqual({ labels: ["fuzz-finding"] })
  })

  test("refuses to open an issue whose title can't be made clean, before any request", async () => {
    const client = clientOf({ origin: "https://smithers.test", identity, dryRun: true })
    await expect(open(client, { repo: "acme/widgets", title: "fails on nyc-07", body: "x" })).rejects.toThrow("title (host)")
    expect(client.requests).toEqual([])
  })

  test("reuses an open issue with the key marker, else the same normalized title, never a closed one", () => {
    const rows = [
      { number: "3", kind: "issue", state: "closed", title: "Lint panics", body: "key: k:1" },
      { number: "4", kind: "issue", state: "open", title: "Other", body: "text\nkey: k:1\n" },
      { number: "5", kind: "issue", state: "open", title: "`Lint` panics!", body: "" },
    ]
    expect(findMatch(rows, { title: "x", key: "k:1" })).toEqual({ number: 4, by: "key" })
    expect(findMatch(rows, { title: "lint  panics", key: "k:2" })).toEqual({ number: 5, by: "title" })
    expect(findMatch(rows, { title: "nothing", key: "k:3" })).toBeUndefined()
    expect(normalizeTitle("`Lint` panics.")).toBe("lint panics")
  })

  test("a lane link is a session link, and the runner token goes as a bearer only", async () => {
    expect(linkOf({ kind: "lane", ref: "fix-1", at: "t" })).toEqual({ kind: "session", ref: "lane:fix-1", label: "lane fix-1", at: "t" })
    expect(() => linkOf({ kind: "lane", ref: "x", state: "bogus" })).toThrow("--state")
    expect(() => linkOf({ kind: "queue", ref: "x", url: "http://x" })).toThrow("https")
    const { sent, fetch } = recorder(() => [200, { links: 1, changed: 1 }])
    const client = clientOf({ origin: "https://smithers.test", identity, dryRun: false, fetch })
    await link(client, { repo: "acme/widgets", issue: "12", kind: "queue", ref: "q-1", state: "queued", at: "2026-11-02T10:00:00.000Z" })
    expect(sent[0]!.url).toBe("https://smithers.test/api/repos/acme/widgets/issues/12/links")
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer secret-runner")
    expect(String(sent[0]!.init.body)).not.toContain("secret")
  })

  test("files a sub-issue by the child's id, across repositories of one owner, and refuses GitHub's limits", async () => {
    const answers = (total: number, ancestors: number) => recorder((url) => {
      if (url.endsWith("/sub_issues")) return [201, {}]
      const up = /issues\/(\d+)\/parent$/.exec(url)
      if (up !== null) return Number(up[1]) > 100 - ancestors ? [200, { number: Number(up[1]) - 1, url: `https://api.github.com/repos/acme/plan/issues/${Number(up[1]) - 1}` }] : [404, {}]
      if (url.endsWith("/issues/100")) return [200, { sub_issues_summary: { total } }]
      return [200, { id: 987654 }]
    })
    const ok = answers(3, 2)
    const placed = await attach(clientOf({ origin: "o", identity, dryRun: false, fetch: ok.fetch }), { child: { owner: "acme", name: "code", number: 7 }, parent: { owner: "acme", name: "plan", number: 100 } })
    expect(placed).toEqual({ parent: "acme/plan#100", depth: 4 })
    const post = ok.sent.find((s) => s.init.method === "POST")!
    expect(JSON.parse(String(post.init.body))).toEqual({ sub_issue_id: 987654 })
    expect((post.init.headers as Record<string, string>).authorization).toBe("Bearer secret-gh")
    const full = answers(100, 0)
    await expect(attach(clientOf({ origin: "o", identity, dryRun: false, fetch: full.fetch }), { child: { owner: "acme", name: "code", number: 7 }, parent: { owner: "acme", name: "plan", number: 100 } })).rejects.toMatchObject({ code: "children_limit" })
    const deep = answers(0, 7)
    await expect(attach(clientOf({ origin: "o", identity, dryRun: false, fetch: deep.fetch }), { child: { owner: "acme", name: "code", number: 7 }, parent: { owner: "acme", name: "plan", number: 100 } })).rejects.toMatchObject({ code: "depth_limit" })
    await expect(attach(clientOf({ origin: "o", identity, dryRun: true }), { child: { owner: "other", name: "code", number: 7 }, parent: { owner: "acme", name: "plan", number: 100 } })).rejects.toMatchObject({ code: "cross_owner" })
    expect(parentRefOf("acme/plan#12")).toEqual({ owner: "acme", name: "plan", number: 12 })
    expect(() => parentRefOf("acme/plan")).toThrow("--parent")
  })

  test("verifies who each credential belongs to before writing, and refuses a mismatch or a person", async () => {
    const check = (session: unknown, user: unknown) => {
      const { fetch } = recorder((url) => (url.endsWith("/api/auth/session") ? [200, session] : [200, user]))
      return verifyIdentity(clientOf({ origin: "https://smithers.test", identity, dryRun: false, fetch }), identity)
    }
    await expect(check({ signedIn: true, personId: "p-1", login: "agent-bot" }, { login: "Agent-Bot", id: 9 })).resolves.toMatchObject({ verified: true, personId: "p-1", githubId: 9 })
    await expect(check({ signedIn: false }, { login: "agent-bot" })).rejects.toThrow("not signed in")
    await expect(check({ signedIn: true, personId: "p-1", login: "other-bot" }, { login: "agent-bot" })).rejects.toThrow("belongs to other-bot")
    await expect(check({ signedIn: true, personId: "p-2", login: "agent-bot" }, { login: "agent-bot" })).rejects.toThrow("another person")
    await expect(check({ signedIn: true, personId: "p-1", login: "roninjin10" }, { login: "agent-bot" })).rejects.toThrow("belongs to a person")
    await expect(check({ signedIn: true, personId: "p-1", login: "agent-bot" }, { login: "roninjin10" })).rejects.toThrow("GitHub token belongs to a person")
    await expect(verifyIdentity(clientOf({ origin: "o", identity, dryRun: true }), identity)).resolves.toEqual({ verified: false })
  })

  test("paces GitHub-bound mutations 7.5 s apart and waits out a secondary rate limit", async () => {
    let clock = 0
    const waits: Array<number> = []
    const sleep = async (ms: number) => {
      waits.push(ms)
      clock += ms
    }
    let calls = 0
    const fetch = async () => {
      calls++
      return calls === 2
        ? new Response("{}", { status: 403, headers: { "retry-after": "61" } })
        : new Response("{}", { status: 201 })
    }
    const client = clientOf({ origin: "o", identity, dryRun: false, fetch, sleep, now: () => clock })
    await client.send({ method: "POST", url: "https://api.github.com/x", use: "github", body: {} })
    await client.send({ method: "POST", url: "https://api.github.com/y", use: "github", body: {} })
    expect(calls).toBe(3)
    expect(waits).toEqual([7500, 61000])
    await client.send({ url: "https://api.github.com/z", use: "github" })
    expect(waits).toHaveLength(2)
    const headers = (h: Record<string, string>) => new Headers(h)
    expect(retryWaitOf(403, headers({}), 60000)).toBeUndefined()
    expect(retryWaitOf(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "100" }), 60000, 40_000)).toBe(61_000)
    expect(retryWaitOf(429, headers({}), 60000)).toBe(60000)
  })

  test("attach looks first: the same parent is a no-op, another parent is refused unless replaced", async () => {
    const under = (number: number) => recorder((url) => {
      if (url.endsWith("/issues/7/parent")) return [200, { number, url: `https://api.github.com/repos/acme/plan/issues/${number}` }]
      if (url.endsWith("/sub_issues")) return [201, {}]
      if (url.endsWith("/parent")) return [404, {}]
      return [200, { id: 5, sub_issues_summary: { total: 1 } }]
    })
    const same = under(100)
    await expect(attach(clientOf({ origin: "o", identity, dryRun: false, fetch: same.fetch }), { child: { owner: "acme", name: "code", number: 7 }, parent: { owner: "acme", name: "plan", number: 100 } })).resolves.toEqual({ parent: "acme/plan#100", noop: true })
    expect(same.sent.some((s) => s.init.method === "POST")).toBe(false)
    const other = under(50)
    await expect(attach(clientOf({ origin: "o", identity, dryRun: false, fetch: other.fetch }), { child: { owner: "acme", name: "code", number: 7 }, parent: { owner: "acme", name: "plan", number: 100 } })).rejects.toMatchObject({ code: "has_parent" })
    expect(other.sent.some((s) => s.init.method === "POST")).toBe(false)
    const moved = under(50)
    await expect(attach(clientOf({ origin: "o", identity, dryRun: false, fetch: moved.fetch }), { child: { owner: "acme", name: "code", number: 7 }, parent: { owner: "acme", name: "plan", number: 100 }, replace: true })).resolves.toMatchObject({ replaced: "acme/plan#50" })
    expect(JSON.parse(String(moved.sent.find((s) => s.init.method === "POST")!.init.body))).toEqual({ sub_issue_id: 5, replace_parent: true })
  })
})
