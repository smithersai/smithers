import { GitHub } from "@smthrs/integrations"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"
import { afterEach, expect, test } from "vitest"
// @ts-expect-error: operator .mjs seam
import { githubRead, readPrivateToken } from "./githubRead.mjs"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const fixture = (statuses = [200], repos: string[] | null = null) => {
  const dir = mkdtempSync(join(tmpdir(), "github-read-consumer-"))
  dirs.push(dir)
  const file = join(dir, "token")
  const token = "ghs_consumer_fixture"
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  writeFileSync(`${file}.json`, JSON.stringify({ owner: "acme", repos, expires_at: "2030-01-01T00:00:00Z" }), { mode: 0o600 })
  const sent: { url: string, init: RequestInit }[] = []
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, init })
    return Response.json({ ok: true }, { status: statuses[Math.min(sent.length - 1, statuses.length - 1)] })
  }
  return { file, token, sent, fetch, env: { SMITHERS_GITHUB_READ_TOKEN_FILE: file } }
}

test("uses the token for covered owners only, case insensitively, and shares the Worker User-Agent", async () => {
  const f = fixture()
  const client = githubRead(f)
  await client.get("/repos/ACME/one/issues")
  await client.get("https://api.github.com/repos/other/two/issues")
  expect(new Headers(f.sent[0]!.init.headers).get("authorization")).toBe(`token ${f.token}`)
  expect(new Headers(f.sent[1]!.init.headers).has("authorization")).toBe(false)
  expect(f.sent.every(x => new Headers(x.init.headers).get("user-agent") === GitHub.GitHubClient.USER_AGENT && x.init.redirect === "manual" && x.init.method === "GET")).toBe(true)
  expect(JSON.stringify(client.summary())).not.toContain(f.token)
})

test("accepts a current-format installation token (long, with dots and dashes) and refuses one with a space", async () => {
  const dir = mkdtempSync(join(tmpdir(), "github-read-shape-"))
  dirs.push(dir)
  const file = join(dir, "token")
  // The shape GitHub mints today: ghs_ then about 390 characters of [A-Za-z0-9_.-].
  const token = `ghs_${"a1B_".repeat(40)}.${"x-Y9".repeat(40)}.${"zZ_-".repeat(15)}`
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  expect(readPrivateToken(file)).toBe(token)
  writeFileSync(file, "ghs_bad token\n", { mode: 0o600 })
  expect(() => readPrivateToken(file)).toThrow(/invalid/)
})

test("no token file means anonymous reads", async () => {
  const f = fixture()
  const client = githubRead({ fetch: f.fetch, env: {} })
  expect((await client.get("/repos/acme/one/issues")).status).toBe(200)
  expect(new Headers(f.sent[0]!.init.headers).has("authorization")).toBe(false)
})

test("respects repository narrowing and does not send auth to non-repository paths", async () => {
  const f = fixture([200], ["one"])
  const client = githubRead(f)
  for (const path of ["/repos/acme/two", "/users/acme", "/repos/acme/one/../two", "/repos/acme%2fother/one"]) await client.get(path)
  expect(f.sent.every(x => !new Headers(x.init.headers).has("authorization"))).toBe(true)
})

test.each([200, 401])("401 downgrades once, summary says token expired; subsequent reads stay anonymous (%i)", async status => {
  const f = fixture([401, status])
  const client = githubRead(f)
  expect((await client.get("/repos/acme/one/issues")).status).toBe(status)
  expect(f.sent).toHaveLength(2)
  expect(new Headers(f.sent[0]!.init.headers).has("authorization")).toBe(true)
  expect(new Headers(f.sent[1]!.init.headers).has("authorization")).toBe(false)
  expect(client.summary()).toMatchObject({ tokenExpired: true })
  await client.get("/repos/acme/one")
  expect(f.sent).toHaveLength(3)
  expect(new Headers(f.sent[2]!.init.headers).has("authorization")).toBe(false)
})

test("refuses foreign origins, userinfo, insecure URLs, and never follows redirects", async () => {
  const f = fixture([302])
  const client = githubRead(f)
  for (const path of ["https://evil.test/repos/acme/one", "http://api.github.com/repos/acme/one", "https://user@api.github.com/repos/acme/one"]) await expect(client.get(path)).rejects.toThrow()
  expect(f.sent).toHaveLength(0)
  expect((await client.get("/repos/acme/one")).status).toBe(302)
  expect(f.sent).toHaveLength(1)
})

test("unsafe token files and transport errors cannot echo credentials", async () => {
  const f = fixture()
  chmodSync(f.file, 0o644)
  await expect(githubRead(f).get("/repos/acme/one")).rejects.toThrow("private")
  expect(f.sent).toHaveLength(0)
  chmodSync(f.file, 0o600)
  const client = githubRead({ ...f, fetch: async () => { throw new Error(f.token) } })
  try { await client.get("/repos/acme/one"); expect.fail("must fail") } catch (error) {
    expect(String(error)).not.toContain(f.token)
  }
})

test("403 does not downgrade to anonymous", async () => {
  const f = fixture([403])
  const client = githubRead(f)
  expect((await client.get("/repos/acme/one")).status).toBe(403)
  expect(f.sent).toHaveLength(1)
  expect(client.summary()).toEqual({ authenticated: 1, anonymous: 0, tokenExpired: false })
})

test("an already expired receipt avoids authenticated requests and reports expiration", async () => {
  const f = fixture()
  writeFileSync(`${f.file}.json`, JSON.stringify({ owner: "acme", repos: null, expires_at: "2000-01-01T00:00:00Z" }))
  const client = githubRead(f)
  await client.get("/repos/acme/one")
  expect(new Headers(f.sent[0]!.init.headers).has("authorization")).toBe(false)
  expect(client.summary()).toEqual({ authenticated: 0, anonymous: 1, tokenExpired: true })
})

test("a malformed scope receipt never sends a credential or echoes its contents", async () => {
  const f = fixture()
  writeFileSync(`${f.file}.json`, f.token)
  try { await githubRead(f).get("/repos/acme/one"); expect.fail("must fail") } catch (error) {
    expect(String(error)).not.toContain(f.token)
  }
  expect(f.sent).toHaveLength(0)
})

test("malformed URLs cannot retain userinfo in error properties or inspection", async () => {
  const f = fixture()
  let failure: unknown
  try { await githubRead(f).get(`https://${f.token}@[`); expect.fail("must fail") } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect(inspect(failure)).not.toContain(f.token)
  expect(JSON.stringify(failure)).not.toContain(f.token)
  expect(String(failure)).toContain("GitHub reads require api.github.com HTTPS URLs")
  expect(f.sent).toHaveLength(0)
})

test("covers says whether a read would send the token, without sending one", async () => {
  const f = fixture([401, 200], ["one"])
  const client = githubRead(f)
  expect(client.covers("https://api.github.com/repos/ACME/one")).toBe(true)
  expect(client.covers("/repos/acme/two")).toBe(false)
  expect(client.covers("/repos/other/one")).toBe(false)
  expect(f.sent).toHaveLength(0)
  await client.get("/repos/acme/one")
  expect(client.covers("/repos/acme/one")).toBe(false)
})
