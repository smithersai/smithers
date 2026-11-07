// The API's HTTP protocol and the Factory CLI's live mode against local workerd (test/support/workerd.ts): what a
// client that isn't LiveFactory sees, and the emitted CLI choosing the live Factory from VIBELANG_FACTORY_URL.
import { spawnSync } from "node:child_process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { notDeployed } from "../src/surfaces/backend.vibe"
import { REASONS } from "../worker/Reply.vibe"
import { cliPath, room, serveApi, serveSite, type Served } from "./support/workerd.ts"

function cli(args: ReadonlyArray<string>, origin: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, VIBELANG_FACTORY: "", VIBELANG_FACTORY_URL: origin, NO_COLOR: "1" },
  })
}

describe("the API Worker in local workerd", () => {
  let api: Served | undefined
  beforeAll(async () => { api = await serveApi() }, 120_000)
  afterAll(async () => { await api?.dispose() })

  it("answers the protocol's errors: unknown routes, bad cursors, bodies and ids", async () => {
    const at = (path: string, init?: RequestInit) => fetch(api!.origin + path, init)
    expect((await at("/api/nope")).status).toBe(404)
    expect((await at("/api/conversations/home/posts")).status).toBe(404)
    expect((await at("/api/conversations/home?after=-1")).status).toBe(400)
    expect((await at("/api/conversations/home?after=1.5")).status).toBe(400)
    expect((await at("/api/conversations/home/posts", { method: "POST", body: "{" })).status).toBe(400)
    expect((await at("/api/conversations/home/posts", { method: "POST", body: JSON.stringify({ clientId: "a", name: "x".repeat(65), text: "hi" }) })).status).toBe(400)
    expect((await at("/api/conversations/home/posts", { method: "POST", body: "x".repeat(40_000) })).status).toBe(413)
    expect((await at(`/api/conversations/${"x".repeat(129)}`)).status).toBe(404)
    expect(await (await at(`/api/conversations/${room("never")}`)).json()).toEqual({ seq: 0, entries: [] })
  })

  it("streams events as Server-Sent Events, each id its seq", async () => {
    const conversation = room("sse")
    const posted = await fetch(`${api!.origin}/api/conversations/${conversation}/posts`, {
      method: "POST", body: JSON.stringify({ clientId: "a", name: "Ada", text: "hi" }),
    })
    expect(posted.status).toBe(200)
    const response = await fetch(`${api!.origin}/api/conversations/${conversation}/events?after=0`)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()
    let text = ""
    while (!text.includes("ReplyFailed")) text += new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    expect(text).toContain(`id: 1\ndata: ${JSON.stringify({ type: "Posted", seq: 1, id: "m1", clientId: "a", name: "Ada", text: "hi" })}\n\n`)
    expect(text).toContain("id: 3\ndata: ")
  })

  it("serves the emitted CLI's live mode: ask fails with the reply's reason, and read returns", () => {
    const conversation = room("cli")
    const asked = cli(["ask", "hello", "--conversation", conversation], api!.origin)
    expect(asked.status, asked.stderr).toBe(1)
    expect(asked.stderr).toContain(`The agent's reply failed: ${REASONS.unconfigured}`)
    const read = cli(["--json", "read", "--conversation", conversation], api!.origin)
    expect(read.status, read.stderr).toBe(0)
    expect(JSON.parse(read.stdout).entries.map((entry: { readonly error: string }) => entry.error)).toEqual(["", REASONS.unconfigured])
  }, 120_000)
})

describe("the site Worker without the API Worker", () => {
  let site: Served | undefined
  beforeAll(async () => { site = await serveSite() }, 120_000)
  afterAll(async () => { await site?.dispose() })

  it("says the agent is the mock, so the CLI refuses live mode there", async () => {
    expect(await (await fetch(`${site!.origin}/api/health`)).json()).toEqual({ ok: true, agent: "mock" })
    const result = cli(["read"], site!.origin)
    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`${notDeployed(site!.origin)}\n`)
  }, 120_000)
})
