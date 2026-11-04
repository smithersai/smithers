import { GitHub } from "@smthrs/integrations"
import { generateKeyPairSync, verify } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { main } from "./read-token.ts"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString()
const token = "ghs_read_fixture"
const expires_at = "2030-01-01T01:00:00Z"
const permissions = { metadata: "read", issues: "read" }
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const fixture = (respond?: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const dir = mkdtempSync(join(tmpdir(), "github-read-token-"))
  dirs.push(dir)
  const out = join(dir, "token")
  const stdout: string[] = [], stderr: string[] = []
  const sent: { url: string, init: RequestInit }[] = []
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    sent.push({ url, init })
    if (respond) return respond(url, init)
    return Response.json(url.endsWith("/installation") ? { id: 17 } : { token, expires_at, permissions })
  }
  const run = (args = ["--owner", "Acme", "--repo", "one", "--repo", "two", "--out", out], env: Record<string, string> = { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: pem }) =>
    main(args, { env, fetch, stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) })
  return { dir, out, sent, stdout, stderr, run }
}

test("requests exactly read metadata/issues and named repositories, signs a valid JWT and uses the Worker's User-Agent", async () => {
  const f = fixture()
  expect(await f.run()).toBe(0)
  expect(f.sent.map(x => new URL(x.url).pathname)).toEqual(["/users/Acme/installation", "/app/installations/17/access_tokens"])
  expect(JSON.parse(await new Response(f.sent[1]!.init.body).text())).toEqual({ permissions, repositories: ["one", "two"] })
  for (const { init } of f.sent) {
    const headers = new Headers(init.headers)
    expect(headers.get("user-agent")).toBe(GitHub.GitHubClient.USER_AGENT)
    expect(init.redirect).toBe("manual")
    const jwt = headers.get("authorization")!.replace(/^Bearer /i, "")
    const [head, body, signature] = jwt.split(".")
    expect(verify("RSA-SHA256", Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true)
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString())
    expect(claims.iss).toBe("123")
    expect(claims.exp - claims.iat).toBe(600)
  }
  expect(statSync(f.out).mode & 0o777).toBe(0o600)
  expect(readFileSync(f.out, "utf8")).toBe(`${token}\n`)
  expect(statSync(`${f.out}.json`).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(`${f.out}.json`, "utf8"))).toMatchObject({ owner: "Acme", repos: ["one", "two"] })
  expect(f.stdout).toHaveLength(1)
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ owner: "Acme", installation: 17, repos: ["one", "two"], permissions })
  expect(Date.parse(JSON.parse(f.stdout[0]!).expires_at)).toBe(Date.parse(expires_at))
  expect(f.stdout.join("") + f.stderr.join("")).not.toContain(token)
  expect(f.stdout.join("") + f.stderr.join("")).not.toContain(pem)
})

test("without --repo omits repositories and audits installation-wide scope", async () => {
  const f = fixture()
  expect(await f.run(["--owner", "acme", "--out", f.out])).toBe(0)
  expect(JSON.parse(await new Response(f.sent[1]!.init.body).text())).toEqual({ permissions })
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ repos: null })
})

test("finds an organization installation when the user endpoint returns 404", async () => {
  const f = fixture((url) => url.includes("/users/") ? new Response(null, { status: 404 }) :
    Response.json(url.endsWith("/installation") ? { id: 17 } : { token, expires_at }))
  expect(await f.run()).toBe(0)
  expect(f.sent.map(x => new URL(x.url).pathname)).toContain("/orgs/Acme/installation")
})

test("revoke needs no App credentials, sends DELETE with the file's token, prints only status", async () => {
  const f = fixture(() => new Response(null, { status: 204 }))
  writeFileSync(f.out, `${token}\n`, { mode: 0o600 })
  expect(await f.run(["--revoke", f.out], {})).toBe(0)
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]!.url).toBe("https://api.github.com/installation/token")
  expect(f.sent[0]!.init.method).toBe("DELETE")
  expect(new Headers(f.sent[0]!.init.headers).get("authorization")).toBe(`token ${token}`)
  expect(new Headers(f.sent[0]!.init.headers).get("user-agent")).toBe(GitHub.GitHubClient.USER_AGENT)
  expect(JSON.parse(f.stdout[0]!)).toEqual({ status: 204 })
  expect(f.stdout.join("") + f.stderr.join("")).not.toContain(token)
})

test.each([0o770, 0o707])("refuses writable parent %i before any request", async mode => {
  const f = fixture()
  chmodSync(f.dir, mode)
  expect(await f.run()).toBe(1)
  expect(f.sent).toHaveLength(0)
  expect(existsSync(f.out)).toBe(false)
  expect(f.stderr.join("")).toContain("parent")
})

test("never overwrites a token or follows an output symlink", async () => {
  const f = fixture()
  const target = join(f.dir, "target")
  writeFileSync(target, "unchanged")
  symlinkSync(target, f.out)
  expect(await f.run()).toBe(1)
  expect(f.sent).toHaveLength(0)
  expect(readFileSync(target, "utf8")).toBe("unchanged")
})

test("a pre-existing scope receipt is preserved without minting", async () => {
  const f = fixture()
  writeFileSync(`${f.out}.json`, "preserve", { mode: 0o600 })
  expect(await f.run()).toBe(1)
  expect(f.sent).toHaveLength(0)
  expect(existsSync(f.out)).toBe(false)
  expect(readFileSync(`${f.out}.json`, "utf8")).toBe("preserve")
})

test("escaped PEM newlines work and ambient personal credentials cannot override the App", async () => {
  const f = fixture()
  expect(await f.run(undefined, { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
    GITHUB_TOKEN: "personal_fixture", SMITHERS_GITHUB_API_BASE_URL: "https://untrusted.test" })).toBe(0)
  expect(f.sent.every(({ url, init }) => new URL(url).origin === "https://api.github.com" &&
    !new Headers(init.headers).get("authorization")?.includes("personal_fixture"))).toBe(true)
})

test("failed revocation prints just the upstream status", async () => {
  const f = fixture(() => Response.json({ message: token }, { status: 401 }))
  writeFileSync(f.out, `${token}\n`, { mode: 0o600 })
  expect(await f.run(["--revoke", f.out], {})).toBe(1)
  expect(f.stdout).toEqual(['{"status":401}'])
  expect(f.stderr).toEqual([])
})

test.each(["fetch", "response", "key"])("failure in %s never leaks secrets and leaves no usable output", async kind => {
  const f = fixture(() => {
    if (kind === "fetch") throw new Error(`authorization: ${token}; ${pem}`)
    return Response.json({ message: token, token }, { status: 500 })
  })
  const env = { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: kind === "key" ? `invalid ${token}` : pem }
  expect(await f.run(undefined, env)).toBe(1)
  expect(f.stdout.join("") + f.stderr.join("")).not.toContain(token)
  expect(f.stdout.join("") + f.stderr.join("")).not.toContain(pem)
  expect(existsSync(f.out)).toBe(false)
  expect(existsSync(`${f.out}.json`)).toBe(false)
  expect(JSON.parse(f.stderr[0]!)).toMatchObject({ event: "github_read_token.failed", stage: kind === "key" ? "authenticate" : "installation" })
})

test("refuses malformed names and missing flags without network access", async () => {
  for (const args of [[], ["--owner", "../bad", "--out", "/unused"], ["--owner", "acme", "--repo", "../bad", "--out", "/unused"]]) {
    const f = fixture()
    expect(await f.run(args)).toBe(1)
    expect(f.sent).toHaveLength(0)
  }
})

test("the documented plain Node executable loads without a test runner or credentials", () => {
  const run = spawnSync(process.execPath, [join(import.meta.dirname, "read-token.ts")], {
    encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 20_000,
  })
  expect(run.status).toBe(1)
  expect(run.stdout).toBe("")
  expect(run.stderr).toBe("--owner <owner> is required\n")
})
