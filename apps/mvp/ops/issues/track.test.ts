// The lane helper (ops/issues/track.mjs): tokens, matching, links and machine writes, against a recorded fetch.
import { describe, expect, test } from "vitest"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// @ts-expect-error: a plain .mjs script, untyped.
import { clientOf, comment, findMatch, laneFor, link, linkOf, normalizeTitle, open, parentRefOf, relate, repoOf, retryWrite, scopedWriteId, tokenFor, update } from "./track.mjs"

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
const client = (fetch: unknown) => clientOf({ origin: "https://smithers.test", dryRun: false, fetch, token: () => "smm_secret", lane: () => "fixer/lane-1" })
const sleep = async () => {}
const shape = (rows: Array<object> = []) => [...rows.map((value, i) => ({ headers: { operation: "insert" }, key: `k${i}`, value })), { headers: { control: "up-to-date" } }]

describe("the lane helper", () => {
  test("reads a repository's token from the file its map names, and refuses anything else", () => {
    const token = `smm_${"x".repeat(43)}`
    const files: Record<string, string> = { "/map": '{"acme/a":{"file":"/a","agent":"fixer","lane":"lane-1"},"acme/b":{"file":"/b","agent":"fixer","lane":"lane-1"}}', "/a": `${token}\n`, "/b": "ghp_notours\n" }
    const read = (path: string) => files[path]!
    expect(tokenFor("acme/a", read, "/map")).toBe(token)
    expect(() => tokenFor("acme/a", read, undefined)).toThrow("SMITHERS_ISSUE_TOKENS")
    expect(() => tokenFor("acme/c", read, "/map")).toThrow("no machine token for acme/c")
    expect(() => tokenFor("acme/b", read, "/map")).toThrow("holds no machine token")
  })

  test("a token file must be private and hold one whole token; no error quotes a token or its path", () => {
    const token = `smm_${"A".repeat(43)}`
    const dir = mkdtempSync(join(tmpdir(), "track-token-"))
    const file = (name: string, text: string, mode: number) => {
      const path = join(dir, name)
      writeFileSync(path, text, { mode })
      chmodSync(path, mode)
      return path
    }
    const lane = { agent: "fixer", lane: "lane-1" }
    const map = (entry: unknown, mode = 0o600) => file(`map-${Math.random()}`, JSON.stringify({ "acme/a": entry }), mode)
    expect(tokenFor("acme/a", undefined, map({ file: file("ok", `${token}\n`, 0o600), ...lane }))).toBe(token)
    expect(laneFor("acme/a", undefined, map({ file: file("ok3", `${token}\n`, 0o600), ...lane }))).toBe("fixer/lane-1")
    const refusals: Array<[string, () => unknown]> = [
      ["readable by others", () => tokenFor("acme/a", undefined, map({ file: file("open", `${token}\n`, 0o644), ...lane }))],
      ["readable by others", () => tokenFor("acme/a", undefined, map({ file: file("ok2", `${token}\n`, 0o600), ...lane }, 0o644))],
      ["holds no machine token", () => tokenFor("acme/a", undefined, map({ file: file("split", `${token.slice(0, 20)}\n${token.slice(20)}\n`, 0o600), ...lane }))],
      ["names a token", () => tokenFor("acme/a", undefined, map({ file: token, ...lane }))],
      ["can't be read", () => tokenFor("acme/a", undefined, map({ file: join(dir, "missing"), ...lane }))],
      ["is not { \"file\"", () => tokenFor("acme/a", undefined, map(file("bare", `${token}\n`, 0o600)))],
      ["names no agent and lane", () => tokenFor("acme/a", undefined, map({ file: file("ok4", `${token}\n`, 0o600), agent: "a/b", lane: "c" }))],
      ["names no agent and lane", () => laneFor("acme/a", undefined, map({ file: file("ok5", `${token}\n`, 0o600) }))],
    ]
    for (const [why, read] of refusals) {
      let message = ""
      try {
        read()
      } catch (error) {
        message = String((error as Error).message)
      }
      expect(message, why).toContain(why)
      expect(message).not.toContain(token.slice(4, 24))
      expect(message).not.toContain(dir)
    }
  })

  test("a repository name shaped like a credential is refused, and an update's state is open or closed", async () => {
    const token = `smm_${"E".repeat(43)}`
    expect(() => repoOf(`acme/${token}`)).toThrow("not a repository name")
    let message = ""
    try {
      repoOf(`acme/${token}`)
    } catch (error) {
      message = String((error as Error).message)
    }
    expect(message).not.toContain(token.slice(4, 24))
    const { fetch } = recorder(() => [202, {}])
    await expect(update(client(fetch), { repo: "acme/a", issue: 3, state: token, sleep })).rejects.toThrow("--state is open or closed")
  })

  test("a failed request answers a fixed message, never what fetch said about its headers", async () => {
    const token = `smm_${"B".repeat(43)}`
    const fetch = async () => {
      throw new TypeError(`Headers.append: "Bearer ${token}" is an invalid header value.`)
    }
    const failing = clientOf({ origin: "https://smithers.test", dryRun: false, fetch, token: () => token, lane: () => "fixer/lane-1" })
    await expect(failing.send({ repo: "acme/a", path: "/writes" })).rejects.toThrow("the request to https://smithers.test failed")
    await failing.send({ repo: "acme/a", path: "/writes" }).catch((error: Error) => expect(error.message).not.toContain(token))
  })

  test("write ids are scoped to the agent and lane, and the op: a new token retries the same write, another lane never shares one", async () => {
    const ids = async (token: string, lane: string) => {
      const { sent, fetch } = recorder((url, init) => (init.method === "POST" ? [202, {}] : [200, { status: "done", number: 3, failure: null }]))
      const c = clientOf({ origin: "https://smithers.test", dryRun: false, fetch, token: () => token, lane: () => lane })
      await relate(c, { repo: "acme/a", issue: 3, parent: "acme/a#1", sleep })
      return sent.filter((call) => call.init.method === "POST").map((call) => JSON.parse(String(call.init.body)).writeId)
    }
    const before = await ids(`smm_${"C".repeat(43)}`, "fixer/lane-1")
    expect(await ids(`smm_${"D".repeat(43)}`, "fixer/lane-1")).toEqual(before)
    expect(await ids(`smm_${"C".repeat(43)}`, "fixer/lane-2")).not.toEqual(before)
    expect(scopedWriteId("x", "issue/create", "acme/a", "link:k")).not.toBe(scopedWriteId("x", "issue/relate", "acme/a", "k"))
  })

  test("a dry run sends nothing and prints each request with the token named, not shown", async () => {
    const { sent, fetch } = recorder(() => [500, {}])
    const dry = clientOf({ origin: "https://smithers.test", dryRun: true, fetch, token: () => "smm_secret" })
    const result = await open(dry, { repo: "acme/widgets", title: "Lint panics", body: "What and why.", key: "fuzz:a:1", labels: ["fuzz-finding"], parent: "acme/plan#3" })
    expect(sent).toEqual([])
    expect(result).toMatchObject({ number: null, reused: false })
    expect(JSON.stringify(dry.requests)).not.toContain("smm_secret")
    const create = dry.requests.find((r: { method: string }) => r.method === "POST")
    expect(create.url).toBe("https://smithers.test/api/repos/acme/widgets/writes")
    expect(create.body).toMatchObject({ op: "issue/create", title: "Lint panics", labels: ["fuzz-finding"] })
    expect(create.body.body).toContain("key: fuzz:a:1\nlabels: fuzz-finding")
    expect(create.headers.authorization).toBe("Bearer [machine token for acme/widgets]")
  })

  test("refuses to open an issue whose title can't be made clean, before any request", async () => {
    const dry = clientOf({ origin: "https://smithers.test", dryRun: true })
    await expect(open(dry, { repo: "acme/widgets", title: "fails on nyc-07", body: "x" })).rejects.toThrow("title (host)")
    expect(dry.requests).toEqual([])
  })

  test("a keyed issue is found by its exact marker only, closed included; a same-title issue is never a receipt", () => {
    const rows = [
      { number: "3", kind: "issue", state: "closed", title: "Old", body: "text\nkey: k:1\n" },
      { number: "5", kind: "issue", state: "open", title: "`Lint` panics!", body: "key: k:10" },
    ]
    expect(findMatch(rows, { title: "x", key: "k:1" })).toEqual({ number: 3, by: "key" })
    expect(findMatch(rows, { title: "lint  panics", key: "k:2" })).toBeUndefined()
    // A lane opening an issue on purpose, with no key, may reuse an open issue of the same title.
    expect(findMatch(rows, { title: "lint  panics" })).toEqual({ number: 5, by: "title" })
    expect(findMatch(rows, { title: "old" })).toBeUndefined()
    expect(normalizeTitle("`Lint` panics.")).toBe("lint panics")
  })

  test("opens by a machine write with the token as a bearer, watches it settle, and files it under its parent", async () => {
    let looks = 0
    const { sent, fetch } = recorder((url, init) => {
      if (url.includes("/api/shapes/items")) return [200, shape()]
      if (init.method === "POST") return [202, {}]
      return [200, url.endsWith(String(firstWrite())) && looks++ === 0 ? { status: "pending", number: null, failure: null } : { status: "done", number: 12, failure: null }]
    })
    const firstWrite = () => JSON.parse(String(sent.find((s) => s.init.method === "POST")!.init.body)).writeId
    const result = await open(client(fetch), { repo: "acme/widgets", title: "Lint panics", body: "x", key: "k:1", parent: "acme/plan#3", sleep })
    expect(result).toMatchObject({ number: 12, reused: false, parent: "acme/plan#3" })
    const posts = sent.filter((s) => s.init.method === "POST")
    expect(posts.map((s) => JSON.parse(String(s.init.body)).op)).toEqual(["issue/create", "issue/relate"])
    expect(JSON.parse(String(posts[1]!.init.body))).toMatchObject({ number: 12, parent: { repo: "acme/plan", number: 3 } })
    expect((posts[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer smm_secret")
    expect(String(posts[0]!.init.body)).not.toContain("smm_secret")
    // The shape is public: it never carries the token.
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  test("reuses a keyed issue without writing, and says why a write was refused", async () => {
    const reuse = recorder(() => [200, shape([{ number: "4", kind: "issue", state: "closed", title: "Other", body: "key: k:1" }])])
    expect(await open(client(reuse.fetch), { repo: "acme/widgets", title: "Lint", body: "x", key: "k:1" })).toMatchObject({ number: 4, reused: true, by: "key" })
    expect(reuse.sent.filter((s) => s.init.method === "POST")).toEqual([])
    const refused = recorder((url, init) => (init.method === "POST" ? [202, {}] : [200, { status: "refused", failure: "has_parent", number: null }]))
    await expect(relate(client(refused.fetch), { repo: "acme/widgets", issue: 2, parent: "acme/plan#3", sleep })).rejects.toThrow("has_parent")
    const dead = recorder(() => [401, { code: "authentication" }])
    await expect(comment(client(dead.fetch), { repo: "acme/widgets", issue: 2, body: "hello", sleep })).rejects.toMatchObject({ exit: 3 })
    expect(parentRefOf("acme/plan#12")).toEqual({ owner: "acme", name: "plan", number: 12 })
    expect(() => parentRefOf("acme/plan")).toThrow("--parent")
  })

  test("updates by a machine write, refuses an empty one, and a failed write says how to run it again", async () => {
    const done = recorder((url, init) => (init.method === "POST" ? [202, {}] : [200, { status: "done", number: 3, failure: null }]))
    expect(await update(client(done.fetch), { repo: "acme/widgets", issue: 3, title: "Renamed", state: "closed", sleep })).toMatchObject({ number: 3 })
    expect(JSON.parse(String(done.sent[0]!.init.body))).toMatchObject({ op: "issue/update", number: 3, title: "Renamed", state: "closed" })
    await expect(update(client(done.fetch), { repo: "acme/widgets", issue: 3, sleep })).rejects.toThrow("--title")
    // Close, reopen, close: each is its own act, or the second close answers the first's receipt and does nothing.
    const repeated = recorder((url, init) => (init.method === "POST" ? [202, {}] : [200, { status: "done", number: 3, failure: null }]))
    for (const state of ["closed", "open", "closed"]) await update(client(repeated.fetch), { repo: "acme/widgets", issue: 3, state, sleep })
    const ids = repeated.sent.filter((call) => call.init.method === "POST").map((call) => JSON.parse(String(call.init.body)).writeId)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    const failed = recorder((url, init) => (init.method === "POST" ? [202, {}] : [200, { status: "failed", number: null, failure: "exhausted" }]))
    await expect(update(client(failed.fetch), { repo: "acme/widgets", issue: 3, title: "T", sleep })).rejects.toThrow("track.mjs retry --write")
    const again = recorder((url, init) => (init.method === "POST" ? [202, {}] : [200, { status: "done", number: 3, failure: null }]))
    expect(await retryWrite(client(again.fetch), { repo: "acme/widgets", writeId: "w-1", sleep })).toMatchObject({ number: 3 })
    expect(again.sent[0]!.url).toBe("https://smithers.test/api/repos/acme/widgets/writes/w-1/retry")
    const refused = recorder(() => [409, { code: "conflict" }])
    await expect(retryWrite(client(refused.fetch), { repo: "acme/widgets", writeId: "w-1", sleep })).rejects.toThrow("409 conflict")
  })

  test("a lane link is a session link with the token as a bearer", async () => {
    expect(linkOf({ kind: "lane", ref: "fix-1", at: "t" })).toEqual({ kind: "session", ref: "lane:fix-1", label: "lane fix-1", at: "t" })
    expect(() => linkOf({ kind: "lane", ref: "x", state: "bogus" })).toThrow("--state")
    expect(() => linkOf({ kind: "queue", ref: "x", url: "http://x" })).toThrow("https")
    const { sent, fetch } = recorder(() => [200, { links: 1, changed: 1 }])
    await link(client(fetch), { repo: "acme/widgets", issue: "12", kind: "queue", ref: "q-1", state: "queued", at: "2026-11-02T10:00:00.000Z" })
    expect(sent[0]!.url).toBe("https://smithers.test/api/repos/acme/widgets/issues/12/links")
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer smm_secret")
    expect(String(sent[0]!.init.body)).not.toContain("secret")
  })
})
