import { createOpencodeClient, type Message, type Part, type Session } from "@opencode-ai/sdk"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { mkdirSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Driver from "../src/Driver.ts"
import * as Protocol from "../src/Protocol.ts"
import * as Routes from "../src/Routes.ts"
import * as Serve from "../src/Serve.ts"
import * as Store from "../src/Store.ts"
import { serve, type Served, until } from "./Harness.ts"

let served: Served
beforeAll(() => {
  served = serve()
  mkdirSync(join(served.directory, "src"), { recursive: true })
  writeFileSync(join(served.directory, "package.json"), `{"name":"demo"}`)
  mkdirSync(join(served.directory, ".git"), { recursive: true })
  writeFileSync(join(served.directory, ".git", "HEAD"), "ref: refs/heads/main\n")
})
afterAll(() => served.dispose())

const client = () =>
  createOpencodeClient({
    baseUrl: "http://test",
    fetch: (request) => served.handler(request),
    throwOnError: true
  })

const get = async (path: string): Promise<unknown> => {
  const response = await served.handler(new Request(`http://test${path}`))
  expect(response.status).toBe(200)
  return response.json()
}

describe("Routes through the OpenCode SDK client", () => {
  it("answers the bootstrap routes with the shapes the app reads", async () => {
    const sdk = client()
    expect(await get("/global/health")).toEqual({ healthy: true, version: "test" })
    expect(await get("/api/health")).toEqual({ healthy: true })
    expect((await sdk.config.get()).data).toMatchObject({ model: "scripted/demo", default_agent: "smithers" })
    expect(await get("/global/config")).toEqual({ $schema: "https://opencode.ai/config.json" })
    expect((await sdk.path.get()).data).toMatchObject({ directory: served.directory, worktree: served.directory })
    const projects = (await sdk.project.list()).data!
    expect(projects).toHaveLength(1)
    expect(projects[0]!).toMatchObject({
      id: Routes.projectID(served.directory),
      worktree: served.directory,
      vcs: "git"
    })
    expect((await sdk.project.current()).data!.id).toBe(Routes.projectID(served.directory))
    const providers = (await sdk.provider.list()).data!
    expect(providers.connected).toEqual(["scripted"])
    expect(providers.default).toEqual({ scripted: "demo" })
    expect(providers.all[0]!.models["demo"]).toMatchObject({ id: "demo", providerID: "scripted", status: "active" })
    const agents = (await sdk.app.agents()).data!
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ name: "smithers", mode: "primary" })
    expect((await sdk.command.list()).data).toEqual([])
    expect((await sdk.lsp.status()).data).toEqual([])
    expect((await sdk.mcp.status()).data).toEqual({})
    expect(await get("/experimental/resource")).toEqual({})
    expect(await get("/question")).toEqual([])
    expect(await get("/permission")).toEqual([])
    expect((await sdk.vcs.get()).data).toEqual({ branch: "main", default_branch: "main" })
    expect(await get("/vcs/diff?mode=git")).toEqual([])
    expect(await get("/vcs/status")).toEqual([])
    expect((await sdk.find.files({ query: { query: "" } })).data).toEqual([])
    expect((await sdk.find.files({ query: { query: served.directory.slice(0, 5), dirs: "true" } })).data).toEqual([
      served.directory
    ])
    expect((await sdk.find.files({ query: { query: "/nowhere", dirs: "true" } })).data).toEqual([])
    expect(
      (await sdk.find.files({
        query: { directory: join(served.directory, ".."), query: basename(served.directory), dirs: "true" }
      })).data
    ).toEqual([served.directory])
    expect(await get("/find/file")).toEqual([])
    expect(await get("/find/file?dirs=true")).toEqual([served.directory])
    const files = (await sdk.file.list({ query: { path: "" } })).data!
    expect(((await get("/file")) as Array<unknown>).length).toBe(files.length)
    expect(files.map((node) => node.name)).toEqual([".git", ".smithers", "package.json", "src"])
    expect(files.find((node) => node.name === "src")).toMatchObject({ type: "directory", path: "src/", ignored: false })
    expect((await sdk.file.list({ query: { path: "missing" } })).data).toEqual([])
    const fromParent =
      (await sdk.file.list({ query: { directory: join(served.directory, ".."), path: basename(served.directory) } }))
        .data!
    expect(fromParent.map((node) => node.name)).toEqual(files.map((node) => node.name))
    expect(await get("/api/reference?directory=x")).toEqual({
      location: {
        directory: served.directory,
        project: { id: Routes.projectID(served.directory), directory: served.directory }
      },
      data: []
    })
    expect((await sdk.session.status()).data).toEqual({})
    expect(await get("/api/session?limit=5000&order=desc")).toEqual({ data: [], cursor: {} })
  })

  it("creates, reads, renames, lists, and deletes a session", async () => {
    const sdk = client()
    const created = (await sdk.session.create({ query: { directory: served.directory }, body: {} })).data!
    expect(created.id.startsWith("ses_")).toBe(true)
    expect(created.title.startsWith("New session - ")).toBe(true)
    expect(created).toMatchObject({
      directory: served.directory,
      version: "test",
      agent: "smithers",
      model: { id: "demo", providerID: "scripted" }
    })
    const titled = (await (await served.handler(
      new Request("http://test/session", {
        method: "POST",
        body: `{"title":"Given","agent":"other"}`,
        headers: { "content-type": "application/json" }
      })
    )).json()) as Session
    expect(titled).toMatchObject({ title: "Given", agent: "other" })
    const read = (await sdk.session.get({ path: { id: created.id } })).data!
    expect(read).toEqual(created)
    const renamed = (await sdk.session.update({ path: { id: created.id }, body: { title: "Renamed" } })).data!
    expect(renamed.title).toBe("Renamed")
    // A rename keeps the health dot the session carries; an archive drops it.
    await served.handler(
      new Request(`http://test/session/${titled.id}`, {
        method: "PATCH",
        body: `{"title":"🟢 Given"}`,
        headers: { "content-type": "application/json" }
      })
    )
    const redotted = (await sdk.session.update({ path: { id: titled.id }, body: { title: "Mine" } })).data!
    expect(redotted.title).toBe("🟢 Mine")
    const archived = (await (await served.handler(
      new Request(`http://test/session/${titled.id}`, {
        method: "PATCH",
        body: `{"time":{"archived":5}}`,
        headers: { "content-type": "application/json" }
      })
    )).json()) as Protocol.Session
    expect(archived.time.archived).toBe(5)
    expect(archived.title).toBe("Mine")
    const listed =
      (await get(`/session?directory=${encodeURIComponent(served.directory)}&roots=true&limit=55`)) as Array<Session>
    expect(listed.map((session) => session.id)).toEqual([created.id])
    const home = (await get("/api/session?limit=5000&order=desc")) as { data: Array<Protocol.SessionV2> }
    expect(home.data.map((session) => session.id)).toEqual([created.id])
    expect(home.data[0]).toMatchObject({ location: { directory: served.directory }, title: "Renamed" })
    const other = (await get(`/api/session?limit=1&directory=/elsewhere`)) as { data: Array<unknown> }
    expect(other.data).toEqual([])
    const limited = (await get(`/session?limit=0`)) as Array<unknown>
    expect(limited.length).toBe(1)
    expect(((await get("/session")) as Array<unknown>).length).toBe(1)
    expect(((await get("/api/session")) as { data: Array<unknown> }).data.length).toBe(1)
    expect(await get(`/session/${created.id}/message`)).toEqual([])
    expect(await get(`/session/${created.id}/message?limit=abc`)).toEqual([])
    expect((await sdk.session.children({ path: { id: created.id } })).data).toEqual([])
    expect((await sdk.session.todo({ path: { id: created.id } })).data).toEqual([])
    expect((await sdk.session.diff({ path: { id: created.id } })).data).toEqual([])
    expect((await sdk.session.messages({ path: { id: created.id }, query: { limit: 20 } })).data).toEqual([])
    expect((await sdk.session.delete({ path: { id: titled.id } })).data).toBe(true)
    const missing = await served.handler(new Request("http://test/session/ses_missing"))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ name: "NotFoundError", data: { message: "Session ses_missing not found" } })
    const missingPatch = await served.handler(
      new Request("http://test/session/ses_missing", {
        method: "PATCH",
        body: "{}",
        headers: { "content-type": "application/json" }
      })
    )
    expect(missingPatch.status).toBe(404)
    const badBody = await served.handler(
      new Request(`http://test/session/${created.id}`, {
        method: "PATCH",
        body: "[1]",
        headers: { "content-type": "application/json" }
      })
    )
    expect(badBody.status).toBe(200)
    const malformed = await served.handler(
      new Request(`http://test/session/${created.id}`, {
        method: "PATCH",
        body: "{not json",
        headers: { "content-type": "application/json" }
      })
    )
    expect(malformed.status).toBe(200)
    expect(((await get("/api/session?limit=abc")) as { data: Array<unknown> }).data.length).toBe(1)
    expect(((await get("/session?limit=abc")) as Array<unknown>).length).toBe(1)
    const raw = await served.handler(new Request("http://test/session", { method: "POST" }))
    expect(raw.status).toBe(200)
    expect(((await raw.json()) as Session).title.startsWith("New session")).toBe(true)
  })

  it("runs a prompt, streams the turn, answers the permission, and serves the history", async () => {
    const sdk = client()
    const session = (await sdk.session.create({ query: { directory: served.directory }, body: {} })).data!
    const stream = await served.handler(new Request("http://test/global/event"))
    expect(stream.headers.get("content-type")).toContain("text/event-stream")
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    const seen: Array<{ type: string; properties: Record<string, unknown> }> = []
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffered += decoder.decode(value)
        const frames = buffered.split("\n\n")
        buffered = frames.pop() ?? ""
        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue
          seen.push(JSON.parse(frame.slice(6)).payload)
        }
      }
    }
    void pump()
    await until(async () => seen.some((event) => event.type === "server.connected"))

    const rejected = await served.handler(
      new Request(`http://test/session/${session.id}/prompt_async`, {
        method: "POST",
        body: `{"parts":[]}`,
        headers: { "content-type": "application/json" }
      })
    )
    expect(rejected.status).toBe(400)
    const missing = await served.handler(
      new Request(`http://test/session/ses_missing/prompt_async`, {
        method: "POST",
        body: `{"parts":[{"type":"text","text":"x"}]}`,
        headers: { "content-type": "application/json" }
      })
    )
    expect(missing.status).toBe(404)

    const oddParts = await served.handler(
      new Request(`http://test/session/${session.id}/prompt_async`, {
        method: "POST",
        body: `{"parts":[{"text":"no type"},"junk",{"type":"text"}],"model":{"providerID":1}}`,
        headers: { "content-type": "application/json" }
      })
    )
    expect(oddParts.status).toBe(400)
    const noParts = await served.handler(
      new Request(`http://test/session/${session.id}/prompt_async`, {
        method: "POST",
        body: `{"parts":"x"}`,
        headers: { "content-type": "application/json" }
      })
    )
    expect(noParts.status).toBe(400)
    const prompted = await sdk.session.promptAsync({
      path: { id: session.id },
      body: {
        messageID: "msg_0000000000010000000000000u",
        agent: "smithers",
        model: { providerID: "scripted", modelID: "demo" },
        parts: [{
          id: "prt_0000000000010000000000000u",
          type: "text",
          text: "Read package.json and tell me the name field."
        }]
      }
    })
    expect(prompted.response.status).toBe(204)
    await until(async () => seen.some((event) => event.type === "permission.asked"))
    const asked = seen.find((event) => event.type === "permission.asked")!
      .properties as unknown as Protocol.PermissionRequest
    expect(asked).toMatchObject({ sessionID: session.id, permission: "bash", patterns: ["ls -la"], always: ["ls *"] })
    expect((await get("/permission")) as Array<unknown>).toHaveLength(1)
    expect((await sdk.session.status()).data).toEqual({ [session.id]: { type: "busy" } })
    // A second prompt while busy is steered, not started.
    const steered = await sdk.session.promptAsync({
      path: { id: session.id },
      body: { parts: [{ type: "text", text: "also summarize" }] }
    })
    expect(steered.response.status).toBe(204)

    const badReply = await served.handler(
      new Request(`http://test/session/${session.id}/permissions/${asked.id}`, {
        method: "POST",
        body: `{"response":"maybe"}`,
        headers: { "content-type": "application/json" }
      })
    )
    expect(badReply.status).toBe(400)
    const unknownReply = await served.handler(
      new Request(`http://test/session/${session.id}/permissions/per_nope`, {
        method: "POST",
        body: `{"response":"once"}`,
        headers: { "content-type": "application/json" }
      })
    )
    expect(unknownReply.status).toBe(404)
    const replied = await sdk.postSessionIdPermissionsPermissionId({
      path: { id: session.id, permissionID: asked.id },
      body: { response: "once" }
    })
    expect(replied.data).toBe(true)
    await until(async () => seen.some((event) => event.type === "session.idle"))

    const types = seen.map((event) => event.type)
    expect(types).toContain("message.part.delta")
    expect(types).toContain("permission.replied")
    expect(types.filter((type) => type === "session.status").length).toBeGreaterThanOrEqual(2)
    const history = (await sdk.session.messages({ path: { id: session.id }, query: { limit: 20 } })).data!
    expect(history.map((item: { info: Message }) => item.info.role)).toEqual(["user", "assistant", "user"])
    const assistant = history[1]!
    expect(assistant.info).toMatchObject({
      role: "assistant",
      finish: "stop",
      parentID: "msg_0000000000010000000000000u"
    })
    const tools = assistant.parts.filter((part: Part): part is Extract<Part, { type: "tool" }> => part.type === "tool")
    expect(tools.map((part) => part.tool)).toEqual([
      "cell",
      "read",
      "list",
      "classify",
      "health",
      "cell",
      "bash",
      "demand"
    ])
    expect(tools.every((part) => part.state.status === "completed")).toBe(true)
    const bash = tools.find((part) => part.tool === "bash")!
    expect(bash.state.status === "completed" && bash.state.metadata).toMatchObject({ exit: 0 })
    expect(bash.state.input).toEqual({ command: "ls -la" })
    const read = tools.find((part) => part.tool === "read")!
    expect(read.state.input).toEqual({ filePath: join(served.directory, "package.json") })
    const text = assistant.parts.find((part: Part) => part.type === "text") as Extract<Part, { type: "text" }>
    expect(text.text).toContain("demo-repo")
    expect(text.time?.end).toBeDefined()
    const paged = (await get(`/session/${session.id}/message?limit=1&before=${assistant.info.id}`)) as Array<
      { info: Message }
    >
    expect(paged.map((item) => item.info.role)).toEqual(["user"])
    const updated = (await sdk.session.get({ path: { id: session.id } })).data as unknown as Protocol.Session
    // No evaluator is installed, so the first frame turned the dot gray.
    expect(updated.title).toBe("⚪ Read package.json and tell me the name field.")
    expect(updated.tokens.input).toBeGreaterThan(0)
    expect((await sdk.session.abort({ path: { id: session.id } })).data).toBe(false)
    await reader.cancel()
    // A stream opened with the last id it saw resumes after it.
    const lastID = await served.handler(new Request("http://test/event", { headers: { "last-event-id": "evt_nope" } }))
    expect(lastID.status).toBe(200)
    await lastID.body!.cancel()
  })

  it("answers 500 with a typed error when the store fails", async () => {
    const failing: Store.Service = new Proxy({} as Store.Service, {
      get: () => () => Effect.fail(new Store.StoreError({ message: "disk gone" }))
    })
    const scratch = serve()
    await scratch.dispose()
    const { dispose, handler } = HttpRouter.toWebHandler(
      Serve.app({ directory: scratch.directory, bind: Serve.defaultBind, version: "test", seat: "scripted:demo" }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Store.Store, failing),
            Layer.succeed(Driver.Driver, {
              start: () => Effect.void,
              interrupt: () => Effect.succeed(false),
              permission: () => Effect.void,
              steer: () => Effect.succeed(false),
              resumeOnBoot: () => Effect.void
            })
          )
        )
      ),
      { disableLogger: true }
    )
    try {
      expect(await (await handler(new Request("http://test/vcs"))).json()).toEqual({})
      expect(((await (await handler(new Request("http://test/project"))).json()) as Array<Protocol.Project>)[0]!.vcs)
        .toBeUndefined()
      for (const path of ["/session", "/api/session", "/permission", "/session/ses_x", "/session/ses_x/message"]) {
        const response = await handler(new Request(`http://test${path}`))
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ name: "UnknownError", data: { message: "disk gone" } })
      }
      const created = await handler(
        new Request("http://test/session", {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" }
        })
      )
      expect(created.status).toBe(500)
      const prompted = await handler(
        new Request("http://test/session/ses_x/prompt_async", {
          method: "POST",
          body: `{"parts":[{"type":"text","text":"x"}]}`,
          headers: { "content-type": "application/json" }
        })
      )
      expect(prompted.status).toBe(500)
      const replied = await handler(
        new Request("http://test/session/ses_x/permissions/per_x", {
          method: "POST",
          body: `{"response":"once"}`,
          headers: { "content-type": "application/json" }
        })
      )
      expect(replied.status).toBe(500)
    } finally {
      await dispose()
    }
  })

  it("derives the project, the seat, the slug, and the branch", () => {
    expect(Routes.projectID("/a")).toBe(Routes.projectID("/a"))
    expect(Routes.modelOf("cerebras:gpt-oss-120b")).toEqual({ providerID: "cerebras", modelID: "gpt-oss-120b" })
    expect(Routes.modelOf("bare")).toEqual({ providerID: "smithers", modelID: "bare" })
    expect(Routes.slugOf("ses_abcdefgh")).toMatch(/^[a-z]+-[a-z]+$/)
    expect(Routes.gitBranch("/nonexistent")).toBeUndefined()
    const scratch = serve()
    mkdirSync(join(scratch.directory, ".git"), { recursive: true })
    writeFileSync(join(scratch.directory, ".git", "HEAD"), "0123456789abcdef0123\n")
    expect(Routes.gitBranch(scratch.directory)).toBe("0123456789ab")
    return scratch.dispose()
  })
})
