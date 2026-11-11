// The work-links client (ops/work-links/link.mjs): what it sends and how it waits, against a recorded fetch.
import { describe, expect, test } from "vitest"
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
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

describe("work-link credential diagnostics", () => {
  const token = "synthetic-runner-credential"
  const invalid = "invalid runner token"
  const unavailable = "work link request failed"
  const request = { origin: "http://127.0.0.1:1", repo: "acme/widgets", issue: 12, body: {} }

  test("rejects empty tokens and every ASCII control or whitespace inside the credential before fetch", async () => {
    const separators = [...Array.from({ length: 33 }, (_, i) => String.fromCharCode(i)), "\x7f", "\u0080", "\u0100", "\u2028"]
    for (const malformed of [undefined, null, 12, "", ...separators.flatMap((separator) => [separator + token, token + separator, token + separator + "stray"])]) {
      await expect(post({ ...request, token: malformed })).rejects.toThrow(invalid)
    }
  })

  test("native fetch errors cannot expose credentials in their diagnostics or cause", async () => {
    // Native fetch includes this URL in its error because URLs containing credentials are refused.
    const result = await post({ ...request, origin: `http://user:${token}@127.0.0.1:1`, token }).catch((error: Error) => error)
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe(unavailable)
    expect(result.cause).toBeUndefined()
    expect(String(result)).not.toContain(token)
  })

  test.each([
    ["a token with a stray second line", `${token}\nstray`, "http://127.0.0.1:1", invalid],
    ["an empty token file", "\n", "http://127.0.0.1:1", invalid],
    ["a valid token with the usual trailing newline", `${token}\n`, `http://user:${token}@127.0.0.1:1`, unavailable],
  ])("CLI reports %s without printing the credential", async (_name, contents, origin, diagnostic) => {
    const dir = mkdtempSync(join(tmpdir(), "work-link-token-"))
    try {
      const file = join(dir, "token")
      writeFileSync(file, contents, { mode: 0o600 })
      const result = await promisify(execFile)(process.execPath, [
        new URL("./link.mjs", import.meta.url).pathname,
        "--repo", "acme/widgets", "--issue", "12", "--kind", "session", "--ref", "synthetic",
        "--origin", origin, "--token-file", file,
      ], { env: { PATH: process.env.PATH } }).catch((error: { code: number; stdout: string; stderr: string }) => error)
      expect(result).toMatchObject({ code: 1, stdout: "", stderr: `${diagnostic}\n` })
      expect(result.stderr).not.toContain(token)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
