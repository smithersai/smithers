import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, expect, test, vi } from "vitest"
import { run as smoke } from "./deploy-smoke/run.ts"
import { run as confirm } from "./feed-barrier/confirm.ts"
import { clientOf } from "./issues/track.mjs"
import { run as expire } from "./role-age/expire.ts"
import { run as cutover } from "./runner-cutover/cutover.ts"
import { refuseUncheckedTls } from "./tls.mjs"
import { post } from "./work-links/link.mjs"

const off = { NODE_TLS_REJECT_UNAUTHORIZED: "0" }

test("TLS checks off: refused, whatever the target; on: nothing is", () => {
  expect(() => refuseUncheckedTls(off)).toThrow("TLS checks are turned off")
  for (const env of [{}, { NODE_TLS_REJECT_UNAUTHORIZED: "1" }]) expect(() => refuseUncheckedTls(env)).not.toThrow()
})

test.each<[string, (fetch: typeof globalThis.fetch, io: { out: (line: string) => void; err: (line: string) => void }) => Promise<number>]>([
  ["confirm", (fetch, io) => confirm(["--by", "x", "--release", "r"], { ...off, DATABASE_URL: "postgres://u:hunter2@localhost/d" }, io, fetch)],
  ["expire", (fetch, io) => expire(["--repo", "o/n", "--person", "p"], { ...off, DATABASE_URL: "postgres://u:hunter2@localhost/d" }, io, fetch)],
  ["cutover", (fetch, io) => cutover(["--by", "x", "--release", "r", "--worker", "w"], { ...off, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", APP_DOMAIN: "localhost" }, io, fetch)],
  ["the deploy smoke", (fetch, io) => smoke({ ...off, APP_DOMAIN: "x.test", NEON_API_KEY: "k", NEON_ORG_ID: "o" }, io.out, io.err, fetch)],
])("%s runs nothing with TLS checks off, even at this machine", async (_name, run) => {
  const said: Array<string> = []
  let asked = 0
  const fetch = (async () => {
    asked++
    return new Response("{}")
  }) as unknown as typeof globalThis.fetch
  expect(await run(fetch, { out: (line) => void said.push(line), err: (line) => void said.push(line) })).not.toBe(0)
  expect(asked).toBe(0)
  expect(said.join()).toContain("TLS checks are turned off")
  expect(said.join()).not.toContain("hunter2")
})

test.each(["issues/track.mjs", "issue-tracking/seed.mjs", "work-links/link.mjs"])("%s, run as a script, stops with TLS checks off", async (script) => {
  const path = new URL(script, import.meta.url).pathname
  const failed = await promisify(execFile)(process.execPath, ["--import=vibelang/register", path, "--origin", "https://localhost:1443"], { env: { PATH: process.env.PATH, ...off } }).catch((error: { code: number; stderr: string }) => error)
  expect(failed).toMatchObject({ code: 1, stderr: expect.stringContaining("TLS checks are turned off") })
})

test.each([
  { script: "issues/render-fixtures.mjs", stream: "stderr" },
  { script: "machine-token/issue.ts", stream: "stderr" },
  { script: "auth/session-keys.ts", stream: "stdout" },
] as const)("$script refuses unchecked TLS before arguments, config or network access", async ({ script, stream }) => {
  const path = new URL(script, import.meta.url).pathname
  const result = await promisify(execFile)(process.execPath, ["--import=vibelang/register", path], {
    env: { PATH: process.env.PATH, ...off },
  }).catch((error: { code: number; stdout: string; stderr: string }) => error)
  expect(result).toMatchObject({ code: 1, [stream]: expect.stringContaining("TLS checks are turned off") })
})

afterEach(() => vi.unstubAllEnvs())

test.each<[string, (fetch: typeof globalThis.fetch) => Promise<unknown>]>([
  ["post", (fetch) => post({ origin: "https://localhost:1443", repo: "o/n", issue: 1, token: "t", body: {}, fetch })],
  ["the issue client", (fetch) => clientOf({ origin: "https://localhost:1443", dryRun: false, fetch, token: () => "t", lane: () => "a/l" }).send({ repo: "o/n", path: "/x" })],
])("%s, imported, sends nothing with TLS checks off", async (_name, send) => {
  vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0")
  let asked = 0
  const fetch = (async () => {
    asked++
    return new Response("{}")
  }) as unknown as typeof globalThis.fetch
  await expect(send(fetch)).rejects.toThrow("TLS checks are turned off")
  expect(asked).toBe(0)
})
