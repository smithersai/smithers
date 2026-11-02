// The work-links client (ops/work-links/link.mjs): what it sends and how it waits, against a recorded fetch.
import { describe, expect, test } from "vitest"
// @ts-expect-error: a plain .mjs script, untyped.
import { bodyOf, post } from "./link.mjs"

describe("the work-links client", () => {
  test("posts one link from flags, with the token as a bearer and never in the body", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = []
    const fetch = async (url: string, init: RequestInit) => {
      sent.push({ url, init })
      return new Response(JSON.stringify({ links: 1, changed: 1 }), { status: 200 })
    }
    const body = bodyOf({ kind: "queue", ref: "q-1", state: "queued", url: "https://q.example.test/q-1" }, undefined, () => "2026-11-02T10:00:00.000Z")
    const answer = await post({ origin: "https://smithers.test", repo: "acme/widgets", issue: "12", token: "secret-token", body, fetch })
    expect(answer).toEqual({ status: 200, answer: { links: 1, changed: 1 } })
    expect(sent[0]!.url).toBe("https://smithers.test/api/repos/acme/widgets/issues/12/links")
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer secret-token")
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ links: [{ kind: "queue", ref: "q-1", state: "queued", url: "https://q.example.test/q-1", at: "2026-11-02T10:00:00.000Z" }] })
    expect(String(sent[0]!.init.body)).not.toContain("secret-token")
  })

  test("reads a whole post from --json, and needs a kind and a ref otherwise", () => {
    expect(bodyOf({ json: "links.json" }, () => `{"links":[{"kind":"pr","ref":"7"}]}`)).toEqual({ links: [{ kind: "pr", ref: "7" }] })
    expect(() => bodyOf({ kind: "pr" })).toThrow("--kind and --ref are required")
  })

  test("waits out 429 and 503 by retry-after, else doubling, and gives up after five tries", async () => {
    const waits: Array<number> = []
    const statuses = [429, 503, 200]
    const fetch = async () => {
      const status = statuses.shift()!
      return new Response(status === 200 ? "{}" : "not json", { status, headers: status === 429 ? { "retry-after": "2" } : {} })
    }
    expect(await post({ origin: "o", repo: "a/b", issue: 1, token: "t", body: {}, fetch, sleep: async (ms: number) => void waits.push(ms) }))
      .toEqual({ status: 200, answer: {} })
    expect(waits).toEqual([2000, 10000])
    const always = async () => new Response("{}", { status: 503 })
    const given: Array<number> = []
    expect((await post({ origin: "o", repo: "a/b", issue: 1, token: "t", body: {}, fetch: always, sleep: async (ms: number) => void given.push(ms) })).status).toBe(503)
    expect(given).toEqual([5000, 10000, 20000, 40000])
  })
})
