import { createOpencodeClient, type Message, type Part, type Session } from "@opencode-ai/sdk"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { mkdirSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Driver from "../src/Driver.ts"
import * as Health from "../src/Health.ts"
import * as Ids from "../src/Ids.ts"
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

type Seen = Array<{ type: string; properties: Record<string, unknown> }>

/** Tails `/global/event` into a list, from `server.connected` on. */
const watch = async (): Promise<Seen> => {
  const stream = await served.handler(new Request("http://test/global/event"))
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  const seen: Seen = []
  let buffered = ""
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffered += decoder.decode(value)
      const frames = buffered.split("\n\n")
      buffered = frames.pop() ?? ""
      for (const frame of frames) {
        if (frame.startsWith("data: ")) seen.push(JSON.parse(frame.slice(6)).payload)
      }
    }
  })()
  await until(async () => seen.some((event) => event.type === "server.connected"))
  return seen
}

/** The permission the session's turn parked on. */
const parkedPermission = async (seen: Seen, sessionID: string): Promise<Protocol.PermissionRequest> => {
  const asked = () =>
    seen.find((event) => event.type === "permission.asked" && event.properties["sessionID"] === sessionID)
  await until(async () => asked() !== undefined)
  return asked()!.properties as unknown as Protocol.PermissionRequest
}

/** Waits until the session's turn is idle and its last health decision landed. */
const settled = async (seen: Seen, sessionID: string): Promise<void> => {
  await until(async () =>
    seen.some((event) => event.type === "session.idle" && event.properties["sessionID"] === sessionID)
  )
  await until(async () =>
    seen.filter((event) =>
      event.type === "message.part.updated" && event.properties["sessionID"] === sessionID &&
      (event.properties["part"] as Part).type === "tool" &&
      (event.properties["part"] as Extract<Part, { type: "tool" }>).tool === "health"
    ).length === 3
  )
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
    // Dot directories stay out of the picker: .git and .smithers are there, dot files are listed.
    writeFileSync(join(served.directory, ".gitignore"), "node_modules\n")
    const files = (await sdk.file.list({ query: { path: "" } })).data!
    expect(((await get("/file")) as Array<unknown>).length).toBe(files.length)
    expect(files.map((node) => node.name)).toEqual([".gitignore", "package.json", "src"])
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
        body: `{"title":"🟢 Given","agent":"other"}`,
        headers: { "content-type": "application/json" }
      })
    )).json()) as Session
    expect(titled).toMatchObject({ title: "🟢 Given", agent: "other" })
    const read = (await sdk.session.get({ path: { id: created.id } })).data!
    expect(read).toEqual(created)
    const renamed = (await sdk.session.update({ path: { id: created.id }, body: { title: "Renamed" } })).data!
    expect(renamed.title).toBe("Renamed")
    // A rename keeps the health dot the session carries; an archive drops it.
    const redotted = (await sdk.session.update({ path: { id: titled.id }, body: { title: "Mine" } })).data!
    expect(redotted.title).toBe("🟢 Mine")
    // A rename that arrives with a dot (the app echoes the dotted title back,
    // with U+FE0F after the dot) is stored behind the session's own dot, so
    // the next color change replaces one dot instead of adding a second.
    const dottedRenames: ReadonlyArray<readonly [string, string]> = [
      ["⚪\uFE0F Renamed", "🟢 Renamed"],
      ["🔴 X", "🟢 X"],
      ["Plain", "🟢 Plain"]
    ]
    for (const [sent, stored] of dottedRenames) {
      const renamedWithDot = (await sdk.session.update({ path: { id: titled.id }, body: { title: sent } })).data!
      expect(renamedWithDot.title).toBe(stored)
      expect((await sdk.session.get({ path: { id: titled.id } })).data!.title).toBe(stored)
    }
    const plainRenames: ReadonlyArray<readonly [string, string]> = [
      ["⚪\uFE0F Renamed", "Renamed"],
      ["🔴 X", "X"],
      ["Plain", "Plain"],
      ["Renamed", "Renamed"]
    ]
    for (const [sent, stored] of plainRenames) {
      const undotted = (await sdk.session.update({ path: { id: created.id }, body: { title: sent } })).data!
      expect(undotted.title).toBe(stored)
    }
    expect((await sdk.session.update({ path: { id: titled.id }, body: { title: "Mine" } })).data!.title).toBe("🟢 Mine")
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
    // The resumed frame's health decision may land just after the idle.
    const healthStreamed = () =>
      seen.filter((event) =>
        event.type === "message.part.updated" && (event.properties["part"] as Part).type === "tool" &&
        (event.properties["part"] as Extract<Part, { type: "tool" }>).tool === "health"
      ).length
    await until(async () => healthStreamed() === 3)

    const types = seen.map((event) => event.type)
    expect(types).toContain("message.part.delta")
    expect(types).toContain("permission.replied")
    expect(types.filter((type) => type === "session.status").length).toBeGreaterThanOrEqual(2)
    const history = (await sdk.session.messages({ path: { id: session.id }, query: { limit: 20 } })).data!
    expect(history.map((item: { info: Message }) => item.info.role)).toEqual(["user", "assistant", "user"])
    // The app's own part id comes back on the stream and in the history, so
    // its optimistic part is confirmed; a prompt sent without one gets a
    // derived id.
    expect(history[0]!.parts.map((part: Part) => part.id)).toEqual(["prt_0000000000010000000000000u"])
    expect(
      seen.some((event) =>
        event.type === "message.part.updated" &&
        (event.properties["part"] as Part).id === "prt_0000000000010000000000000u"
      )
    ).toBe(true)
    expect(history[2]!.parts.map((part: Part) => part.id)).toEqual([
      Ids.part(history[2]!.info.id, { frame: 0, slot: 0, ordinal: 0 })
    ])
    const assistant = history[1]!
    expect(assistant.info).toMatchObject({
      role: "assistant",
      finish: "stop",
      parentID: "msg_0000000000010000000000000u"
    })
    const tools = assistant.parts.filter((part: Part): part is Extract<Part, { type: "tool" }> => part.type === "tool")
    // Frame zero's settle is judged once (gray, no Jev key); the park (red)
    // and the resumed frame's settle (gray again) both sort under frame one.
    expect(tools.map((part) => part.tool)).toEqual([
      "cell",
      "read",
      "list",
      "classify",
      "health",
      "cell",
      "bash",
      "demand",
      "health",
      "health"
    ])
    expect(tools.every((part) => part.state.status === "completed")).toBe(true)
    // The park turned the dot red with no Jev at all; the answer turned it
    // back. The cards sort under the frame each judged, so read them in time.
    const healthCards = tools
      .filter((part) => part.tool === "health")
      .map((part) => part.state as Extract<Protocol.ToolState, { status: "completed" }>)
      .sort((a, b) => a.time.start - b.time.start)
    expect(healthCards.map((state) => state.title)).toEqual([
      "health unavailable: No evaluator is installed on this host",
      "waiting for approval",
      "health unavailable: No evaluator is installed on this host"
    ])
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
    // A stream opened with the last id it saw resumes after it; `/event`
    // carries the bare Event of the OpenAPI, not the global envelope.
    const lastID = await served.handler(new Request("http://test/event", { headers: { "last-event-id": "evt_nope" } }))
    expect(lastID.status).toBe(200)
    const bareReader = lastID.body!.getReader()
    let bareText = ""
    const bareFrames: Array<Record<string, unknown>> = []
    while (!bareFrames.some((event) => event["type"] === "session.idle")) {
      bareText += new TextDecoder().decode((await bareReader.read()).value)
      const chunks = bareText.split("\n\n")
      bareText = chunks.pop() ?? ""
      for (const chunk of chunks) {
        if (chunk.startsWith("data: ")) bareFrames.push(JSON.parse(chunk.slice(6)) as Record<string, unknown>)
      }
    }
    await bareReader.cancel()
    expect(bareFrames[0]).toMatchObject({ type: "server.connected", properties: {} })
    expect(bareFrames.every((event) => !("payload" in event) && !("directory" in event))).toBe(true)
    expect(bareFrames.find((event) => event["type"] === "session.idle")!["properties"]).toEqual({
      sessionID: session.id
    })
  })

  it("serves one message by id, a file's content, and the project update the app sends", async () => {
    const sdk = client()
    const session = (await sdk.session.create({ query: { directory: served.directory }, body: {} })).data!
    // Twenty-one messages, stored the way a turn stores them: ten prompt and
    // reply pairs and one more prompt, so the last twenty start with a
    // reply whose prompt lies outside the page. The app fetches that prompt
    // by id (server-session.ts fetchMessage) and renders the reply without
    // it only when the id answers 404.
    const store = Store.layerSqlite(Serve.databasePath(served.directory))
    const ids = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* Store.Store
        const ids: Array<string> = []
        for (let index = 0; index < 11; index++) {
          const at = 1_800_000_000_000 + index * 1000
          const userID = Ids.make("message", at)
          yield* store.putMessage({
            id: userID,
            sessionID: session.id,
            role: "user",
            time: { created: at },
            agent: "smithers",
            model: { providerID: "scripted", modelID: "demo" }
          })
          yield* store.putPart({
            id: Ids.part(userID, { frame: 0, slot: 0, ordinal: 0 }),
            sessionID: session.id,
            messageID: userID,
            type: "text",
            text: `prompt ${index}`
          })
          ids.push(userID)
          if (index === 10) break
          const replyID = Ids.reply(userID)
          yield* store.putMessage({
            id: replyID,
            sessionID: session.id,
            role: "assistant",
            time: { created: at + 1, completed: at + 2 },
            parentID: userID,
            modelID: "demo",
            providerID: "scripted",
            mode: "smithers",
            agent: "smithers",
            path: { cwd: served.directory, root: served.directory },
            cost: 0,
            tokens: Protocol.noTokens,
            finish: "stop"
          })
          ids.push(replyID)
        }
        return ids
      }).pipe(Effect.provide(store))
    )
    expect(ids.length).toBe(21)
    const page = await served.handler(
      new Request(`http://test/session/${session.id}/message?limit=20`, {
        headers: { origin: "https://app.opencode.ai" }
      })
    )
    const items = (await page.json()) as Array<{ info: Message; parts: Array<Part> }>
    expect(items.length).toBe(20)
    expect(items[0]!.info.role).toBe("assistant")
    const parentID = (items[0]!.info as Protocol.AssistantMessage).parentID
    expect(parentID).toBe(ids[0])
    // More remain: the page names the cursor the way 1.18.31 does, exposed to
    // the app, and the next page from it is the first prompt with no cursor.
    expect(page.headers.get("x-next-cursor")).toBe(items[0]!.info.id)
    expect(page.headers.get("access-control-expose-headers")).toBe("Link, X-Next-Cursor")
    expect(page.headers.get("link")).toBe(
      `</session/${session.id}/message?limit=20&before=${items[0]!.info.id}>; rel="next"`
    )
    const older = await served.handler(
      new Request(`http://test/session/${session.id}/message?limit=20&before=${items[0]!.info.id}`)
    )
    expect(((await older.json()) as Array<{ info: Message }>).map((item) => item.info.id)).toEqual([ids[0]])
    expect(older.headers.get("x-next-cursor")).toBeNull()
    expect(older.headers.get("link")).toBeNull()
    // No limit: every message, no cursor.
    const whole = await served.handler(new Request(`http://test/session/${session.id}/message`))
    expect(((await whole.json()) as Array<unknown>).length).toBe(21)
    expect(whole.headers.get("x-next-cursor")).toBeNull()
    const exact = await served.handler(new Request(`http://test/session/${session.id}/message?limit=21`))
    expect(((await exact.json()) as Array<unknown>).length).toBe(21)
    expect(exact.headers.get("x-next-cursor")).toBeNull()
    const parent = await served.handler(
      new Request(`http://test/session/${session.id}/message/${parentID}`, {
        headers: { origin: "https://app.opencode.ai" }
      })
    )
    expect(parent.status).toBe(200)
    expect(parent.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")
    const fetched = (await parent.json()) as { info: Message; parts: Array<Part> }
    expect(fetched.info).toMatchObject({ id: parentID, role: "user" })
    expect(fetched.parts.map((part) => part.type)).toEqual(["text"])
    expect((await sdk.session.message({ path: { id: session.id, messageID: parentID } })).data).toEqual(fetched)
    // A message that is not there, or belongs to another session, is a 404
    // the app reads (the reply renders without its prompt).
    const gone = await served.handler(
      new Request(`http://test/session/${session.id}/message/msg_nope`, {
        headers: { origin: "https://app.opencode.ai" }
      })
    )
    expect(gone.status).toBe(404)
    expect(gone.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")
    expect(await gone.json()).toEqual({ name: "NotFoundError", data: { message: "Message msg_nope not found" } })
    const other = (await sdk.session.create({ query: { directory: served.directory }, body: {} })).data!
    expect((await served.handler(new Request(`http://test/session/${other.id}/message/${parentID}`))).status).toBe(404)
    expect((await served.handler(new Request(`http://test/session/ses_missing/message/${parentID}`))).status).toBe(404)

    // A click on a file in a read card reads it.
    writeFileSync(join(served.directory, "src", "hello.ts"), "export const hello = 1\n")
    writeFileSync(join(served.directory, "src", "blob.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    expect((await sdk.file.read({ query: { path: "src/hello.ts" } })).data).toEqual({
      type: "text",
      content: "export const hello = 1\n"
    })
    expect(await get(`/file/content?path=${encodeURIComponent(join(served.directory, "src", "hello.ts"))}`)).toEqual({
      type: "text",
      content: "export const hello = 1\n"
    })
    expect(await get(`/file/content?path=src/blob.bin`)).toEqual({ type: "binary", content: "" })
    expect(await get(`/file/content?directory=${encodeURIComponent(join(served.directory, "src"))}&path=hello.ts`))
      .toEqual({ type: "text", content: "export const hello = 1\n" })
    expect((await served.handler(new Request("http://test/file/content"))).status).toBe(404)
    for (const path of ["src/nope.ts", "src", "../outside", ""]) {
      const missing = await served.handler(new Request(`http://test/file/content?path=${encodeURIComponent(path)}`))
      expect(missing.status, path).toBe(404)
      expect(await missing.json()).toEqual({ name: "NotFoundError", data: { message: `File ${path} not found` } })
    }

    // A project rename or update from the app echoes the project.
    const project = Routes.projectID(served.directory)
    const patched = await served.handler(
      new Request(`http://test/project/${project}`, {
        method: "PATCH",
        body: `{"name":"Mine"}`,
        headers: { "content-type": "application/json", origin: "https://app.opencode.ai" }
      })
    )
    expect(patched.status).toBe(200)
    expect(patched.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")
    expect(await patched.json()).toMatchObject({ id: project, worktree: served.directory, name: "Mine" })
    const unnamed = await served.handler(new Request(`http://test/project/${project}`, { method: "PATCH" }))
    expect(await unnamed.json()).not.toHaveProperty("name")
    const wrong = await served.handler(new Request("http://test/project/abc", { method: "PATCH" }))
    expect(wrong.status).toBe(404)

    // A route the app calls that this server does not mount: a JSON 404 with
    // the allow headers, never a CORS failure in the browser.
    const unmounted = await served.handler(
      new Request(`http://test/session/${session.id}/revert`, {
        method: "POST",
        headers: { origin: "https://app.opencode.ai" }
      })
    )
    expect(unmounted.status).toBe(404)
    expect(unmounted.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")
    expect(await unmounted.json()).toEqual({ name: "NotFoundError", data: { message: "Route not found" } })
  })

  it("keeps a rename made while the turn runs on every later session.updated and on the session", async () => {
    const sdk = client()
    const session = (await sdk.session.create({ query: { directory: served.directory }, body: {} })).data!
    const seen = await watch()
    await sdk.session.promptAsync({
      path: { id: session.id },
      body: {
        messageID: "msg_0000000000030000000000000u",
        parts: [{ type: "text", text: "Read package.json and tell me the name field." }]
      }
    })
    const asked = await parkedPermission(seen, session.id)
    // The rename lands while the turn is parked: the answer carries it
    // behind the dot the turn already set.
    const renamed = (await sdk.session.update({ path: { id: session.id }, body: { title: "Renamed mid-turn" } }))
      .data!
    expect(Health.strip(renamed.title)).toBe("Renamed mid-turn")
    expect(Health.colorOf(renamed.title)).toBeDefined()
    const renamedAt = seen.length
    await sdk.postSessionIdPermissionsPermissionId({
      path: { id: session.id, permissionID: asked.id },
      body: { response: "once" }
    })
    await settled(seen, session.id)
    // Every session.updated after the rename, and the session itself, carry
    // the new title with one dot in front of it.
    const later = seen.slice(renamedAt).filter((event) =>
      event.type === "session.updated" && (event.properties["info"] as Session).id === session.id
    ).map((event) => (event.properties["info"] as Session).title)
    expect(later.length).toBeGreaterThan(0)
    for (const title of later) {
      expect(Health.strip(title)).toBe("Renamed mid-turn")
      expect(title).toBe(Health.dotted(title, Health.colorOf(title)!))
    }
    const after = (await sdk.session.get({ path: { id: session.id } })).data!
    expect(Health.strip(after.title)).toBe("Renamed mid-turn")
    expect(after.title).toBe(Health.dotted(after.title, Health.colorOf(after.title)!))
    expect((await get("/session")) as Array<Session>).toContainEqual(expect.objectContaining({ id: session.id }))
  })

  it("keeps an archive made while the turn runs on every later session.updated and on the session", async () => {
    const sdk = client()
    const session = (await sdk.session.create({ query: { directory: served.directory }, body: {} })).data!
    const seen = await watch()
    await sdk.session.promptAsync({
      path: { id: session.id },
      body: {
        messageID: "msg_0000000000040000000000000u",
        parts: [{ type: "text", text: "Read package.json and tell me the name field." }]
      }
    })
    const asked = await parkedPermission(seen, session.id)
    const patched = await served.handler(
      new Request(`http://test/session/${session.id}`, {
        method: "PATCH",
        body: `{"time":{"archived":1234}}`,
        headers: { "content-type": "application/json" }
      })
    )
    expect(patched.status).toBe(200)
    const archived = (await patched.json()) as Protocol.Session
    expect(archived.time.archived).toBe(1234)
    expect(Health.colorOf(archived.title)).toBeUndefined()
    const archivedAt = seen.length
    await sdk.postSessionIdPermissionsPermissionId({
      path: { id: session.id, permissionID: asked.id },
      body: { response: "once" }
    })
    await settled(seen, session.id)
    // The archive stamp stays on every later session.updated and on the
    // session; an archived session carries no dot, the way the archive
    // route answered.
    const later = seen.slice(archivedAt).filter((event) =>
      event.type === "session.updated" && (event.properties["info"] as Protocol.Session).id === session.id
    ).map((event) => (event.properties["info"] as Protocol.Session))
    expect(later.length).toBeGreaterThan(0)
    for (const info of later) {
      expect(info.time.archived).toBe(1234)
      expect(Health.colorOf(info.title)).toBeUndefined()
    }
    const after = (await get(`/session/${session.id}`)) as Protocol.Session
    expect(after.time.archived).toBe(1234)
    expect(Health.colorOf(after.title)).toBeUndefined()
    // Archived: the turn's tokens still landed on the session.
    expect(after.tokens.input).toBeGreaterThan(0)
    expect((await get("/session")) as Array<Session>).not.toContainEqual(expect.objectContaining({ id: session.id }))
  })

  it("pages a 22-message history: the newest 20, then only what is strictly older than the cursor", async () => {
    const sdk = client()
    const session = (await sdk.session.create({ query: { directory: served.directory }, body: {} })).data!
    const store = Store.layerSqlite(Serve.databasePath(served.directory))
    const ids = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* Store.Store
        const ids: Array<string> = []
        for (let index = 0; index < 11; index++) {
          const at = 1_810_000_000_000 + index * 1000
          const userID = Ids.make("message", at)
          yield* store.putMessage({
            id: userID,
            sessionID: session.id,
            role: "user",
            time: { created: at },
            agent: "smithers",
            model: { providerID: "scripted", modelID: "demo" }
          })
          ids.push(userID)
          const replyID = Ids.reply(userID)
          yield* store.putMessage({
            id: replyID,
            sessionID: session.id,
            role: "assistant",
            time: { created: at + 1, completed: at + 2 },
            parentID: userID,
            modelID: "demo",
            providerID: "scripted",
            mode: "smithers",
            agent: "smithers",
            path: { cwd: served.directory, root: served.directory },
            cost: 0,
            tokens: Protocol.noTokens,
            finish: "stop"
          })
          ids.push(replyID)
        }
        return ids
      }).pipe(Effect.provide(store))
    )
    expect(ids.length).toBe(22)
    const page = await served.handler(new Request(`http://test/session/${session.id}/message?limit=20`))
    const pageIDs = ((await page.json()) as Array<{ info: Message }>).map((item) => item.info.id)
    // The newest twenty, oldest first (newest last), and the cursor is the
    // oldest id on the page.
    expect(pageIDs).toEqual(ids.slice(2))
    expect(page.headers.get("x-next-cursor")).toBe(ids[2])
    const older = await served.handler(
      new Request(`http://test/session/${session.id}/message?limit=200&before=${ids[2]}`)
    )
    const olderIDs = ((await older.json()) as Array<{ info: Message }>).map((item) => item.info.id)
    // Strictly older than the cursor: the two the page left out, and none
    // of the page's own.
    expect(olderIDs).toEqual(ids.slice(0, 2))
    expect(olderIDs.filter((id) => pageIDs.includes(id))).toEqual([])
    expect(older.headers.get("x-next-cursor")).toBeNull()
    // Paging with the page size again from the cursor reads the same two.
    const again = await served.handler(
      new Request(`http://test/session/${session.id}/message?limit=20&before=${ids[2]}`)
    )
    expect(((await again.json()) as Array<{ info: Message }>).map((item) => item.info.id)).toEqual(ids.slice(0, 2))
    expect(again.headers.get("x-next-cursor")).toBeNull()
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
