import { catalogDescriptors } from "@smthrs/cli/Catalog"
import { Tokens } from "@smthrs/harness"
import { Model, type ModelEvent, type ModelRequest } from "@smthrs/model"
import {
  AgentCommands,
  AgentContext,
  AgentInstructions,
  AgentToolResult,
  AgentTurnJournal,
  type DocsPages,
  NativeAgent,
  type TodoCard,
  UiInstruction
} from "@smthrs/rpc"
import { fixtures as homeFixtures } from "@smthrs/rpc/fixtures/Home"
import { fixtures } from "@smthrs/rpc/fixtures/Todo"
import { Effect, Stream } from "effect"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { describe, expect, test } from "vitest"
import { HOST_DIAGNOSTIC_MARKER } from "../src/HostDiagnostics.ts"
import { createHostDiagnostics } from "./diagnostics.ts"
import { runDurableChatTurn } from "./fixtures/durable.ts"
import type { DurableChatGrant } from "./fixtures/durable.ts"
import { apiCaller, runHostTurn } from "./fixtures/durable.ts"

// Literal fixtures: the question, main's commit and JOURNEY.md's one line.
const COMMIT = "0123456789abcdef0123456789abcdef01234567"
const JOURNEY = "Add a greeting to JOURNEY.md\n"
const question: NativeAgent.StartAgentTurnRequest = {
  runId: "run",
  instructions: "Answer briefly using file cards.",
  messages: [{ role: "user", content: "What is in JOURNEY.md?" }]
}
const cursor: AgentTurnJournal.AgentTurnCursor = {
  version: 1,
  runId: "run",
  legId: "leg",
  batch: 0,
  position: 0,
  hash: "a".repeat(64)
}
const grant: DurableChatGrant = {
  turnId: "0b6c3f6e-56f1-4ad4-9f87-0d1c3c1f7a10",
  ownerId: 7,
  runId: "run",
  legId: "leg",
  generation: 2,
  token: "producer_capability_producer_capability_1234",
  cursor,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request: question,
  producerBaseUrl: "http://callback.test/",
  source: { repository: "acme/app" }
}

/** The grant before Source is ready for the author: it names no source. */
const { source: _source, ...sourceless } = grant

/** An install turn its author's browser session admitted: it reads main and the install's TODOs as them. */
const install: DurableChatGrant = {
  ...grant,
  installOrigin: "http://127.0.0.1:4567",
  api: { author: "ben", token: "smithers_" + "a".repeat(40) }
}

interface SourceCall {
  readonly authorization: string | null
  readonly body: unknown
}

/** The install's TODO routes as the API callback answers them: the route's status and body. */
const routes = (todos: Record<string, readonly [number, unknown]>) => (path: string): Response => {
  const [status, body] = todos[path] ?? [404, { code: "not_found", class: "user", message: "Not Found" }]
  return Response.json(body, { status })
}

/** No directory: what the list callback answers a test that lists nothing. */
const noDirectory = (): Response => Response.json({ status: "error", code: "not_found" }, { status: 404 })

/** The producer's journal and its source read, source list and API callbacks, recording what the host sent. */
const producer = (
  answer: (path: string) => Response,
  api: (path: string, init?: RequestInit) => Response = routes({}),
  list: (path: string) => Response = noDirectory
) => {
  const frames: Array<NativeAgent.AgentTurnFrame> = []
  const reads: Array<SourceCall> = []
  const lists: Array<SourceCall> = []
  const calls: Array<SourceCall> = []
  let expected = cursor
  const fetchImpl: NativeAgent.FetchLike = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/internal/chat/provider-started") return new Response(null, { status: 204 })
    if (url.pathname.startsWith("/api/")) {
      calls.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: {
          method: init?.method,
          path: url.pathname + url.search,
          ...(init?.method === "GET" ? {} : {
            payload: JSON.parse(String(init?.body)),
            key: new Headers(init?.headers).get("Idempotency-Key")
          })
        }
      })
      expect(new Headers(init?.headers).get("smithers-via")).toBe("smithers")
      expect(new Headers(init?.headers).get("x-forwarded-host")).toBe("127.0.0.1:4567")
      expect(init?.redirect).toBe("manual")
      return api(url.pathname + url.search, init)
    }
    const body = JSON.parse(String(init?.body))
    if (url.pathname === "/internal/chat/source/read") {
      reads.push({ authorization: new Headers(init?.headers).get("authorization"), body })
      return answer(body.path)
    }
    if (url.pathname === "/internal/chat/source/list") {
      lists.push({ authorization: new Headers(init?.headers).get("authorization"), body })
      return list(body.path)
    }
    const frame = body.frames[0] as NativeAgent.AgentTurnFrame
    frames.push(frame)
    const unsigned = {
      version: 1 as const,
      runId: "run",
      legId: "leg",
      batch: expected.batch + 1,
      from: expected.position + 1,
      previousHash: expected.hash,
      frames: [frame]
    }
    const hash = createHash("sha256").update(AgentTurnJournal.agentTurnJournalDigestInput("batch", unsigned)).digest(
      "hex"
    )
    expected = { version: 1, runId: "run", legId: "leg", batch: unsigned.batch, position: unsigned.from, hash }
    return Response.json({ status: "committed", batch: { ...unsigned, hash }, cursor: expected })
  }
  return { frames, reads, lists, calls, fetchImpl }
}

const file = (path: string, content: string, binary = false): Response =>
  Response.json({ repository: "acme/app", path, commit: COMMIT, content, binary })

/** One directory as the list callback answers it, in the repository host's order. */
const directory = (
  path: string,
  entries: ReadonlyArray<readonly [string, "file" | "dir"]>,
  truncated = false
): Response =>
  Response.json({
    repository: "acme/app",
    path,
    commit: COMMIT,
    entries: entries.map(([name, kind]) => ({ name, kind })),
    truncated
  })

/** The scratch repository the J1 question asks about: a package.json, a README and one test file. */
const scratchTree = (path: string): Response =>
  path === ""
    ? directory("", [["README.md", "file"], ["package.json", "file"], ["test", "dir"]])
    : path === "test"
    ? directory("test", [["smoke.test.mjs", "file"]])
    : noDirectory()
const SMOKE = "import test from \"node:test\"\ntest(\"greets\", () => {})\n"

interface LegUsage {
  readonly tool?: ModelEvent.UsageEvent | undefined
  readonly answer?: ModelEvent.UsageEvent | undefined
}

const reported: LegUsage = {
  tool: { type: "usage", inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
  answer: { type: "usage", inputTokens: 30, outputTokens: 5 }
}

/** A provider that asks for one tool call per leg until a tool result is in its context, then answers from it. */
const model = (
  calls: ReadonlyArray<{ readonly name: string; readonly arguments: string }>,
  usage: LegUsage = reported
) => {
  const requests: Array<ModelRequest.ModelRequest> = []
  const leg = (request: ModelRequest.ModelRequest): ReadonlyArray<ModelEvent.ModelEvent> => {
    const results = request.messages.flatMap((message) => message.role === "tool" ? [message] : [])
    const call = calls[results.length]
    if (call === undefined) {
      const said = results.at(-1)?.content.at(-1)?.content ?? "nothing read"
      return [
        { type: "text-delta", id: "t", text: `From the source: ${said}` },
        ...(usage.answer === undefined ? [] : [usage.answer]),
        { type: "settle", stopReason: "stop" }
      ]
    }
    const id = `call-${results.length}`
    return [
      { type: "tool-call-start", id, name: call.name },
      { type: "tool-call-end", id, arguments: call.arguments },
      ...(usage.tool === undefined ? [] : [usage.tool]),
      { type: "settle", stopReason: "tool-calls" }
    ]
  }
  return {
    requests,
    model: Model.make({
      stream: (request) => {
        requests.push(request)
        return Stream.fromIterable(leg(request))
      }
    })
  }
}

const run = (turn: DurableChatGrant, provider: ReturnType<typeof model>, journal: ReturnType<typeof producer>) =>
  Effect.runPromise(
    runDurableChatTurn(provider.model, turn, { modelId: "m" }, "http://callback.test", journal.fetchImpl)
  )

const toolNames = (request: ModelRequest.ModelRequest | undefined): ReadonlyArray<string> =>
  (request?.tools ?? []).map((tool) => tool.name)

/** A `commands` call that executes one command with argument text. */
const execute = (name: string, args?: string) => ({
  name: "commands",
  arguments: JSON.stringify({ action: "execute", name, ...(args === undefined ? {} : { args }) })
})
const readCall = (args: string) => execute("file", args)
const listCall = (args?: string) => execute("files", args)

const answerText = (frames: ReadonlyArray<NativeAgent.AgentTurnFrame>): string =>
  frames.flatMap((frame) => frame.type === "delta" && frame.kind === "text" ? [frame.text] : []).join("")

const systemText = (request: ModelRequest.ModelRequest | undefined): string =>
  (request?.system ?? []).map((part) => part.text).join("\n")

/** The model's copy of each tool result, in the order the last leg read them. */
const toolOutputs = (provider: ReturnType<typeof model>): ReadonlyArray<string> =>
  provider.requests.at(-1)?.messages.flatMap((message) =>
    message.role === "tool" ? message.content.map((part) => String(part.content)) : []
  ) ?? []

/** Literal TODO models, as the install's routes serve them: T12 queued, T13 merged, T14 dropped, T15 working. */
const queued: TodoCard.TodoCard = fixtures.queued.model
const stackHome = {
  ...homeFixtures.fresh.model,
  items: [
    { ...homeFixtures.active.model.items[0]!, ...queued, branch: { id: "todo-12", name: "todo/12" } },
    { ...homeFixtures.active.model.items[0]!, n: 13, state: "merged" as const },
    { ...homeFixtures.active.model.items[0]!, n: 14, state: "dropped" as const }
  ]
}
const stackRoutes = routes({
  "/api/stack": [200, stackHome],
  "/api/todos/12": [200, queued],
  "/api/todos/99": [404, { code: "todo_not_found", class: "user", message: "TODO not found" }]
})

/** The instructions' command lines for each grant, literal. */
const FILES_LINES = [
  "- /file <path>[:<line>[:<col>]] [owner/repo] [--ref <revision>] — Open and co-edit a file",
  "- /files [path] [owner/repo] — Browse a branch's files"
]
// Literal Appendix B HTTP, file and UI-only commands.
const HOST_COMMANDS = [
  "agent",
  "agent.edit",
  "background.dismiss",
  "background.retry",
  "branch",
  "branch.add-to-stack",
  "branch.archive",
  "branch.bring-in",
  "branch.discard-foreign",
  "branch.fork",
  "branch.rebase",
  "branch.rebase-now",
  "branches",
  "card.dismiss",
  "card.history.back",
  "card.history.forward",
  "change.facet",
  "chat.reload",
  "diff",
  "file",
  "files",
  "flow",
  "flow.edit",
  "flow.new",
  "flow.plan.select",
  "flow.plan.tab",
  "flow.run",
  "flows",
  "form.set",
  "github",
  "help",
  "history",
  "issue",
  "issue.comment",
  "issue.new",
  "issues",
  "learning.accept",
  "learning.dismiss",
  "merge",
  "monitor",
  "prs.tab",
  "review",
  "run",
  "run.inspect",
  "runs",
  "runs.coding.select",
  "runs.graph.execution",
  "runs.graph.follow",
  "runs.graph.select",
  "runs.graph.tab",
  "runs.steps",
  "runs.trace.filter",
  "runs.trace.live",
  "runs.trace.select",
  "runs.trace.view",
  "search",
  "search.changes",
  "search.files",
  "search.flows",
  "search.history",
  "search.issues",
  "search.runs",
  "search.wiki",
  "stack",
  "stack.move",
  "storage.recovery",
  "terminal",
  "theme",
  "todo",
  "todo.amend",
  "todo.answer",
  "todo.drop",
  "todo.new",
  "todo.resume",
  "todo.retry",
  "todo.return-to-item",
  "todo.steer",
  "todo.stop",
  "wiki",
  "wiki.backlinks",
  "wiki.delete",
  "wiki.graph",
  "wiki.open",
  "wiki.page",
  "wiki.space",
  "wiki.view"
]
const commandLines = (text: string): ReadonlyArray<string> => text.split("\n").filter((line) => line.startsWith("- /"))

/**
 * The runtime context the browser sends with its turns:
 * its capability and limitation lines, the tutorial, the Cloud session and the
 * repository check each name commands only the browser runs.
 */
const browserContext: AgentContext.AgentRuntimeContext = {
  version: AgentContext.AGENT_RUNTIME_CONTEXT_VERSION,
  product: "smithers",
  capturedAt: 1,
  revision: 3,
  surface: "chat",
  theme: "light",
  selectedWorldDocument: null,
  connectors: [],
  repositories: [{ id: "acme/app", name: "acme/app" }],
  activeRepository: "acme/app",
  github: { connected: true, login: "ben", repositories: 1, repositoryNames: ["acme/app"] },
  cloud: { state: "signed-out", username: null },
  repositoryUpdate: {
    repo: "acme/app",
    checkedAt: 1,
    openIssues: 0,
    openPrs: 0,
    problems: [],
    items: [],
    truncated: false
  },
  onboarding: { step: 0, stepCount: 3, transcript: ["Welcome to Smithers."] },
  worldState: { documentCount: 0, documents: [] },
  capabilities: [
    "Hold a streaming conversation in this chat and read its visible transcript.",
    "Run app commands through the \"commands\" tool — the same code path as the UI buttons and slash commands.",
    "Render structured cards (plans, approvals, statuses, recommendations) in the transcript.",
    "Create, list, and run Smithers flows on the user's loaded repositories (flow.create, flow.list, flow.run). Runs report live as embedded cards in this chat."
  ],
  limitations: [
    "Cannot see or control the host environment beyond what this context block states.",
    "The visitor is signed out, exploring acme/app: anything that writes needs GitHub sign-in, so when they ask for one execute auth.prompt instead.",
    "Flow runs execute on the user's workspace gateway; any outbound act a run wants (pushes, PRs) pauses for the human's explicit approval. Never promise one landed without it.",
    "This host cannot connect local repositories."
  ]
}

/** Commands the browser's context and instructions name that the install's host does not run. */
const BROWSER_ONLY = [
  "flow.create",
  "flow.list",
  "auth.prompt",
  "cloud.prompt",
  "onboarding.act",
  "repo.update",
  "repo.overview",
  "debug.errors",
  "the same code path as the UI buttons"
]

describe("host-owned turns run their tool calls on the host", () => {
  test("a question reads main through the producer, shows a File card and answers from the file", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([readCall("JOURNEY.md")])
    await run(grant, provider, journal)

    expect(journal.reads).toEqual([{
      authorization: "Bearer producer_capability_producer_capability_1234",
      body: { turnId: grant.turnId, generation: 2, path: "JOURNEY.md" }
    }])
    expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "card", "call.settled", "delta", "done"])
    for (const frame of journal.frames) expect(NativeAgent.AgentTurnFrameSchema.safeParse(frame).success).toBe(true)
    expect(journal.frames[0]).toEqual({
      runId: "run",
      type: "call.started",
      link: 0,
      ordinal: 0,
      name: "file",
      description: "Open and co-edit a file",
      arguments: "JOURNEY.md"
    })
    expect(journal.frames[1]).toMatchObject({
      runId: "run",
      type: "card",
      card: {
        id: "file-acme/app-JOURNEY.md",
        kind: "file",
        title: "File · acme/app · JOURNEY.md",
        status: "active",
        ordinal: 0,
        payload: {
          repo: "acme/app",
          path: "JOURNEY.md",
          content: JOURNEY,
          truncated: false,
          address: "/acme/app/JOURNEY.md",
          readAt: { changeId: null, commitId: COMMIT, source: "head" }
        }
      }
    })
    expect(journal.frames[2]).toEqual({
      runId: "run",
      type: "call.settled",
      link: 0,
      ordinal: 0,
      name: "file",
      verdict: "run"
    })
    // The continuation carries the call and the file's text, so the answer is grounded in it.
    expect(answerText(journal.frames)).toBe(`From the source: JOURNEY.md in acme/app:\n${JOURNEY}`)
    expect(journal.frames.at(-1)).toEqual({
      runId: "run",
      type: "done",
      reason: "stop",
      usage: { inputTokens: 40, outputTokens: 7, cachedInputTokens: 4 }
    })
    expect(provider.requests).toHaveLength(2)
    // The app agent's one tool, the same contract the browser offers.
    expect(provider.requests[0]?.tools).toHaveLength(1)
    expect(toolNames(provider.requests[0])).toEqual(["commands"])
    expect(provider.requests[0]?.tools[0]?.parameters as ModelRequest.JsonObject).toEqual(
      AgentCommands.commandsToolSpec.parameters
    )
    expect(provider.requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    // No renderer tool loop is asked to continue: no tool_call frame is committed.
    expect(journal.frames.some((frame) => frame.type === "tool_call")).toBe(false)
  })

  test("an open question lists the repository, then reads the file the listing shows", async () => {
    const journal = producer((path) => file(path, SMOKE), routes({}), scratchTree)
    const provider = model([listCall(), listCall("test"), readCall("test/smoke.test.mjs")])
    await run(
      {
        ...grant,
        request: { ...question, messages: [{ role: "user", content: "What does the test in this repository check?" }] }
      },
      provider,
      journal
    )

    const capability = "Bearer producer_capability_producer_capability_1234"
    expect(journal.lists).toEqual([
      { authorization: capability, body: { turnId: grant.turnId, generation: 2, path: "" } },
      { authorization: capability, body: { turnId: grant.turnId, generation: 2, path: "test" } }
    ])
    expect(journal.reads.map((call) => (call.body as { path: string }).path)).toEqual(["test/smoke.test.mjs"])
    expect(journal.frames.map((frame) => frame.type)).toEqual([
      ...["call.started", "card", "call.settled"],
      ...["call.started", "card", "call.settled"],
      ...["call.started", "card", "call.settled"],
      "delta",
      "done"
    ])
    for (const frame of journal.frames) expect(NativeAgent.AgentTurnFrameSchema.safeParse(frame).success).toBe(true)
    const cards = journal.frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])
    expect(cards.map((card) => [card.id, card.kind, card.title, card.ordinal])).toEqual([
      ["files-acme/app-/", "file-list", "Files · acme/app · /", 0],
      ["files-acme/app-test", "file-list", "Files · acme/app · test", 1],
      ["file-acme/app-test/smoke.test.mjs", "file", "File · acme/app · test/smoke.test.mjs", 2]
    ])
    // The card lists the directory in the one listing order, at main's commit.
    expect(cards[0]?.payload).toEqual({
      repo: "acme/app",
      path: "",
      entries: [{ name: "test", kind: "dir" }, { name: "package.json", kind: "file" }, {
        name: "README.md",
        kind: "file"
      }],
      address: "/acme/app/",
      readAt: { changeId: null, commitId: COMMIT, source: "head" }
    })
    expect(journal.frames.filter((frame) => frame.type === "call.settled")).toEqual(
      ["files", "files", "file"].map((name, ordinal) => ({
        runId: "run",
        type: "call.settled",
        link: ordinal,
        ordinal,
        name,
        verdict: "run"
      }))
    )
    // Each continuation carries what the card shows, so the answer is grounded in the file.
    expect(toolOutputs(provider)).toEqual([
      "/ in acme/app:\ntest/\npackage.json\nREADME.md",
      "test in acme/app:\nsmoke.test.mjs",
      `test/smoke.test.mjs in acme/app:\n${SMOKE}`
    ])
    expect(answerText(journal.frames)).toBe(`From the source: test/smoke.test.mjs in acme/app:\n${SMOKE}`)
    expect(journal.frames.at(-1)).toMatchObject({ type: "done", reason: "stop" })
    // A turn that can list is told to list, never to guess a path.
    expect(systemText(provider.requests[0])).toContain(
      "Asked about the repository's code without a file named, run files with no argument to list the root, then list or read the paths it shows; never guess a path."
    )
  })

  test("a listing takes the flow's own arguments: the root as no path or a slash, a quoted directory, the turn's repository", async () => {
    const journal = producer(
      (path) => file(path, JOURNEY),
      routes({}),
      (path) => directory(path, [["a.md", "file"]], path === "Meeting Notes")
    )
    const provider = model([
      listCall(),
      listCall("/"),
      execute("/files", "/docs/"),
      listCall("\"Meeting Notes\" acme/app")
    ])
    await run(grant, provider, journal)
    expect(journal.lists.map((call) => (call.body as { path: string }).path)).toEqual([
      "",
      "",
      "docs",
      "Meeting Notes"
    ])
    const cards = journal.frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])
    expect(cards.map((card) => card.id)).toEqual([
      "files-acme/app-/",
      "files-acme/app-/",
      "files-acme/app-docs",
      "files-acme/app-Meeting Notes"
    ])
    // A directory the host cut short says so on its card and to the model.
    expect(cards[3]?.payload).toMatchObject({ path: "Meeting Notes", truncated: true })
    expect(cards[0]?.payload).not.toHaveProperty("truncated")
    expect(toolOutputs(provider)[3]).toBe(
      "Meeting Notes in acme/app:\na.md\n(The directory has more entries than one listing shows.)"
    )
  })

  test("a path may name the turn's repository, start with ./ or be ., as a model writes them", async () => {
    // Each call a real model made on an install, refused before: `.`, and the repository as the path.
    const listings = producer((path) => file(path, JOURNEY), routes({}), (path) => directory(path, [["a.md", "file"]]))
    await run(
      grant,
      model([
        listCall("."),
        listCall("acme/app"),
        listCall("/acme/app/docs/"),
        listCall("./docs"),
        listCall("docs app"),
        listCall("acme/application")
      ]),
      listings
    )
    expect(listings.lists.map((call) => (call.body as { path: string }).path)).toEqual([
      "",
      "",
      "docs",
      "docs",
      "docs",
      "acme/application"
    ])
    const reads = producer((path) => file(path, JOURNEY))
    await run(
      grant,
      model([
        readCall("acme/app/JOURNEY.md"),
        readCall("./docs/guide.md:2"),
        readCall("JOURNEY.md app"),
        readCall("acme/app"),
        readCall("./")
      ]),
      reads
    )
    expect(reads.reads.map((call) => (call.body as { path: string }).path)).toEqual([
      "JOURNEY.md",
      "docs/guide.md",
      "JOURNEY.md"
    ])
    // A path that names no file once the repository is taken off it is refused before any read.
    const refused = reads.frames.flatMap((frame) => frame.type === "gate.rejected" ? [frame.message] : [])
    expect(refused).toEqual(["file needs a file path", "file needs a file path"])
  })

  test("each listing refusal is stated to the model and the conversation, and the turn answers", async () => {
    const codes: Record<string, [number, string]> = {
      "../secret": [400, "path_refused"],
      "JOURNEY.md": [404, "not_found"],
      "private": [403, "forbidden"],
      "src": [409, "source_not_ready"],
      "down": [503, "source_failed"]
    }
    const said: Record<string, string> = {
      "../secret":
        "../secret is not a path inside this repository. Name a directory by its path from the repository root, for example src, or list the root with no path.",
      "JOURNEY.md": "JOURNEY.md is not a directory on main.",
      "private": "The person who asked can't read this repository.",
      "src":
        "The repository's source isn't ready yet: setup is still mirroring main. Ask again once Source ready shows in setup.",
      "down": "The repository read did not answer. Ask again."
    }
    for (const [path, [status, code]] of Object.entries(codes)) {
      const journal = producer(
        (read) => file(read, JOURNEY),
        routes({}),
        () => Response.json({ status: "error", code }, { status })
      )
      await run(grant, model([listCall(path)]), journal)
      expect(journal.lists).toHaveLength(1)
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "gate.rejected", "delta", "done"])
      expect(journal.frames[1]).toEqual({
        runId: "run",
        type: "gate.rejected",
        link: 0,
        kind: "call_failed",
        message: said[path]
      })
      expect(answerText(journal.frames)).toBe(`From the source: failed: ${said[path]}`)
      expect(journal.frames.at(-1)).toMatchObject({ type: "done", reason: "stop" })
    }
    // A callback that does not answer a directory is stated the same way.
    const unanswered: ReadonlyArray<() => Response> = [
      () => {
        throw new TypeError("fetch failed")
      },
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () =>
        Response.json({
          repository: "acme/app",
          path: "",
          commit: COMMIT,
          entries: [{ name: "x", kind: "link" }],
          truncated: false
        }),
      () => file("JOURNEY.md", JOURNEY)
    ]
    for (const answer of unanswered) {
      const journal = producer((read) => file(read, JOURNEY), routes({}), answer)
      await run(grant, model([listCall()]), journal)
      expect(journal.lists).toHaveLength(1)
      expect(answerText(journal.frames)).toBe("From the source: failed: The repository read did not answer. Ask again.")
    }
    // Arguments the grammar or the turn refuses never reach the producer.
    for (
      const [args, message] of [
        ["a b c", "files takes a path and optionally an owner/repo"],
        ["\"unfinished", "Close the quoted file argument before the next argument."],
        ["src other/repo", "This question reads acme/app only; name a directory in it."]
      ] as const
    ) {
      const journal = producer((read) => file(read, JOURNEY), routes({}), scratchTree)
      await run(grant, model([listCall(args)]), journal)
      expect(journal.lists).toEqual([])
      expect(journal.frames[1]).toMatchObject({ type: "gate.rejected", kind: "call_failed", message })
    }
  })

  test("the list action answers the commands this host runs", async () => {
    const listing = JSON.stringify({
      commands: [{
        name: "file",
        summary: "Open and co-edit a file",
        args: "<path>[:<line>[:<col>]] [owner/repo] [--ref <revision>]"
      }, {
        name: "files",
        summary: "Browse a branch's files",
        args: "[path] [owner/repo]"
      }]
    })
    for (
      const [listed, answer] of [
        [{ action: "list" }, listing],
        [{ action: "list", namespace: "files" }, JSON.stringify({ commands: [JSON.parse(listing).commands[1]] })],
        [{ action: "list", namespace: "/files." }, JSON.stringify({ commands: [JSON.parse(listing).commands[1]] })],
        [{ action: "list", query: "read a file" }, listing],
        [{ action: "list", namespace: "file" }, JSON.stringify({ commands: [JSON.parse(listing).commands[0]] })],
        [{ action: "list", namespace: "repo" }, JSON.stringify({ commands: [] })]
      ] as const
    ) {
      const journal = producer((path) => file(path, JOURNEY))
      await run(grant, model([{ name: "commands", arguments: JSON.stringify(listed) }]), journal)
      expect(journal.reads).toEqual([])
      expect(journal.frames.map((frame) => frame.type)).toEqual(["delta", "done"])
      expect(answerText(journal.frames), JSON.stringify(listed)).toBe(`From the source: ${answer}`)
    }
  })

  test("the command takes the flow's own arguments: a slash name, a line anchor and a quoted path", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    await run(
      grant,
      model([execute("/file", "docs/guide.md:3:2 acme/app"), execute("file", "\"docs/Meeting Notes.md\"")]),
      journal
    )
    expect(journal.reads.map((call) => (call.body as { path: string }).path)).toEqual([
      "docs/guide.md",
      "docs/Meeting Notes.md"
    ])
    const cards = journal.frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])
    expect(cards.map((card) => [card.id, card.payload])).toMatchObject([
      ["file-acme/app-docs/guide.md", { path: "docs/guide.md", line: 3, column: 2 }],
      ["file-acme/app-docs/Meeting Notes.md", { path: "docs/Meeting Notes.md" }]
    ])
    expect(cards[1]?.payload).not.toHaveProperty("line")
  })

  test("binary files are stated and long files are cut at the card cap", async () => {
    const long = "x".repeat(16 * 1024 + 9)
    const journal = producer((path) => path === "logo.png" ? file(path, "", true) : file(path, long))
    const provider = model([readCall("logo.png:4"), readCall("big.txt")])
    await run(grant, provider, journal)
    const cards = journal.frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])
    expect(cards.map((card) => card.payload)).toEqual([
      {
        repo: "acme/app",
        path: "logo.png",
        content: "",
        truncated: false,
        binary: true,
        address: "/acme/app/logo.png",
        readAt: { changeId: null, commitId: COMMIT, source: "head" }
      },
      {
        repo: "acme/app",
        path: "big.txt",
        content: "x".repeat(16 * 1024),
        truncated: true,
        address: "/acme/app/big.txt",
        readAt: { changeId: null, commitId: COMMIT, source: "head" }
      }
    ])
    expect(cards.map((card) => card.ordinal)).toEqual([0, 1])
    const outputs =
      provider.requests[2]?.messages.flatMap((message) =>
        message.role === "tool" ? message.content.map((part) => part.content) : []
      ) ?? []
    expect(outputs[0]).toBe("logo.png in acme/app is a binary file; its bytes are not shown.")
    // The model's copy is bounded to the shared tool result limit.
    expect(new TextEncoder().encode(outputs[1]).byteLength).toBeLessThanOrEqual(16 * 1024)
    expect(outputs[1]).toContain(
      "big.txt in acme/app (truncated at the card cap; the rest stays in the repository):\nxxx"
    )
    expect(outputs[1]).toContain("Tool result truncated")
  })

  test("each refusal is stated to the model and the conversation, and the turn answers", async () => {
    const codes: Record<string, [number, string]> = {
      "../secret": [400, "path_refused"],
      "link": [404, "not_found"],
      "big.bin": [413, "too_large"],
      "private.md": [403, "forbidden"],
      "mirror.md": [409, "source_not_ready"],
      "down.md": [503, "source_failed"]
    }
    const said: Record<string, string> = {
      "../secret":
        "../secret is not a path inside this repository. Name a file by its path from the repository root, for example src/index.ts.",
      "link": "link is not a file on main.",
      "big.bin": "big.bin is larger than the repository read limit, so it is not shown.",
      "private.md": "The person who asked can't read this repository.",
      "mirror.md":
        "The repository's source isn't ready yet: setup is still mirroring main. Ask again once Source ready shows in setup.",
      "down.md": "The repository read did not answer. Ask again."
    }
    for (const [path, [status, code]] of Object.entries(codes)) {
      const journal = producer(() => Response.json({ status: "error", code }, { status }))
      const provider = model([readCall(path)])
      await run(grant, provider, journal)
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "gate.rejected", "delta", "done"])
      expect(journal.frames[1]).toEqual({
        runId: "run",
        type: "gate.rejected",
        link: 0,
        kind: "call_failed",
        message: said[path]
      })
      expect(answerText(journal.frames)).toBe(`From the source: failed: ${said[path]}`)
      expect(journal.frames.at(-1)).toMatchObject({ type: "done", reason: "stop" })
    }
  })

  test("a read that does not answer is stated, and the turn answers", async () => {
    const unanswered = "failed: The repository read did not answer. Ask again."
    const answers: ReadonlyArray<() => Response> = [
      () => {
        throw new TypeError("fetch failed")
      },
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => Response.json({ repository: "acme/app", path: "JOURNEY.md" })
    ]
    for (const answer of answers) {
      const journal = producer(answer)
      await run(grant, model([readCall("JOURNEY.md")]), journal)
      expect(journal.reads).toHaveLength(1)
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "gate.rejected", "delta", "done"])
      expect(answerText(journal.frames)).toBe(`From the source: ${unanswered}`)
    }
    // A refused path is quoted by its head, never whole.
    const long = "a/".repeat(150) + "b"
    const journal = producer(() => Response.json({ status: "error", code: "path_refused" }, { status: 400 }))
    await run(grant, model([readCall(long)]), journal)
    expect(journal.frames[1]).toMatchObject({
      type: "gate.rejected",
      message: `${
        long.slice(0, 200)
      }… is not a path inside this repository. Name a file by its path from the repository root, for example src/index.ts.`
    })
  })

  test("the terminal frame states the counts every leg reported", async () => {
    const read = readCall("JOURNEY.md")
    const cases: ReadonlyArray<[LegUsage, unknown]> = [
      [{ tool: reported.tool }, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 }],
      [{ answer: reported.answer }, { inputTokens: 30, outputTokens: 5 }],
      [{ tool: { type: "usage", inputTokens: 10, outputTokens: 2 }, answer: reported.answer }, {
        inputTokens: 40,
        outputTokens: 7
      }],
      [
        {
          tool: { type: "usage", inputTokens: 10, outputTokens: 2 },
          answer: { type: "usage", inputTokens: 30, outputTokens: 5, cachedInputTokens: 3 }
        },
        { inputTokens: 40, outputTokens: 7, cachedInputTokens: 3 }
      ],
      [{}, undefined]
    ]
    for (const [usage, total] of cases) {
      const journal = producer((path) => file(path, JOURNEY))
      await run(grant, model([read], usage), journal)
      expect(journal.frames.at(-1)).toEqual({
        runId: "run",
        type: "done",
        reason: "stop",
        ...(total === undefined ? {} : { usage: total })
      })
    }
  })

  test("calls the host cannot run never reach the producer", async () => {
    const commandFailures: ReadonlyArray<[{ readonly name: string; readonly arguments: string }, string]> = [
      [{ name: "commands", arguments: "not json" }, "failed: the commands tool arguments were not valid JSON"],
      [{ name: "commands", arguments: "[]" }, "failed: the commands tool arguments must be an object"],
      [
        { name: "commands", arguments: JSON.stringify({ action: "run" }) },
        "failed: the commands tool action must be \"list\" or \"execute\""
      ],
      [
        { name: "commands", arguments: JSON.stringify({ action: "execute", name: "/" }) },
        "failed: the execute action requires a command name"
      ],
      [
        execute("files.write", "JOURNEY.md"),
        "unknown-command: files.write — no command has that name; use the list action for every command callable right now"
      ],
      [{ name: "shell", arguments: JSON.stringify({ command: "rm -rf /" }) }, "unknown-tool: shell"],
      [{ name: "files_read", arguments: JSON.stringify({ path: "JOURNEY.md" }) }, "unknown-tool: files_read"]
    ]
    for (const [call, output] of commandFailures) {
      const journal = producer((path) => file(path, JOURNEY))
      await run(grant, model([call]), journal)
      expect(journal.reads).toEqual([])
      // Nothing ran, so the journal records no call.
      expect(journal.frames.map((frame) => frame.type)).toEqual(["delta", "done"])
      expect(answerText(journal.frames)).toBe(`From the source: ${output}`)
    }
    const refusedReads: ReadonlyArray<[string | undefined, string]> = [
      [undefined, "file needs a file path"],
      ["\"unfinished", "Close the quoted file argument before the next argument."],
      ["a b c", "file takes a path and optionally an owner/repo"],
      ["JOURNEY.md:0", "file lines and columns count from 1: /file <path>[:<line>[:<col>]]"],
      ["JOURNEY.md other/repo", "This question reads acme/app only; name a file in it."],
      ["JOURNEY.md --ref feature", "This question reads main only; ask without --ref."]
    ]
    for (const [args, message] of refusedReads) {
      const journal = producer((path) => file(path, JOURNEY))
      await run(grant, model([execute("file", args)]), journal)
      expect(journal.reads).toEqual([])
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "gate.rejected", "delta", "done"])
      expect(journal.frames[1]).toMatchObject({ type: "gate.rejected", kind: "call_failed", message })
      expect(answerText(journal.frames)).toBe(`From the source: failed: ${message}`)
    }
  })

  test("a turn whose grant names no source is offered no tool and runs none", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([readCall("JOURNEY.md")])
    await run(sourceless, provider, journal)
    expect(toolNames(provider.requests[0])).toEqual([])
    expect(journal.reads).toEqual([])
    expect(journal.frames.map((frame) => frame.type)).toEqual(["delta", "done"])
    expect(answerText(journal.frames)).toBe("From the source: unknown-tool: commands")
  })

  test("a turn still calling tools after the leg bound ends at the tool limit", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model(Array.from({ length: AgentToolResult.MAX_TOOL_LEGS + 1 }, () => readCall("JOURNEY.md")))
    await run(grant, provider, journal)
    expect(provider.requests).toHaveLength(AgentToolResult.MAX_TOOL_LEGS)
    expect(journal.reads).toHaveLength(AgentToolResult.MAX_TOOL_LEGS - 1)
    expect(journal.frames.at(-1)).toEqual({
      runId: "run",
      type: "done",
      reason: "tool_limit",
      usage: {
        inputTokens: 10 * AgentToolResult.MAX_TOOL_LEGS,
        outputTokens: 2 * AgentToolResult.MAX_TOOL_LEGS,
        cachedInputTokens: 4 * AgentToolResult.MAX_TOOL_LEGS
      }
    })
    // A provider that reports no counts ends the turn without any.
    const silent = producer((path) => file(path, JOURNEY))
    await run(
      grant,
      model(Array.from({ length: AgentToolResult.MAX_TOOL_LEGS }, () => readCall("JOURNEY.md")), {}),
      silent
    )
    expect(silent.frames.at(-1)).toEqual({ runId: "run", type: "done", reason: "tool_limit" })
  })

  test("client tool declarations never replace host command execution", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([{ name: "commands", arguments: JSON.stringify({ action: "list" }) }])
    await run({ ...grant, request: { ...question, tools: [AgentCommands.commandsToolSpec] } }, provider, journal)
    expect(toolNames(provider.requests[0])).toEqual(["commands"])
    expect(provider.requests).toHaveLength(2)
    expect(journal.reads).toEqual([])
    expect(journal.frames.some((frame) => frame.type === "tool_call")).toBe(false)
    expect(journal.frames.at(-1)).toMatchObject({ type: "done", reason: "stop" })
  })
})

describe("an install's host runs the catalog commands its grant allows, as the turn's author", () => {
  test("the instructions and the list name exactly the commands the grant runs, never the request's own", async () => {
    const cases: ReadonlyArray<[DurableChatGrant, ReadonlyArray<string>]> = [
      [install, HOST_COMMANDS],
      [grant, ["file", "files"]],
      [{ ...sourceless, api: install.api! }, HOST_COMMANDS.filter((name) => name !== "file" && name !== "files")]
    ]
    for (const [turn, names] of cases) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([{ name: "commands", arguments: JSON.stringify({ action: "list" }) }])
      await run(turn, provider, journal)
      const system = systemText(provider.requests[0])
      expect(commandLines(system).map((line) => line.slice(3).split(" ")[0])).toEqual(names)
      expect(system).not.toContain(question.instructions)
      expect(toolNames(provider.requests[0])).toEqual(["commands"])
      const listed = JSON.parse(toolOutputs(provider)[0]!) as { commands: ReadonlyArray<{ name: string }> }
      expect(listed.commands.map((command) => command.name)).toEqual(names)
      expect(journal.calls).toEqual([])
    }
    const provider = model([])
    await run(install, provider, producer((path) => file(path, JOURNEY)))
    const lines = commandLines(systemText(provider.requests[0]))
    expect(lines).toContain("- /todo.stop — Pause a working TODO")
    expect(lines.find((line) => line.startsWith("- /todo.drop "))).toContain("asks the person")
    expect(lines.find((line) => line.startsWith("- /merge "))).toContain("asks the person")
    expect(lines.filter((line) => line.startsWith("- /file"))).toEqual(FILES_LINES)
  })

  test("verified grant Markdown survives the host prompt while browser instructions do not", async () => {
    const provider = model([])
    await run(
      { ...install, agentInstructions: "Always end with DONE.\n```js\nthrow new Error('data-only')\n```" },
      provider,
      producer((path) => file(path, JOURNEY))
    )
    const system = systemText(provider.requests[0])
    expect(system).toContain("Always end with DONE.")
    expect(system).toContain("throw new Error('data-only')")
    expect(system).not.toContain(question.instructions)
    expect(commandLines(system).map((line) => line.slice(3).split(" ")[0])).toEqual(HOST_COMMANDS)
  })

  test("the instructions keep the app agent's standing rules beside the install's commands", async () => {
    const cases: ReadonlyArray<[DurableChatGrant, string]> = [
      [install, "through file and files"],
      [
        {
          ...sourceless,
          installOrigin: "http://127.0.0.1:4567",
          api: { author: "ben", token: "smithers_" + "a".repeat(40) }
        },
        "read arbitrary files off the user's machine; push"
      ]
    ]
    for (const [turn, files] of cases) {
      const provider = model([])
      await run(turn, provider, producer((path) => file(path, JOURNEY), stackRoutes))
      const system = systemText(provider.requests[0])
      for (
        const line of [
          AgentInstructions.AGENT_NAME_LINE,
          AgentInstructions.ASSISTANT_ACTS_LINE,
          AgentInstructions.RUN_IS_NOT_RESULT_LINE,
          AgentInstructions.FAILED_RESULT_LINE,
          AgentInstructions.ACCOUNT_NUMBERS_LINE
        ]
      ) {
        expect(system).toContain(line)
      }
      for (const line of AgentInstructions.WORKFLOW_LAUNDERING_RULE) expect(system).toContain(line)
      expect(system).toContain(
        "Everything this list lacks is an ACT you cannot take yet; it is never a subject you cannot discuss. You cannot send or draft email"
      )
      expect(system).toContain(files)
    }
    // A turn that cannot list is never told to.
    const provider = model([])
    await run(
      {
        ...sourceless,
        installOrigin: "http://127.0.0.1:4567",
        api: { author: "ben", token: "smithers_" + "a".repeat(40) }
      },
      provider,
      producer((path) => file(path, JOURNEY), stackRoutes)
    )
    expect(systemText(provider.requests[0])).not.toContain("run files with no argument")
  })

  test("an install turn's context states the host's capabilities and names no command the host does not run", async () => {
    for (
      const turn of [install, grant, {
        ...sourceless,
        installOrigin: "http://127.0.0.1:4567",
        api: { author: "ben", token: "smithers_" + "a".repeat(40) }
      }]
    ) {
      const provider = model([])
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      await run({ ...turn, request: { ...question, context: browserContext } }, provider, journal)
      const system = systemText(provider.requests[0])
      for (const name of BROWSER_ONLY) expect(system).not.toContain(name)
      expect(system).toContain(
        "Run the commands the instructions list through the \"commands\" tool, as the person who asked; read the returned status before claiming success. Pending confirmations require the person to act."
      )
      expect(system).toContain(
        "Runs no command the instructions do not list: any other answers unknown-command, and nothing runs."
      )
      // The client's facts stay.
      expect(system).toContain("GitHub: CONNECTED as ben")
      expect(system).toContain("Active repository: acme/app")
    }
  })

  test("a turn whose grant runs nothing keeps its request's own instructions and context, and is offered no tool", async () => {
    for (const request of [question, { ...question, context: browserContext }]) {
      const journal = producer((path) => file(path, JOURNEY))
      const provider = model([])
      await run({ ...sourceless, request }, provider, journal)
      expect(systemText(provider.requests[0])).toBe(
        AgentContext.composeAgentInstructions(request.instructions, request.context)
      )
      expect(toolNames(provider.requests[0])).toEqual([])
    }
  })

  test("the list action narrows the install's commands by namespace", async () => {
    const journal = producer((path) => file(path, JOURNEY), stackRoutes)
    const provider = model([{ name: "commands", arguments: JSON.stringify({ action: "list", namespace: "todo" }) }])
    await run(install, provider, journal)
    const listed = JSON.parse(toolOutputs(provider)[0]!)
    expect(listed.commands.map((row: { name: string }) => row.name)).toEqual([
      "todo",
      "todo.amend",
      "todo.answer",
      "todo.drop",
      "todo.new",
      "todo.resume",
      "todo.retry",
      "todo.return-to-item",
      "todo.steer",
      "todo.stop"
    ])
    const stop = listed.commands.find((row: { name: string }) => row.name === "todo.stop")
    expect(JSON.parse(stop.args)).toEqual({
      type: "object",
      properties: { n: { type: "integer", minimum: 1 } },
      required: ["n"],
      additionalProperties: false,
      $defs: {}
    })
    expect(journal.calls).toEqual([])
  })

  test("/stack reads the shared Home projection through the catalog endpoint", async () => {
    const journal = producer((path) => file(path, JOURNEY), stackRoutes)
    const provider = model([execute("stack", "  ")])
    await run(install, provider, journal)
    expect(journal.calls).toEqual([{
      authorization: "Bearer smithers_" + "a".repeat(40),
      body: { method: "GET", path: "/api/stack" }
    }, {
      authorization: "Bearer smithers_" + "a".repeat(40),
      body: { method: "GET", path: "/api/todos/12" }
    }])
    expect(journal.frames[1]).toMatchObject({
      type: "card",
      card: { id: "todo:12", kind: "todo", payload: { n: 12, model: queued } }
    })
    expect(journal.reads).toEqual([])
    expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "card", "call.settled", "delta", "done"])
    for (const frame of journal.frames) expect(NativeAgent.AgentTurnFrameSchema.safeParse(frame).success).toBe(true)
    expect(JSON.parse(toolOutputs(provider)[0]!)).toMatchObject({ items: [{ n: 12 }, { n: 13 }, { n: 14 }] })
  })

  test("an empty stack needs no detail requests; a failed or mismatched detail refuses", async () => {
    const empty = producer((path) => file(path, JOURNEY), routes({ "/api/stack": [200, homeFixtures.fresh.model] }))
    const provider = model([execute("stack")])
    await run(install, provider, empty)
    expect(empty.calls).toHaveLength(1)
    expect(empty.frames.some((frame) => frame.type === "card")).toBe(false)
    expect(JSON.parse(toolOutputs(provider)[0]!)).toEqual(homeFixtures.fresh.model)
    for (const detail of [[403, { code: "forbidden" }], [200, { ...queued, n: 99 }], [200, {}]] as const) {
      const journal = producer(
        (path) => file(path, JOURNEY),
        routes({ "/api/stack": [200, stackHome], "/api/todos/12": detail })
      )
      const provider = model([execute("stack")])
      await run(install, provider, journal)
      expect(journal.calls).toHaveLength(2)
      expect(journal.frames.some((frame) => frame.type === "card")).toBe(false)
      expect(toolOutputs(provider)).toEqual(["failed: Invalid TODO response"])
    }
  })

  test("/todo Tn reads one TODO and shows its TODO card", async () => {
    for (const args of ["T12", "{\"n\":12}"]) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([execute("/todo", args)])
      await run(install, provider, journal)
      expect(journal.calls.map((call) => call.body)).toEqual([
        { method: "GET", path: "/api/todos/12" }
      ])
      expect(journal.frames.map((frame) => frame.type)).toEqual([
        "call.started",
        "card",
        "call.settled",
        "delta",
        "done"
      ])
      expect(journal.frames[1]).toMatchObject({
        type: "card",
        card: {
          id: "todo:12",
          kind: "todo",
          title: "Card model contracts",
          payload: { n: 12, model: queued, requests: [] }
        }
      })
      expect(JSON.parse(toolOutputs(provider)[0]!)).toEqual(queued)
    }
  })

  test("catalog mutations use literal HTTP bindings and host-owned idempotency keys", async () => {
    const cases = [
      ["todo.stop", "T12", "POST", "/api/todos/12", { op: "stop" }],
      ["todo.resume", "T12", "POST", "/api/todos/12", { op: "resume" }],
      ["todo.retry", "T12", "POST", "/api/todos/12", { op: "retry" }],
      ["todo.steer", "T12 Keep the greeting", "POST", "/api/todos/12", { steer: "Keep the greeting" }],
      ["todo.amend", "T12 New prompt", "PATCH", "/api/todos/12", { prompt: "New prompt" }],
      ["stack.move", "T12 down", "POST", "/api/todos/12", { op: "move", direction: "down" }],
      ["todo.answer", "{\"n\":12,\"answer\":\"Yes\",\"wait\":\"w1\"}", "POST", "/api/todos/12/answer", {
        answer: "Yes",
        wait: "w1"
      }],
      ["branch.fork", "{\"from\":\"main\",\"name\":\"greeting\"}", "POST", "/api/branches", {
        from: "main",
        name: "greeting"
      }]
    ] as const
    for (const [name, args, method, path, payload] of cases) {
      const journal = producer((path) => file(path, JOURNEY), () =>
        name === "todo.amend"
          ? Response.json({ confirmation: "confirm-amend", state: "pending" }, { status: 202 })
          : new Response(null, { status: 204 }))
      const provider = model([execute(name, args)])
      await run(install, provider, journal)
      expect(journal.calls, name).toEqual([{
        authorization: "Bearer smithers_" + "a".repeat(40),
        body: { method, path, payload, key: `chat:${install.turnId}:0` }
      }])
      expect(toolOutputs(provider), name).toEqual([
        name === "todo.amend"
          ? "{\"confirmation\":\"confirm-amend\",\"state\":\"pending\"}" :
          "{\"status\":204,\"body\":null}"
      ])
    }
  })

  test("GitHub Retry uses one accepted catalog request without confirmation", async () => {
    const journal = producer(
      (path) => file(path, JOURNEY),
      routes({ "/api/github/sync": [202, { state: "accepted" }] })
    )
    const provider = model([execute("github", "{\"operation\":\"retry\"}")])
    await run(install, provider, journal)
    expect(journal.calls).toEqual([{
      authorization: "Bearer smithers_" + "a".repeat(40),
      body: { method: "POST", path: "/api/github/sync", payload: {}, key: `chat:${install.turnId}:0` }
    }])
    expect(toolOutputs(provider)).toEqual(["{\"status\":202,\"body\":{\"state\":\"accepted\"}}"])
  })

  test("read-only catalog bindings reject browser-only variants without dispatch", async () => {
    for (
      const [name, args] of [
        ["github", "{\"operation\":\"app-open\"}"],
        ["github", "{\"operation\":\"app-choose\",\"installationId\":\"1\"}"],
        ["github", "{\"operation\":\"reconcile\"}"],
        ["github", "{\"operation\":\"retry\",\"repo\":\"other/repo\"}"],
        [
          "runs",
          "{\"operation\":\"attention\"}"
        ]
      ] as const
    ) {
      const journal = producer((path) => file(path, JOURNEY))
      const provider = model([execute(name, args)])
      await run(install, provider, journal)
      expect(journal.calls).toEqual([])
      expect(toolOutputs(provider)).toEqual([`failed: Invalid arguments for ${name}; use its declared payload.`])
    }
  })

  test("flow show uses the served catalog", async () => {
    const catalog = [{ name: "todo", system: false, source: { builtin: true }, versions: [] }]
    const journal = producer((path) => file(path, JOURNEY), routes({ "/api/flows": [200, catalog] }))
    const provider = model([execute("flow", "todo")])
    await run(install, provider, journal)
    expect(journal.frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])).toMatchObject([{
      kind: "flow",
      payload: { name: "todo" }
    }])
    expect(journal.calls).toHaveLength(1)
  })

  test("API forwarding uses a direct listener's configured port", async () => {
    const { installOrigin: _origin, ...direct } = install
    const call = apiCaller("http://127.0.0.1:5678", direct, async (url, init) => {
      expect(new URL(String(url)).port).toBe("5678")
      expect(new Headers(init?.headers).get("x-forwarded-host")).toBe("127.0.0.1:5678")
      return Response.json({ ok: true })
    })
    expect(await Effect.runPromise(call("/api/flows"))).toEqual({ status: 200, body: { ok: true } })
  })

  test.each(["http://127.0.0.1:4567", "https://mini.example:8443", "http://[::1]:4001"])(
    "API forwarding preserves the install origin without moving its credential off the private callback (%s)",
    async (installOrigin) => {
      const publicOrigin = new URL(installOrigin)
      const call = apiCaller("http://127.0.0.1:5678", { ...install, installOrigin }, async (url, init) => {
        expect(String(url)).toBe("http://127.0.0.1:5678/api/flows")
        const headers = new Headers(init?.headers)
        expect(headers.get("x-forwarded-host")).toBe(publicOrigin.host)
        expect(headers.get("x-forwarded-proto")).toBe(publicOrigin.protocol.slice(0, -1))
        expect(headers.get("authorization")).toBe(`Bearer ${install.api!.token}`)
        expect(init?.redirect).toBe("manual")
        return Response.json({ ok: true })
      })
      expect(await Effect.runPromise(call("/api/flows"))).toEqual({ status: 200, body: { ok: true } })
    }
  )

  test("flow arguments reject malformed input and resolve named flows outside the list", async () => {
    const journal = producer(
      (path) => file(path, JOURNEY),
      routes({
        "/api/flows": [200, []],
        "/api/flows/custom": [200, { name: "custom", system: false, source: { builtin: true }, versions: [] }]
      })
    )
    const provider = model([execute("flow", "{broken"), execute("flow", "custom")])
    await run(install, provider, journal)
    expect(toolOutputs(provider)[0]).toBe("failed: Invalid arguments for flow; use its declared payload.")
    expect(toolOutputs(provider)[1]).toContain("\"name\":\"custom\"")
    expect(journal.frames.filter((frame) => frame.type === "card")).toMatchObject([{
      card: { kind: "flow", payload: { name: "custom" } }
    }])
  })

  test("empty flow commands refuse missing arguments before transport", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([execute("flow"), execute("flow.edit", "")])
    await run(install, provider, journal)
    expect(journal.calls).toEqual([])
    expect(journal.frames.filter((frame) => frame.type === "card")).toEqual([])
    expect(toolOutputs(provider)).toEqual(["failed: flow needs name", "failed: flow.edit needs name and request"])
  })

  test("named flow lookup refuses malformed and mismatched models", async () => {
    for (
      const body of [{ name: "custom" }, { name: "other", system: false, source: { builtin: true }, versions: [] }]
    ) {
      const journal = producer(
        (path) => file(path, JOURNEY),
        routes({
          "/api/flows": [200, []],
          "/api/flows/custom": [200, body]
        })
      )
      const provider = model([execute("flow", "custom")])
      await run(install, provider, journal)
      expect(toolOutputs(provider)).toEqual(["failed: No flow custom"])
      expect(journal.frames.filter((frame) => frame.type === "card")).toEqual([])
    }
  })

  test("named flow lookup refuses unavailable responses without rendering a card", async () => {
    for (const answer of [{ code: "call_refused" }, { status: 503, body: {} }] as const) {
      const provider = model([execute("flow", "custom")])
      const frames: NativeAgent.AgentTurnFrame[] = []
      await Effect.runPromise(runHostTurn(provider.model, install, { modelId: "m" }, (frame) =>
        Effect.sync(() => {
          frames.push(frame)
        }), {
        read: () => Effect.succeed({ code: "unused" }),
        list: () => Effect.succeed({ code: "unused" }),
        api: (path) => Effect.succeed(path === "/api/flows" ? { status: 200, body: [] } : answer)
      }))
      expect(toolOutputs(provider)).toEqual(["failed: No flow custom"])
      expect(frames.some((frame) => frame.type === "card")).toBe(false)
    }
  })

  test("API transport refusal stops flow and stack lookup without rendering partial cards", async () => {
    for (const command of ["flow", "stack", "todo.drop"]) {
      const provider = model([
        execute(command, command === "flow" ? "todo" : command === "todo.drop" ? "T12" : undefined)
      ])
      const frames: NativeAgent.AgentTurnFrame[] = []
      await Effect.runPromise(runHostTurn(provider.model, install, { modelId: "m" }, (frame) =>
        Effect.sync(() => {
          frames.push(frame)
        }), {
        read: () => Effect.succeed({ code: "unused" }),
        list: () => Effect.succeed({ code: "unused" }),
        api: (path) =>
          Effect.succeed(path === "/api/stack" ? { status: 200, body: stackHome } : { code: "call_refused" })
      }))
      expect(toolOutputs(provider)).toEqual(["failed: call_refused"])
      expect(frames.filter((frame) => frame.type === "card")).toEqual([])
    }
  })

  test("malformed TODO input refuses before a Draft", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([execute("todo.new", "{broken")])
    await run(install, provider, journal)
    expect(toolOutputs(provider)).toEqual(["failed: Invalid arguments for todo.new; use its declared payload."])
    expect(journal.calls).toEqual([])
    expect(journal.frames.filter((frame) => frame.type === "card")).toEqual([])
  })

  test("flow edit refuses missing and invalid catalogs before any Draft or write", async () => {
    for (
      const response of [
        () => Response.json({ class: "infra", code: "unavailable" }, { status: 503 }),
        () => Response.json([{ name: "todo" }])
      ]
    ) {
      const journal = producer((path) => file(path, JOURNEY), response)
      const provider = model([execute("flow.edit", "todo Run tests")])
      await run(install, provider, journal)
      expect(toolOutputs(provider)).toEqual(["failed: Flows unavailable"])
      expect(journal.frames.filter((frame) => frame.type === "card")).toEqual([])
      expect(journal.calls).toHaveLength(1)
      expect(journal.calls[0]!.body).toMatchObject({ method: "GET" })
    }
  })

  test("shared prompts retain the author's server Confirm instead of an invisible private Draft", async () => {
    const turn = { ...install, request: { ...install.request, sharedConversation: true } }
    const journal = producer(
      (path) => file(path, JOURNEY),
      () => Response.json({ confirmation: "confirm-1", state: "pending" }, { status: 202 })
    )
    const provider = model([execute("todo.new", "Add a greeting"), execute("merge", "T12")])
    await Effect.runPromise(runHostTurn(provider.model, turn, { modelId: "m" }, (frame) =>
      Effect.sync(() => {
        journal.frames.push(frame)
      }), {
      read: () => Effect.succeed({ code: "unused" }),
      list: () => Effect.succeed({ code: "unused" }),
      api: apiCaller("http://callback.test", turn, journal.fetchImpl)
    }))
    expect(journal.calls.map((call) => call.body)).toEqual([
      {
        method: "POST",
        path: "/api/todos",
        payload: { prompt: "Add a greeting", place: { mode: "append" } },
        key: `chat:${turn.turnId}:0`
      },
      { method: "POST", path: "/api/todos/12/merge", payload: {}, key: `chat:${turn.turnId}:1` }
    ])
    expect(journal.frames.some((frame) => frame.type === "card")).toBe(false)
    expect(toolOutputs(provider)).toEqual(Array(2).fill("{\"confirmation\":\"confirm-1\",\"state\":\"pending\"}"))
  })

  test("shared prompts file a flow edit as the author's TODO Confirm, never an invisible Draft or form", async () => {
    const turn = { ...install, request: { ...install.request, sharedConversation: true } }
    const catalog = [{
      name: "todo",
      system: false,
      source: { builtin: true },
      versions: [{ id: "d1", state: "active", steps: [] }]
    }, { name: "merge", system: true, source: { builtin: true }, versions: [] }]
    const journal = producer(
      (path) => file(path, JOURNEY),
      routes({
        "/api/flows": [200, catalog],
        "/api/todos": [202, { confirmation: "confirm-7", state: "pending" }]
      })
    )
    const provider = model([
      execute("flow.edit", "todo Run tests"),
      execute("flow.edit", "todo"),
      execute("flow.edit", "merge Add a step")
    ])
    await Effect.runPromise(runHostTurn(provider.model, turn, { modelId: "m" }, (frame) =>
      Effect.sync(() => {
        journal.frames.push(frame)
      }), {
      read: () => Effect.succeed({ code: "unused" }),
      list: () => Effect.succeed({ code: "unused" }),
      api: apiCaller("http://callback.test", turn, journal.fetchImpl)
    }))
    expect(journal.calls.map((call) => call.body)).toEqual([
      { method: "GET", path: "/api/flows" },
      {
        method: "POST",
        path: "/api/todos",
        payload: {
          prompt:
            "Change .smithers/flows/todo/flow.ts: Run tests; start from the built-in composition when no override exists",
          title: "Change the TODO flow: Run tests",
          place: { mode: "append" }
        },
        key: `chat:${turn.turnId}:0`
      },
      { method: "GET", path: "/api/flows" }
    ])
    expect(journal.frames.some((frame) => frame.type === "card")).toBe(false)
    expect(toolOutputs(provider)).toEqual([
      "{\"confirmation\":\"confirm-7\",\"state\":\"pending\"}",
      "failed: flow.edit needs request",
      "failed: Merge flow is built in"
    ])
  })

  test("confirmation failures return their HTTP refusal without a success frame", async () => {
    const journal = producer((path) => file(path, JOURNEY), () => Response.json({ code: "denied" }, { status: 403 }))
    const provider = model([execute("todo.drop", "T12")])
    await run(install, provider, journal)
    expect(toolOutputs(provider)).toEqual(["failed: {\"status\":403,\"body\":{\"code\":\"denied\"}}"])
    expect(journal.frames.some((frame) => frame.type === "call.settled")).toBe(false)
  })

  test("GET commands reject extra fields before HTTP dispatch", async () => {
    const journal = producer((path) => file(path, JOURNEY), stackRoutes)
    const provider = model([execute("search", "{\"query\":\"hello\",\"extra\":true}")])
    await run(install, provider, journal)
    expect(journal.calls).toEqual([])
    expect(toolOutputs(provider)).toEqual(["failed: Invalid arguments for search; use its declared payload."])
  })

  test("run inspection binds its run ID to the GET path", async () => {
    const journal = producer((path) => file(path, JOURNEY), () => Response.json({ id: "run-7" }))
    const provider = model([execute("run.inspect", "{\"id\":\"run-7\"}")])
    await run(install, provider, journal)
    expect(journal.calls.map((call) => call.body)).toEqual([{ method: "GET", path: "/api/runs/run-7" }])
    expect(toolOutputs(provider)).toEqual(["{\"status\":200,\"body\":{\"id\":\"run-7\"}}"])
  })

  test("GET catalog bindings have no nested body projections", () => {
    for (const row of catalogDescriptors) {
      if (row.http?.method === "GET") expect(row.http.objects).toBeUndefined()
    }
  })

  test("confirmation commands return pending status without copying the private Confirm into shared frames", async () => {
    const cases = [
      ["todo.drop", "T12", "/api/todos/12", { op: "drop" }],
      ["issue.comment", "{\"number\":5,\"body\":\"Please check\"}", "/api/issues/5/comments", { body: "Please check" }]
    ] as const
    for (const [name, args, path, payload] of cases) {
      const journal = producer((path) => file(path, JOURNEY), () =>
        Response.json({
          confirmation: "confirm-1",
          state: "pending",
          private: "AUTHOR ONLY"
        }, { status: 202 }))
      const provider = model([execute(name, args)])
      await run(install, provider, journal)
      expect(journal.calls, name).toEqual([{
        authorization: "Bearer smithers_" + "a".repeat(40),
        body: { method: "POST", path, payload, key: `chat:${install.turnId}:0` }
      }])
      expect(toolOutputs(provider)).toEqual(["{\"confirmation\":\"confirm-1\",\"state\":\"pending\"}"])
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "call.settled", "delta", "done"])
      expect(JSON.stringify(journal.frames)).not.toContain("AUTHOR ONLY")
      expect(JSON.stringify(provider.requests)).not.toContain("AUTHOR ONLY")
    }
  })

  test("success and unavailable repository dispatch return the API result without executing a local fallback", async () => {
    const journal = producer(
      (path) => file(path, JOURNEY),
      routes({
        "/api/search/code?q=hello+world": [200, { matches: [] }],
        "/api/flows/verify/run": [503, { code: "machine_unavailable", class: "infra" }]
      })
    )
    const provider = model([
      execute("search", "{\"query\":\"hello world\"}"),
      execute("flow.run", "{\"name\":\"verify\"}")
    ])
    await run(install, provider, journal)
    expect(journal.calls.map((call) => call.body)).toEqual([
      { method: "GET", path: "/api/search/code?q=hello+world" },
      { method: "POST", path: "/api/flows/verify/run", payload: {}, key: `chat:${install.turnId}:1` }
    ])
    expect(toolOutputs(provider)).toEqual([
      "{\"status\":200,\"body\":{\"matches\":[]}}",
      "failed: {\"status\":503,\"body\":{\"code\":\"machine_unavailable\",\"class\":\"infra\"}}"
    ])
    expect(journal.reads).toEqual([])
  })

  test("each refusal is stated to the model and the conversation, and the turn answers", async () => {
    const refusals: ReadonlyArray<[ReturnType<typeof execute>, (path: string) => Response, string]> = [
      [
        execute("stack"),
        routes({ "/api/stack": [403, { code: "permission", class: "permission" }] }),
        "{\"status\":403,\"body\":{\"code\":\"permission\",\"class\":\"permission\"}}"
      ],
      [
        execute("todo", "T99"),
        stackRoutes,
        "{\"status\":404,\"body\":{\"code\":\"todo_not_found\",\"class\":\"user\",\"message\":\"TODO not found\"}}"
      ],
      [
        execute("todo", "T12"),
        routes({ "/api/todos/12": [503, "upstream"] }),
        "{\"status\":503,\"body\":\"upstream\"}"
      ],
      [
        execute("stack"),
        () => Response.json({ code: "producer_fenced" }, { status: 401 }),
        "{\"status\":401,\"body\":{\"code\":\"producer_fenced\"}}"
      ],
      [execute("stack"), () => new Response("<html>bad gateway</html>", { status: 502 }), "invalid_answer"],
      [execute("stack"), () => {
        throw new TypeError("fetch failed")
      }, "unreachable"],
      [execute("stack"), () => Response.json({ rows: [] }), "Invalid stack response"],
      [execute("todo", "T12"), () => Response.json({ n: 12 }), "Invalid TODO response"]
    ]
    for (const [call, api, message] of refusals) {
      const journal = producer((path) => file(path, JOURNEY), api)
      await run(install, model([call]), journal)
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "gate.rejected", "delta", "done"])
      expect(journal.frames[1]).toEqual({ runId: "run", type: "gate.rejected", link: 0, kind: "call_failed", message })
      expect(answerText(journal.frames)).toBe(`From the source: failed: ${message}`)
    }
  })

  test("a named flow is selected from the served catalog without broadening the endpoint", async () => {
    const journal = producer(
      (path) => file(path, JOURNEY),
      () => Response.json([{ name: "check/types", system: false, source: { builtin: true }, versions: [] }])
    )
    const provider = model([execute("flow", "check/types")])
    await run(install, provider, journal)
    expect(journal.calls.map((call) => call.body)).toEqual([{ method: "GET", path: "/api/flows" }])
    expect(JSON.parse(toolOutputs(provider)[0]!)).toEqual({
      name: "check/types",
      system: false,
      source: { builtin: true },
      versions: []
    })
  })

  test("confirmation replay returns its current state without exposing private payload", async () => {
    for (const state of ["approved", "rejected", "expired"] as const) {
      const journal = producer((path) => file(path, JOURNEY), () =>
        Response.json({
          confirmation: "confirm-replay",
          state,
          payload: { secret: "PRIVATE" }
        }, { status: 202 }))
      const provider = model([execute("todo.drop", "T12")])
      await run(install, provider, journal)
      expect(toolOutputs(provider)).toEqual([JSON.stringify({ confirmation: "confirm-replay", state })])
      expect(JSON.stringify(journal.frames)).not.toContain("PRIVATE")
      expect(JSON.stringify(provider.requests)).not.toContain("PRIVATE")
    }
  })

  test("malformed confirmation acknowledgments expose no private payload or false success", async () => {
    for (
      const [status, body] of [
        [202, { confirmation: "", state: "pending", secret: "PRIVATE" }],
        [202, { confirmation: "confirm-1", state: "executed", secret: "PRIVATE" }],
        [200, { confirmation: "confirm-1", state: "pending", secret: "PRIVATE" }]
      ] as const
    ) {
      const journal = producer((path) => file(path, JOURNEY), () => Response.json(body, { status }))
      const provider = model([execute("todo.drop", "T12")])
      await run(install, provider, journal)
      expect(toolOutputs(provider)).toEqual(["failed: Invalid confirmation response"])
      expect(JSON.stringify(journal.frames)).not.toContain("PRIVATE")
      expect(journal.frames.some((frame) => frame.type === "call.settled")).toBe(false)
    }
  })

  test("each call has its own stable key across a producer-generation retry", async () => {
    const keys: unknown[][] = []
    for (const generation of [2, 3]) {
      const journal = producer(
        (path) => file(path, JOURNEY),
        () => Response.json({ state: "requested" }, { status: 202 })
      )
      const provider = model([execute("todo.stop", "T12"), execute("todo.stop", "T12")])
      await run({ ...install, generation }, provider, journal)
      keys.push(journal.calls.map((call) => (call.body as { key: string }).key))
      expect(toolOutputs(provider)).toEqual([
        "{\"status\":202,\"body\":{\"state\":\"requested\"}}",
        "{\"status\":202,\"body\":{\"state\":\"requested\"}}"
      ])
    }
    expect(keys).toEqual([
      [`chat:${install.turnId}:0`, `chat:${install.turnId}:1`],
      [`chat:${install.turnId}:0`, `chat:${install.turnId}:1`]
    ])
  })

  test("theme commits an explicit private instruction without an HTTP command or card", async () => {
    const journal = producer((path) => file(path, JOURNEY), stackRoutes)
    const provider = model([execute("theme", "dark")])
    await run(install, provider, journal)
    expect(journal.calls).toEqual([])
    expect(journal.frames.filter((frame) => frame.type === "call.settled")).toEqual([
      {
        runId: install.request.runId,
        type: "call.settled",
        link: 0,
        ordinal: 0,
        name: "theme",
        verdict: "run",
        ui: { command: "theme", mode: "dark" }
      }
    ])
    expect(toolOutputs(provider)).toEqual([screenRequest("theme dark")])
  })

  test("theme refuses toggles, unknown modes and extra authority fields", async () => {
    for (
      const args of [undefined, "pink", "{broken", "{\"mode\":null}", "{\"mode\":\"dark\",\"command\":\"todo.drop\"}"]
    ) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([execute("theme", args)])
      await run(install, provider, journal)
      expect(journal.calls).toEqual([])
      expect(journal.frames.filter((frame) => frame.type === "call.settled")).toEqual([])
      expect(toolOutputs(provider)).toEqual(["failed: Invalid arguments for theme; use light or dark."])
    }
  })

  test("UI-only flows commit their declared fields for the author's screen and run nothing here", async () => {
    const cases: ReadonlyArray<readonly [string, string | undefined, Record<string, unknown>]> = [
      ["card.dismiss", "card-7", { command: "card.dismiss", cardId: "card-7" }],
      ["search.files", "retry.ts", { command: "search.files", query: "retry.ts" }],
      [
        "runs.trace.select",
        "{\"sourceCard\":null,\"runId\":\"run-1\",\"nodeId\":\"build\",\"seq\":4}",
        { command: "runs.trace.select", runId: "run-1", nodeId: "build", seq: 4 }
      ],
      [
        "runs.trace.view",
        JSON.stringify({ runId: "run-1", view: "turns", state: { selected: "cell-1", at: 3, tab: "journal" } }),
        {
          command: "runs.trace.view",
          runId: "run-1",
          view: "turns",
          state: { selected: "cell-1", at: 3, tab: "journal" }
        }
      ],
      ["help", undefined, { command: "help" }]
    ]
    for (const [name, args, ui] of cases) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([execute(name, args)])
      await run(install, provider, journal)
      expect(journal.calls).toEqual([])
      expect(journal.frames.some((frame) => frame.type === "card")).toBe(false)
      expect(journal.frames.filter((frame) => frame.type === "call.settled")).toEqual([
        { runId: install.request.runId, type: "call.settled", link: 0, ordinal: 0, name, verdict: "run", ui }
      ])
      expect(toolOutputs(provider)).toEqual([screenRequest(name)])
    }
  })

  test("UI-only flows refuse undeclared, missing and nested fields; shared writes are not UI-only", async () => {
    for (
      const [name, args] of [
        ["card.dismiss", undefined],
        ["card.dismiss", "{\"cardId\":\"card-7\",\"runId\":\"run-1\"}"],
        ["form.set", "{\"cardId\":\"card-7\",\"field\":\"title\",\"value\":{\"x\":1}}"],
        ["wiki.view", "{\"view\":\"raw\"}"]
      ] as const
    ) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([execute(name, args)])
      await run(install, provider, journal)
      expect(journal.frames.filter((frame) => frame.type === "call.settled")).toEqual([])
      expect(toolOutputs(provider)).toEqual([`failed: Invalid arguments for ${name}; use its declared payload.`])
    }
    for (const name of ["form.submit", "wiki.new-note", "palette.recent", "chat.retry", "palette.open"]) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([execute(name, "{}")])
      await run(install, provider, journal)
      expect(journal.frames.filter((frame) => frame.type === "call.settled")).toEqual([])
      expect(toolOutputs(provider)).toEqual([AgentCommands.unknownCommandResult(name)])
    }
  })

  test("each UI-only flow is a screen-only catalog row whose declared fields the instruction carries", () => {
    for (const [name, fields] of Object.entries(UiInstruction.UI_INSTRUCTION_FIELDS)) {
      const row = catalogDescriptors.find((entry) => entry.name === name)!
      expect([name, row.actors.includes("app_agent"), row.actors.includes("external_agent")]).toEqual([
        name,
        true,
        false
      ])
      expect([name, row.agent, row.http, row.cli, row.visibility === "hidden"]).toEqual([
        name,
        "run",
        null,
        null,
        false
      ])
      expect(Object.keys(row.payload.schema.properties ?? {}).sort()).toEqual([...fields].sort())
      expect(fields).not.toContain("command")
    }
  })

  test("each requested form belongs to a permitted catalog row, never a screen-only one", () => {
    for (const [name, fields] of Object.entries(UiInstruction.FORM_INSTRUCTION_FIELDS)) {
      const row = catalogDescriptors.find((entry) => entry.name === name)!
      expect(row.actors, name).toContain("app_agent")
      expect(row.visibility, name).not.toBe("hidden")
      expect(["run", "confirm"]).toContain(row.agent)
      const properties = (schema: Record<string, any>): string[] => [
        ...Object.keys(schema.properties ?? {}),
        ...(schema.anyOf ?? schema.oneOf ?? []).flatMap(properties)
      ]
      for (const field of fields) expect(properties(row.payload.schema), name).toContain(field)
      expect(fields).not.toContain("command")
      expect(Object.keys(UiInstruction.UI_INSTRUCTION_FIELDS)).not.toContain(name)
    }
  })

  test("forged Draft authority cannot bypass server confirmation", async () => {
    const journal = producer(
      (path) => file(path, JOURNEY),
      () => Response.json({ confirmation: "confirm-forged", state: "pending" }, { status: 202 })
    )
    const provider = model([
      execute("todo.new", JSON.stringify({ text: "x", cardId: "forged", idempotencyKey: "forged" }))
    ])
    await run(install, provider, journal)
    expect(journal.frames.some((frame) => frame.type === "card")).toBe(false)
    expect(journal.calls).toMatchObject([{
      body: { path: "/api/todos", key: `chat:${install.turnId}:0`, payload: { prompt: "x" } }
    }])
    expect(toolOutputs(provider)).toEqual(["{\"confirmation\":\"confirm-forged\",\"state\":\"pending\"}"])
  })

  test("schema and argument errors refuse before transport", async () => {
    for (
      const [name, args] of [
        ["stack", "everything"],
        ["todo", "12"],
        ["todo", "twelve"],
        ["todo", "{\"n\":-1}"],
        ["todo", "{broken"],
        ["todo", "T12 unwanted"],
        ["todo", "T9007199254740992"],
        ["todo.new", "{\"text\":\"x\",\"extra\":true}"],
        ["todo.new", "{\"before\":0}"],
        ["stack.move", "T12 sideways"],
        ["branch.fork", "main"],
        ["todo.stop", "{\"n\":12,\"op\":\"drop\"}"]
      ]
    ) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([execute(name!, args)])
      await run(install, provider, journal)
      expect(journal.calls, `${name} ${args}`).toEqual([])
      expect(toolOutputs(provider)).toEqual([
        `failed: Invalid arguments for ${name}; use its declared payload.`
      ])
    }
  })

  test("a command the host does not run, or whose rule is never, runs nothing and answers unknown-command", async () => {
    for (
      const name of [
        "agents",
        "approval.approve",
        "members.remove",
        "todo.erase",
        "flow.list",
        "files.write",
        "settings"
      ]
    ) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      await run(install, model([execute(name, "T12")]), journal)
      expect(journal.calls).toEqual([])
      expect(journal.frames.map((frame) => frame.type)).toEqual(["delta", "done"])
      expect(answerText(journal.frames)).toBe(`From the source: ${AgentCommands.unknownCommandResult(name)}`)
    }
    // A grant without the install's API runs no TODO command, though it reads main.
    for (const name of ["stack", "todo", "todo.new"]) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      await run(grant, model([execute(name, "T12")]), journal)
      expect(journal.calls).toEqual([])
      expect(answerText(journal.frames)).toBe(`From the source: ${AgentCommands.unknownCommandResult(name)}`)
    }
  })
})

describe("delegated public API transport", () => {
  test("writes require the host key, send JSON once, and accept empty 204 only for writes", async () => {
    const requests: Array<RequestInit | undefined> = []
    const call = apiCaller("http://callback.test", install, async (_url, init) => {
      requests.push(init)
      return new Response(null, { status: 204 })
    })
    expect(await Effect.runPromise(call("/api/todos/12", { method: "POST", body: { op: "stop" } }))).toEqual({
      code: "call_refused"
    })
    expect(requests).toEqual([])
    expect(
      await Effect.runPromise(call("/api/todos/12", { method: "POST", body: { op: "stop" }, idempotencyKey: "host-1" }))
    )
      .toEqual({ status: 204, body: null })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toBe("{\"op\":\"stop\"}")
    expect(new Headers(requests[0]?.headers).get("Idempotency-Key")).toBe("host-1")
    expect(new Headers(requests[0]?.headers).get("Content-Type")).toBe("application/json")
    expect(await Effect.runPromise(call("/api/github/sync", { method: "POST", idempotencyKey: "host-2" })))
      .toEqual({ status: 204, body: null })
    expect(requests[1]?.body).toBe("{}")
    expect(await Effect.runPromise(call("/api/todos/12"))).toEqual({ code: "invalid_answer" })
  })

  test("interrupting an API read aborts its outstanding request", async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let observed: AbortSignal | undefined
    let calls = 0
    const read = apiCaller("http://callback.test", install, (_input, init) => {
      calls++
      return new Promise((_resolve, reject) => {
        observed = init?.signal as AbortSignal
        observed.addEventListener("abort", () => reject(new Error("interrupted")))
        entered()
      })
    })
    const abort = new AbortController()
    const pending = Effect.runPromiseExit(read("/api/todos"), { signal: abort.signal })
    await started
    abort.abort()
    expect((await pending)._tag).toBe("Failure")
    expect(observed?.aborted).toBe(true)
    expect(calls).toBe(1)
  })
  test("decodes multibyte characters across stream boundaries", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ title: "café 日本 🐈" }))
    const read = apiCaller("http://callback.test", install, async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
            controller.close()
          }
        })
      ))
    expect(await Effect.runPromise(read("/api/todos"))).toEqual({ status: 200, body: { title: "café 日本 🐈" } })
  })
  test("refuses absent authority and non-API destinations before transport", async () => {
    let fetched = false
    const fetchImpl: NativeAgent.FetchLike = async () => {
      fetched = true
      return Response.json({})
    }
    expect(await Effect.runPromise(apiCaller("http://callback.test", grant, fetchImpl)("/api/todos")))
      .toEqual({ code: "forbidden" })
    for (
      const path of [
        "/private",
        "https://other.test/api/todos",
        "//other.test/api/todos",
        "/api/../private",
        "/api/x#fragment",
        "/api/\\private"
      ]
    ) {
      expect(await Effect.runPromise(apiCaller("http://callback.test", install, fetchImpl)(path)))
        .toEqual({ code: "call_refused" })
    }
    expect(fetched).toBe(false)
  })
  test("uses the pinned origin and redacts literal and escaped bearer reflections", async () => {
    const token = install.api!.token
    const read = apiCaller("http://callback.test", install, async (input, init) => {
      expect(String(input)).toBe("http://callback.test/api/todos?q=one")
      expect(init?.method).toBe("GET")
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`)
      expect(new Headers(init?.headers).get("smithers-via")).toBe("smithers")
      expect(init?.redirect).toBe("manual")
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(`{"plain":"${token}","escaped":"\\u0073${token.slice(1)}"}`)
    })
    expect(await Effect.runPromise(read("/api/todos?q=one")))
      .toEqual({ status: 200, body: { plain: "[redacted]", escaped: "[redacted]" } })
  })
  test("refuses redirects, empty responses and invalid UTF-8", async () => {
    const redirected = Response.json({})
    Object.defineProperty(redirected, "redirected", { value: true })
    for (
      const [response, code] of [
        [Response.redirect("https://other.test", 302), "call_refused"],
        [redirected, "call_refused"],
        [new Response(null, { status: 204 }), "invalid_answer"],
        [new Response(new Uint8Array([255])), "invalid_answer"]
      ] as const
    ) {
      expect(await Effect.runPromise(apiCaller("http://callback.test", install, async () => response)("/api/todos")))
        .toEqual({ code })
    }
  })
  test("bounds decoded API bodies at four MiB and cancels an oversized stream", async () => {
    const boundary = JSON.stringify("x".repeat(4 * 1024 * 1024 - 2))
    const valid = await Effect.runPromise(
      apiCaller("http://callback.test", install, async () => new Response(boundary))("/api/todos")
    )
    expect("status" in valid && valid.status).toBe(200)
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(boundary + " "))
        },
        cancel() {
          cancelled = true
          throw new Error("upstream cancellation failed")
        }
      })
    )
    expect(await Effect.runPromise(apiCaller("http://callback.test", install, async () => response)("/api/todos")))
      .toEqual({ code: "invalid_answer" })
    expect(cancelled).toBe(true)
  })
})

// Literal pages, in table-of-contents order: the host is handed what its build bundles.
const HTTPS = "## Put HTTPS in front\n\n```sh\ntailscale serve --bg --https=443 http://127.0.0.1:4000\n```\n"
const PAGES: ReadonlyArray<DocsPages.DocsPage> = [
  { slug: "quickstart", title: "Quickstart", summary: "Install and run.", markdown: `# Quickstart\n\n${HTTPS}` },
  { slug: "flows", title: "Flows reference", summary: "Every flow.", markdown: "# Flows reference\n" }
]
const DOCS_LINE =
  "Asked how something in Smithers works, or to be shown its documentation, run docs with {\"mode\":\"read\",\"page\":\"<page>\"} for the page that covers it (pages: quickstart, flows), answer from what it returns, and name the page you read. docs never answers a request a command above carries out: run that command instead of relaying a page's steps."
const https: DurableChatGrant = {
  ...sourceless,
  request: { ...question, messages: [{ role: "user", content: "How do I put HTTPS in front?" }] }
}
const runWithDocs = (
  turn: DurableChatGrant,
  provider: ReturnType<typeof model>,
  journal: ReturnType<typeof producer>,
  docs: ReadonlyArray<DocsPages.DocsPage> | undefined
) =>
  Effect.runPromise(
    runDurableChatTurn(
      provider.model,
      turn,
      { modelId: "m" },
      "http://callback.test",
      journal.fetchImpl,
      undefined,
      docs
    )
  )

describe("the host-owned app agent answers \"how do I\" from the bundled docs (C-UI-09)", () => {
  test("a read hands the model the page's title, summary and Markdown, embeds nothing and touches no repository", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([execute("docs", JSON.stringify({ mode: "read", page: "quickstart" }))])
    await runWithDocs(https, provider, journal, PAGES)

    const read = JSON.stringify({
      title: "Quickstart",
      summary: "Install and run.",
      markdown: `# Quickstart\n\n${HTTPS}`
    })
    expect(commandLines(systemText(provider.requests[0]))).toEqual(["- /docs — Read the docs in the app"])
    expect(systemText(provider.requests[0])).toContain(DOCS_LINE)
    expect(toolOutputs(provider)).toEqual([read])
    expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "call.settled", "delta", "done"])
    for (const frame of journal.frames) expect(NativeAgent.AgentTurnFrameSchema.safeParse(frame).success).toBe(true)
    expect(journal.frames[0]).toEqual({
      runId: "run",
      type: "call.started",
      link: 0,
      ordinal: 0,
      name: "docs",
      description: "Read the docs in the app",
      arguments: JSON.stringify({ mode: "read", page: "quickstart" })
    })
    expect(journal.frames[1]).toEqual({
      runId: "run",
      type: "call.settled",
      link: 0,
      ordinal: 0,
      name: "docs",
      verdict: "run"
    })
    expect(answerText(journal.frames)).toBe(`From the source: ${read}`)
    expect(answerText(journal.frames)).toContain("tailscale serve --bg --https=443 http://127.0.0.1:4000")
    expect(journal.reads).toEqual([])
    expect(journal.lists).toEqual([])
    expect(journal.calls).toEqual([])
  })

  test("an install turn lists docs beside the commands its grant runs, and nothing else changes", async () => {
    const listed = async (docs: ReadonlyArray<DocsPages.DocsPage> | undefined) => {
      const provider = model([])
      await runWithDocs(install, provider, producer((path) => file(path, JOURNEY), stackRoutes), docs)
      return systemText(provider.requests[0])
    }
    const without = await listed(undefined)
    const withDocs = await listed(PAGES)
    expect(commandLines(withDocs).filter((line) => !commandLines(without).includes(line))).toEqual([
      "- /docs — Read the docs in the app"
    ])
    expect(commandLines(without).filter((line) => !commandLines(withDocs).includes(line))).toEqual([])
    expect(withDocs).toContain(DOCS_LINE)
    expect(without).not.toContain(DOCS_LINE)
  })

  test("a read of a page no one wrote, or of no page, is refused with every page named, and the turn answers", async () => {
    const refusals: ReadonlyArray<readonly [string, string]> = [
      [
        JSON.stringify({ mode: "read", page: "nowhere" }),
        "There is no docs page named nowhere. Pages: quickstart, flows."
      ],
      [JSON.stringify({ mode: "read" }), "Name a docs page to read. Pages: quickstart, flows."],
      [JSON.stringify({ mode: "read", page: "  " }), "Name a docs page to read. Pages: quickstart, flows."],
      [
        JSON.stringify({ mode: "write", page: "quickstart" }),
        "docs takes a page, or {\"mode\":\"read\",\"page\":\"<page>\"} to read one."
      ],
      [
        JSON.stringify({ page: "quickstart", path: "/etc/passwd" }),
        "docs takes a page, or {\"mode\":\"read\",\"page\":\"<page>\"} to read one."
      ],
      ["{\"mode\":", "docs takes a page, or {\"mode\":\"read\",\"page\":\"<page>\"} to read one."]
    ]
    for (const [args, message] of refusals) {
      const journal = producer((path) => file(path, JOURNEY))
      await runWithDocs(https, model([execute("docs", args)]), journal, PAGES)
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "gate.rejected", "delta", "done"])
      expect(journal.frames[1]).toEqual({ runId: "run", type: "gate.rejected", link: 0, kind: "call_failed", message })
      expect(answerText(journal.frames)).toBe(`From the source: failed: ${message}`)
      expect(journal.frames.at(-1)).toMatchObject({ type: "done", reason: "stop" })
    }
  })

  test("without read, docs embeds the Docs card the app renders: the page, its anchor and the table of contents", async () => {
    const toc = [{ slug: "quickstart", title: "Quickstart" }, { slug: "flows", title: "Flows reference" }]
    const cases: ReadonlyArray<readonly [string | undefined, string, Record<string, unknown>]> = [
      [undefined, "Quickstart", { page: "quickstart" }],
      ["quickstart#put-https-in-front", "Quickstart", { page: "quickstart", anchor: "put-https-in-front" }],
      [JSON.stringify({ page: "flows" }), "Flows reference", { page: "flows" }],
      ["#put-https-in-front", "Quickstart", { page: "quickstart", anchor: "put-https-in-front" }],
      ["nowhere#heading", "Quickstart", { page: "quickstart", not_found: "nowhere" }]
    ]
    for (const [args, title, payload] of cases) {
      const journal = producer((path) => file(path, JOURNEY))
      const provider = model([execute("docs", args)])
      await runWithDocs(https, provider, journal, PAGES)
      expect(journal.frames.map((frame) => frame.type)).toEqual([
        "call.started",
        "card",
        "call.settled",
        "delta",
        "done"
      ])
      const page = PAGES.find((candidate) => candidate.slug === payload.page)!
      const card = journal.frames[1]?.type === "card" ? journal.frames[1].card : undefined
      expect(card).toEqual({
        id: `docs-${page.slug}`,
        kind: "docs",
        title,
        status: "active",
        createdAt: expect.any(Number),
        ordinal: 0,
        payload: { markdown: page.markdown, summary: page.summary, toc, ...payload }
      })
      expect(toolOutputs(provider)).toEqual([`Embedded the ${title} docs page.`])
    }
  })

  test("a host its build gave no pages offers no docs, and a docs call runs nothing", async () => {
    for (const docs of [undefined, []]) {
      const journal = producer((path) => file(path, JOURNEY))
      const provider = model([execute("docs", JSON.stringify({ mode: "read", page: "quickstart" }))])
      await runWithDocs(https, provider, journal, docs)
      expect(toolNames(provider.requests[0])).toEqual([])
      expect(systemText(provider.requests[0])).not.toContain("/docs")
      expect(journal.frames.map((frame) => frame.type)).toEqual(["delta", "done"])
      expect(answerText(journal.frames)).toBe("From the source: unknown-tool: commands")
    }
  })
})

/**
 * A Smithers Cloud account conversation as host prompt admission grants it
 * (backend chat/prompt.go): no repository, no source, no install API, and the
 * private marker on its request.
 */
const account: DurableChatGrant = {
  ...sourceless,
  request: { ...question, privateConversation: true, messages: [{ role: "user", content: "can we create a workflow" }] }
}
const FLOW_NEW_LINE =
  "Asked to create, make, build or automate a flow or workflow (\"can we …\" included), run flow.new in that turn: pass what the flow should do as description when the person said it, and nothing when they did not. Then tell them in one sentence that the form is on their screen. Never explain how to write a flow by hand unless they ask for exactly that."
const FLOW_NEW_COMMAND_LINE =
  "- /flow.new — Create a new flow (asks the person: it only shows them what to confirm, and their press acts)"
/**
 * The whole result a screen-only request has: the author's browser runs it
 * afterwards and carries nothing back, so the tool result says so. Told only
 * that its request was "Requested … on the author's screen", the deployed
 * model answered root with an invented issue and its invented labels
 * (account 8 on smithers.sh, 2026-10-14 10:09Z).
 */
const screenRequest = (command: string): string =>
  `Requested /${command} on the author's screen. Their browser runs it; this host cannot see their screen, so never state what it shows or found.`

const formRequest = (): string =>
  `Requested the "Create a new flow" form on the author's screen with the supplied draft. ` +
  "Their browser runs it; this host cannot see their screen or confirm it opened or populated the form. " +
  "Nothing is created until they press Submit; never ask them to type arguments."

/**
 * The screen-only flows (mvp.md Appendix B.1) a Cloud account conversation
 * runs for its author, in catalog order, beside the pages and the form it is
 * offered. Each request is the whole act: it calls no route and spends no
 * credential, so an account turn without an install API still runs them.
 */
const ORIGINAL_CLOUD_ACCOUNT_COMMANDS = [
  "card.dismiss",
  "card.history.back",
  "card.history.forward",
  "change.facet",
  "chat.reload",
  "docs",
  "flow.new",
  "flow.plan.select",
  "flow.plan.tab",
  "form.set",
  "help",
  "history",
  "prs.tab",
  "runs.coding.select",
  "runs.graph.execution",
  "runs.graph.follow",
  "runs.graph.select",
  "runs.graph.tab",
  "runs.steps",
  "runs.trace.filter",
  "runs.trace.live",
  "runs.trace.select",
  "runs.trace.view",
  "search.changes",
  "search.files",
  "search.flows",
  "search.history",
  "search.issues",
  "search.runs",
  "search.wiki",
  "storage.recovery",
  "theme",
  "wiki.backlinks",
  "wiki.graph",
  "wiki.open",
  "wiki.space",
  "wiki.view"
]

const CLOUD_ACCOUNT_COMMANDS = [
  ...new Set([...ORIGINAL_CLOUD_ACCOUNT_COMMANDS, ...Object.keys(UiInstruction.FORM_INSTRUCTION_FIELDS)])
].sort()

// #3823: asked "can we create a workflow" on smithers.sh, the agent had one command, docs, and recited the Flows page.
describe("a Cloud account conversation asks for a new flow with its form", () => {
  test("the turn is offered the author's own screen, docs and flow.new, every form field optional, and nothing else", async () => {
    for (
      const [docs, names] of [
        [PAGES, CLOUD_ACCOUNT_COMMANDS],
        [undefined, CLOUD_ACCOUNT_COMMANDS.filter((name) => name !== "docs")]
      ] as const
    ) {
      const journal = producer((path) => file(path, JOURNEY))
      const provider = model([{ name: "commands", arguments: JSON.stringify({ action: "list" }) }])
      await runWithDocs(account, provider, journal, docs)
      const system = systemText(provider.requests[0])
      expect(commandLines(system).map((line) => line.slice(3).split(" ")[0])).toEqual(names)
      expect(commandLines(system)).toContain(FLOW_NEW_COMMAND_LINE)
      expect(system).not.toContain(question.instructions)
      expect(toolNames(provider.requests[0])).toEqual(["commands"])
      const listed = JSON.parse(toolOutputs(provider)[0]!) as {
        commands: ReadonlyArray<{ name: string; args: string }>
      }
      expect(listed.commands.map((command) => command.name)).toEqual(names)
      expect(JSON.parse(listed.commands.find((command) => command.name === "flow.new")!.args)).toEqual({
        type: "object",
        properties: { description: { type: "string" }, repo: { type: "string" } },
        additionalProperties: false
      })
      expect(journal.calls).toEqual([])
    }
  })

  test("the instructions tell it to act: run flow.new for the form, keep docs for how something works", async () => {
    const told = async (turn: DurableChatGrant) => {
      const provider = model([])
      await runWithDocs(turn, provider, producer((path) => file(path, JOURNEY), stackRoutes), PAGES)
      return systemText(provider.requests[0])
    }
    const cloud = await told(account)
    expect(cloud).toContain("run change.ask with the person’s request in that turn")
    expect(cloud).toContain("the person presses Start agent before any coding run starts")
    for (const line of [AgentInstructions.ASSISTANT_ACTS_LINE, FLOW_NEW_LINE, DOCS_LINE]) expect(cloud).toContain(line)
    // The rule sits after the commands it names and before the can't-yets.
    expect(cloud.indexOf(FLOW_NEW_COMMAND_LINE)).toBeLessThan(cloud.indexOf(FLOW_NEW_LINE))
    expect(cloud.indexOf(FLOW_NEW_LINE)).toBeLessThan(cloud.indexOf("Everything this list lacks is an ACT"))
    // A turn that cannot ask for the form is never told it is on the person's screen.
    for (const turn of [install, grant, https]) {
      const system = await told(turn)
      expect(system).toContain(AgentInstructions.ASSISTANT_ACTS_LINE)
      expect(system).not.toContain("run change.ask with the person’s request")
      expect(system).not.toContain(FLOW_NEW_LINE)
      expect(system).not.toContain("form is on their screen")
    }
  })

  /*
   * THE OTHER HALF of the act rule: what the turn may SAY.
   *
   * Root sent two fresh Cloud prompts on 2026-10-14 after API 464674fb/d85fef7b
   * was serving. A ten-section, ~1500-word guide to debugging distributed
   * message queues came back "I'm sorry, but I can't create that guide for
   * you." in 5 seconds (10:36Z, turn cd45c4a4-3ded-4114-82d8-12d32cda7f7b);
   * "explain what a message queue is, in ten numbered sections" came back "I
   * can't do that yet; you could try /docs." in 4 seconds (10:37Z). No
   * transport stall: an isolated long-reply probe had just passed.
   *
   * A controlled probe over this exact path reproduced both sentences against
   * the real provider, and the same provider answered 10,830 bytes in 23
   * sections once the host prompt was removed — naming the reason itself:
   * "I'm unable to provide that explanation because it isn't a supported
   * command." The prompt's act rules were being read as a whitelist of
   * SUBJECTS. This pins the boundary in the prompt the host actually sends.
   * It proves what the turn is TOLD, not what a model does with it: the
   * provider evidence is the probe's, and it lives beside this change.
   */
  test("the instructions bound the can't-yets to acts: writing in this chat needs no command", async () => {
    const told = async (turn: DurableChatGrant) => {
      const provider = model([])
      await runWithDocs(turn, provider, producer((path) => file(path, JOURNEY), stackRoutes), PAGES)
      return systemText(provider.requests[0])
    }
    const cloud = await told(account)
    expect(cloud).toContain(AgentInstructions.CONVERSATION_IS_NOT_A_COMMAND_LINE)
    // It bounds the two lines the refusals read as a subject whitelist, so it sits between them.
    expect(cloud.indexOf(AgentInstructions.ASSISTANT_ACTS_LINE)).toBeLessThan(
      cloud.indexOf(AgentInstructions.CONVERSATION_IS_NOT_A_COMMAND_LINE)
    )
    expect(cloud.indexOf(AgentInstructions.CONVERSATION_IS_NOT_A_COMMAND_LINE)).toBeLessThan(
      cloud.indexOf("Everything this list lacks")
    )
    // The unscoped sentence that licensed "it isn't a supported command" is gone from every grant.
    for (const turn of [account, install, grant, https]) {
      const system = await told(turn)
      expect(system).not.toContain("Everything this list lacks is a can't-yet.")
      expect(system).toContain(
        "Everything this list lacks is an ACT you cannot take yet; it is never a subject you cannot discuss."
      )
      expect(system).toContain(AgentInstructions.CONVERSATION_IS_NOT_A_COMMAND_LINE)
      // The act rule's own refusal clause names an act, not a request it could simply answer.
      expect(system).toContain(
        "When they ask you to ACT — to change something, or to reach something outside this conversation — and no command does it, say so in one sentence."
      )
      /*
       * The line licenses subjects in the WORLD and nothing about this app. A
       * first draft ended "never hand it off to docs"; probed against the real
       * provider with the pages offered, the same turn then answered "how do I
       * put HTTPS in front of Smithers" from memory in 6.5 kB instead of
       * reading the page. The clause defers to the docs rule, and this pins
       * that it still does — in the form this grant's catalog earns, since a
       * turn offered no documentation command cannot be sent to read a page.
       */
      expect(system).toContain(
        AgentInstructions.smithersSubjectLine(commandLines(system).some((line) => line.startsWith("- /docs")))
      )
      expect(system).not.toContain("never hand it off to docs")
      // Every external fence stands, unchanged.
      expect(system).toContain("You cannot send or draft email")
      expect(system).toContain("push to a branch or open a pull request — not directly, and not through a run")
      for (const line of AgentInstructions.WORKFLOW_LAUNDERING_RULE) expect(system).toContain(line)
    }
  })

  /*
   * THE CLAUSE FOLLOWS THE COMMAND.
   *
   * `docsReadLine` is stated only when `docs` is offered — and a turn run with
   * no pages is offered no `docs` (the row above pins that catalog). The
   * conversation rule's Smithers-subject clause was stated unconditionally, so
   * such a turn was told to answer a question about Smithers by running a
   * command it does not have and "never from memory": no source, and nothing
   * left but the refusal #3881 removed. The clause now follows the door, as
   * CODE_INTEL_LINE follows `code.hover` in the browser's prompt.
   */
  test("the Smithers-subject clause is stated only when the turn is offered the documentation command", async () => {
    const told = async (turn: DurableChatGrant, docs: ReadonlyArray<DocsPages.DocsPage> | undefined) => {
      const provider = model([])
      await runWithDocs(turn, provider, producer((path) => file(path, JOURNEY), stackRoutes), docs)
      return systemText(provider.requests[0])
    }
    const pages = await told(account, PAGES)
    expect(commandLines(pages).map((line) => line.slice(3).split(" ")[0])).toContain("docs")
    expect(pages).toContain(DOCS_LINE)
    expect(pages).toContain(AgentInstructions.SMITHERS_SUBJECT_READS_DOCS_LINE)
    expect(pages).not.toContain(AgentInstructions.SMITHERS_SUBJECT_WITHOUT_DOCS_LINE)
    const none = await told(account, undefined)
    expect(commandLines(none).map((line) => line.slice(3).split(" ")[0])).not.toContain("docs")
    expect(none).not.toContain(DOCS_LINE)
    expect(none).not.toContain(AgentInstructions.SMITHERS_SUBJECT_READS_DOCS_LINE)
    expect(none).toContain(AgentInstructions.SMITHERS_SUBJECT_WITHOUT_DOCS_LINE)
    // No page to read is still not a refusal, and still not an invention.
    expect(none).toContain("never invent a command, a flag, a page or a step")
    // Either way the rule is stated once, and it licenses the world.
    for (const system of [pages, none]) {
      expect(system.split(AgentInstructions.CONVERSATION_IS_NOT_A_COMMAND_LINE)).toHaveLength(2)
      expect(system).toContain("This licenses subjects in the WORLD, nothing about this app")
      expect(system).toContain("You cannot send or draft email")
    }
  })

  test("flow.new asks the author's screen for the form with what the person said, and creates nothing", async () => {
    const said = "label new issues by area"
    const cases: ReadonlyArray<readonly [string | undefined, Record<string, string>]> = [
      [JSON.stringify({ description: said }), { description: said }],
      [said, { description: said }],
      [JSON.stringify({ description: `  ${said} `, repo: null }), { description: said }],
      [JSON.stringify({ description: said, repo: "acme/app" }), { description: said, repo: "acme/app" }],
      [JSON.stringify({ repo: "acme/app" }), { repo: "acme/app" }],
      [undefined, {}],
      ["  ", {}],
      ["{}", {}],
      [JSON.stringify({ description: "  " }), {}]
    ]
    for (const [args, draft] of cases) {
      const journal = producer((path) => file(path, JOURNEY))
      const provider = model([execute("flow.new", args)])
      await runWithDocs(account, provider, journal, PAGES)
      expect(journal.frames.map((frame) => frame.type), String(args)).toEqual([
        "call.started",
        "call.settled",
        "delta",
        "done"
      ])
      for (const frame of journal.frames) expect(NativeAgent.AgentTurnFrameSchema.safeParse(frame).success).toBe(true)
      expect(journal.frames[1]).toEqual({
        runId: "run",
        type: "call.settled",
        link: 0,
        ordinal: 0,
        name: "flow.new",
        verdict: "run",
        ui: { command: "flow.new", ...draft }
      })
      expect(toolOutputs(provider)).toEqual([formRequest()])
      // No API, no source: the request is the whole act.
      expect([journal.calls, journal.reads, journal.lists]).toEqual([[], [], []])
    }
  })

  test("flow.new refuses arguments the form does not declare, and nothing reaches the author's screen", async () => {
    for (
      const args of [
        "{broken",
        JSON.stringify({ description: 7 }),
        JSON.stringify({ description: true }),
        JSON.stringify({ description: { text: "label new issues" } }),
        JSON.stringify({ description: ["label new issues"] }),
        JSON.stringify({ name: "label-issues" }),
        JSON.stringify({ description: "label new issues", confirmed: true }),
        JSON.stringify({ description: "label new issues", repo: 3 })
      ]
    ) {
      const journal = producer((path) => file(path, JOURNEY))
      const provider = model([execute("flow.new", args)])
      await runWithDocs(account, provider, journal, PAGES)
      expect(journal.frames.map((frame) => frame.type), args).toEqual([
        "call.started",
        "gate.rejected",
        "delta",
        "done"
      ])
      expect(journal.frames[1]).toMatchObject({
        type: "gate.rejected",
        kind: "call_failed",
        message: "Invalid arguments for flow.new; use its declared payload."
      })
      expect(toolOutputs(provider)).toEqual(["failed: Invalid arguments for flow.new; use its declared payload."])
      expect(journal.calls).toEqual([])
    }
  })

  test("only the private account conversation asks with the form: a repository's turn is offered what it was", async () => {
    // The marker without the account: a turn that belongs to a repository is never the account conversation.
    const provider = model([execute("flow.new", JSON.stringify({ description: "label new issues" }))])
    const journal = producer((path) => file(path, JOURNEY))
    await runWithDocs({ ...account, repositoryId: 3 }, provider, journal, PAGES)
    expect(commandLines(systemText(provider.requests[0]))).toEqual(["- /docs — Read the docs in the app"])
    expect(toolOutputs(provider)).toEqual([AgentCommands.unknownCommandResult("flow.new")])
    expect(journal.frames.some((frame) => frame.type === "call.settled")).toBe(false)

    // An install turn still sends flow.new to the install API, where the server owns the confirmation.
    const installed = producer(
      (path) => file(path, JOURNEY),
      () => Response.json({ confirmation: "confirm-1", state: "pending" }, { status: 202 })
    )
    const asked = model([execute("flow.new", JSON.stringify({ description: "label new issues" }))])
    await runWithDocs(install, asked, installed, PAGES)
    expect(installed.calls).toMatchObject([{
      body: {
        method: "POST",
        path: "/api/flows",
        key: `chat:${install.turnId}:0`,
        payload: { description: "label new issues" }
      }
    }])
    expect(installed.frames.filter((frame) => frame.type === "call.settled")).toEqual([
      { runId: "run", type: "call.settled", link: 0, ordinal: 0, name: "flow.new", verdict: "run" }
    ])
    expect(toolOutputs(asked)).toEqual(["{\"confirmation\":\"confirm-1\",\"state\":\"pending\"}"])
  })
})

/**
 * The hosted Cloud chat is an account conversation, and compose wires an
 * install API only for a single-owner install
 * (backend/internal/compose/main.go), so every hosted turn's grant carries
 * none. Withholding the screen-only flows behind that credential left the
 * Cloud agent unable to take any act a person takes on their own screen: live
 * on smithers.sh, asked to list a repository's issues, it answered "I can't
 * list issues right now, but I can show you the documentation using the /docs
 * command", and asked to run the issues namespace, "that namespace isn't
 * available".
 */
describe("a Cloud account conversation runs the screen-only flows for its author", () => {
  test("every Appendix B.1 flow is offered without an install API, and the search a person can run is among them", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([{ name: "commands", arguments: JSON.stringify({ action: "list" }) }])
    await runWithDocs(account, provider, journal, PAGES)
    const listed = (JSON.parse(toolOutputs(provider)[0]!) as {
      commands: ReadonlyArray<{ readonly name: string }>
    }).commands.map((command) => command.name)
    expect(account.api).toBeUndefined()
    expect([...listed.filter((name) => Object.hasOwn(UiInstruction.UI_INSTRUCTION_FIELDS, name))].sort())
      .toEqual([...Object.keys(UiInstruction.UI_INSTRUCTION_FIELDS)].sort())
    for (const name of ["search.issues", "history", "help", "wiki.open", "theme"]) expect(listed).toContain(name)
    // The screen is the whole act: nothing reached the API or the repository.
    expect([journal.calls, journal.reads, journal.lists]).toEqual([[], [], []])
  })

  test("the search runs as a request on the author's own screen, with its declared field and no route", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([execute("search.issues", JSON.stringify({ query: "roninjin10/e2e-verify open" }))])
    await runWithDocs(account, provider, journal, PAGES)
    expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "call.settled", "delta", "done"])
    for (const frame of journal.frames) expect(NativeAgent.AgentTurnFrameSchema.safeParse(frame).success).toBe(true)
    expect(journal.frames[1]).toEqual({
      runId: "run",
      type: "call.settled",
      link: 0,
      ordinal: 0,
      name: "search.issues",
      verdict: "run",
      ui: { command: "search.issues", query: "roninjin10/e2e-verify open" }
    })
    expect(toolOutputs(provider)).toEqual([screenRequest("search.issues")])
    // The two facts that stop an invented answer: whose browser runs it, and
    // that this host cannot see the screen. Root's turn had neither.
    expect(toolOutputs(provider)[0]).toContain("Their browser runs it")
    expect(toolOutputs(provider)[0]).toContain("cannot see their screen")
    expect(toolOutputs(provider)[0]).not.toMatch(/\bfound:|\bresults?:/)
    expect([journal.calls, journal.reads, journal.lists]).toEqual([[], [], []])
  })

  test("the turn records what it could do, as counts and flags an operator can read", async () => {
    const lines: Array<string> = []
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([])
    await Effect.runPromise(
      runDurableChatTurn(
        provider.model,
        account,
        { modelId: "m" },
        "http://callback.test",
        journal.fetchImpl,
        undefined,
        PAGES,
        createHostDiagnostics({ turnId: account.turnId, write: (line) => lines.push(line) })
      )
    )
    const offered = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.event === "host_tools")
    expect(offered).toMatchObject({
      diagnostic: HOST_DIAGNOSTIC_MARKER,
      turnId: account.turnId,
      phase: "offered",
      commands: CLOUD_ACCOUNT_COMMANDS.length,
      api: false,
      source: false,
      docs: PAGES.length,
      account: true
    })
    // A count and a flag only: no command, payload, destination or credential.
    expect(JSON.stringify(offered)).not.toContain("search")
  })

  /*
   * WHICH prompt the turn read, in the same channel.
   *
   * The two benign refusals of 2026-10-14 10:36Z and 10:37Z were
   * indistinguishable in the journal from a provider that answered nothing,
   * and the instructions the turn actually read were the one thing no frame
   * carried: the host REPLACES them, so the request's own text proves nothing.
   * A digest and a length tell two prompt revisions apart without putting one
   * line of the prompt, or one word the person wrote, into a log.
   */
  test("the turn records the SHAPE of the prompt it read: lengths, counts and a digest, never its text", async () => {
    const read = async (turn: DurableChatGrant) => {
      const lines: Array<string> = []
      const provider = model([])
      await Effect.runPromise(
        runDurableChatTurn(
          provider.model,
          turn,
          { modelId: "m" },
          "http://callback.test",
          producer((path) => file(path, JOURNEY)).fetchImpl,
          undefined,
          PAGES,
          createHostDiagnostics({ turnId: turn.turnId, write: (line) => lines.push(line) })
        )
      )
      const record = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.event === "host_tools" && row.phase === "prompt")
      return { record, system: systemText(provider.requests[0]) }
    }
    const { record, system } = await read(account)
    expect(record).toMatchObject({
      diagnostic: HOST_DIAGNOSTIC_MARKER,
      turnId: account.turnId,
      phase: "prompt",
      replaced: true,
      instructionBytes: Buffer.byteLength(system),
      appended: false,
      appendedBytes: 0,
      context: false,
      messages: 1
    })
    // The digest identifies the revision and carries none of its text back.
    expect(record?.instructionSha).toBe(createHash("sha256").update(system).digest("hex").slice(0, 12))
    expect(record?.instructionLines).toBe(system.split("\n").length)
    const serialized = JSON.stringify(record)
    for (const leak of ["JOURNEY", "search", "flow.new", "can't-yet", "Smithers,"]) {
      expect(serialized, `the record must not carry ${leak}`).not.toContain(leak)
    }
    // A turn the host owns no prompt for says so, and still reports its shape.
    const bare = await read({ ...sourceless, request: { ...question, messages: [] } })
    expect(bare.record).toMatchObject({ replaced: true, messages: 0 })
  })
})

// #3872: requesting a form must not execute its shared-state command.
test("Cloud asks for flow.edit on the author's screen without calling the install API", async () => {
  const journal = producer((path) => file(path, JOURNEY), stackRoutes)
  const provider = model([execute("flow.edit", JSON.stringify({ name: "review", request: "Check accessibility" }))])
  await runWithDocs(account, provider, journal, PAGES)
  expect(journal.calls).toEqual([])
  expect(journal.frames.find((frame) => frame.type === "call.settled")).toMatchObject({
    name: "flow.edit",
    ui: { command: "flow.edit", name: "review", request: "Check accessibility" }
  })
})

test("each catalog form reaches only the author's screen with no HTTP call", async () => {
  for (const name of Object.keys(UiInstruction.FORM_INSTRUCTION_FIELDS)) {
    const journal = producer((path) => file(path, JOURNEY), stackRoutes)
    const provider = model([execute(name, "{}")])
    await runWithDocs(account, provider, journal, PAGES)
    expect(journal.calls, name).toEqual([])
    expect(journal.frames.find((frame) => frame.type === "call.settled"), name).toMatchObject({
      name,
      ui: { command: name }
    })
  }
}, 120_000)

// Same host seam as the command-selection tests: local estimates, never billing claims.
test("Cloud form command prompt accounting", async () => {
  const provider = model([])
  await runWithDocs(account, provider, producer((path) => file(path, JOURNEY), stackRoutes), PAGES)
  const system = systemText(provider.requests[0])
  process.stdout.write(
    JSON.stringify({
      metric: "cloud-form-prompt",
      bytes: Buffer.byteLength(system),
      estimatedTokens: Tokens.estimate(system)
    }) + "\n"
  )
  expect(toolNames(provider.requests[0])).toEqual(["commands"])
})

// The committed UI instruction has no browser completion receipt.
test("form results acknowledge a request until browser completion exists", async () => {
  const journal = producer((path) => file(path, JOURNEY))
  const provider = model([execute("flow.new", JSON.stringify({ description: "label issues" }))])
  await runWithDocs(account, provider, journal, PAGES)
  const output = toolOutputs(provider)[0]!
  expect(output).toContain("Requested")
  expect(output).toContain("cannot see")
  expect(output).not.toContain("form is open")
  expect(output).not.toContain("filled in")
})
