// M3 release gate: one local SQLite-backed node, its real stdio MCP session, and the app-core CLI, SDK and GUI
// adapters opened on the same engine. No mocks: the workflow is read from a temp repo's .smithers/workflows/smoke.vibe,
// every write commits through the node's SQLite shard, and every read goes through a client's own wire.
import { CauseReceipt, CliAdapter, type Core, GuiAdapter, McpAdapter, Principal, SdkAdapter } from "@smthrs/app-core"
import { ShardProtocol } from "@smthrs/sync"
import { Effect, Redacted, Schema } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startNode } from "../src/commands/NodeServe.ts"

const run = Effect.runPromise
const shard = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:example/smoke")
const tokens = {
  mcp: "test-only-node-agent-token-never-deployed",
  incur: "/home/person/.smithers/session",
  sdk: "test-only-run-credential-never-deployed",
  person: "test-only-person-session",
  frame: "test-only-frame-session"
} as const
const capabilities = ["shard:append", "workflow:run"]

// The canonical shape of a repository workflow (compare .smithers/workflows/gate.vibe): declarative, `Schema`
// imported explicitly, one `Flow.make` default export.
const smokeVibe = `// The smoke workflow: one run that records its note.
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

export default Flow.make("smoke", {
  description: "Record one smoke run against the local node.",
  modelInvocable: false,
  payload: { run: Schema.String, note: Schema.String },
  success: Schema.Unknown,
  body: () => Node.all({})
})
`

/**
 * Discovers each `.vibe` workflow under `<repo>/.smithers/workflows` from its committed text: tag, description and
 * string payload fields. apps/mvp owns the realm that executes the body; this package may not import it, so the node
 * hosts a flow that records the payload in `smoke-runs`.
 */
const discover = (repo: string): ReadonlyArray<Core.Flow> => {
  const directory = join(repo, ".smithers", "workflows")
  return readdirSync(directory).filter((file) => file.endsWith(".vibe")).sort().map((file) => {
    const source = readFileSync(join(directory, file), "utf8")
    const read = (pattern: RegExp, what: string) => {
      const found = pattern.exec(source)?.[1]
      if (found === undefined) throw new Error(`${file} declares no ${what}`)
      return found
    }
    const fields = [...read(/payload: \{([^}]+)\}/, "payload").matchAll(/(\w+): Schema\.String/g)].map((m) => m[1]!)
    return {
      tag: read(/Flow\.make\("([^"]+)"/, "tag"),
      title: file.replace(/\.vibe$/, ""),
      description: read(/description: "([^"]+)"/, "description"),
      capabilities: ["workflow:run"],
      payload: {
        type: "object",
        properties: Object.fromEntries(fields.map((field) => [field, { type: "string", minLength: 1 }])),
        required: fields,
        additionalProperties: false
      },
      run: (payload, tx) => {
        tx.put("smoke-runs", String(payload["run"]), payload)
        return payload
      }
    } satisfies Core.Flow
  })
}

/** A person-only flow the node hosts beside the discovered workflow. */
const approve: Core.Flow = {
  tag: "smoke/approve",
  title: "Approve a smoke run",
  personOnly: "Only the person approves a smoke run.",
  capabilities: ["workflow:run"],
  payload: {
    type: "object",
    properties: { run: { type: "string", minLength: 1 } },
    required: ["run"],
    additionalProperties: false
  },
  run: (payload, tx) => {
    tx.put("approvals", String(payload["run"]), payload)
    return payload
  }
}

const smokeRuns: Core.Projection = { name: "smoke/runs", title: "Smoke runs", collection: "smoke-runs" }

type Outcome = { readonly ok: true; readonly value: any } | { readonly ok: false; readonly code: string }
type Label = "MCP" | "CLI" | "SDK" | "GUI"
interface Client {
  readonly label: Label
  /** The catalog this client publishes, as tag, description and payload schema. */
  readonly catalog: () => Promise<ReadonlyArray<{ tag: string; description: string; payload: unknown }>>
  readonly call: (tag: string, payload: Record<string, Core.Json>) => Promise<Outcome>
}

/** Newline-delimited JSON-RPC over the node's real stdio session. */
const stdioMcp = (node: Awaited<ReturnType<typeof startNode>>) => {
  const input = new PassThrough()
  const output = new PassThrough()
  const session = node.serveStdio({ input, output })
  const pending = new Map<number, (reply: any) => void>()
  let buffered = ""
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8")
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const reply = JSON.parse(buffered.slice(0, end))
      buffered = buffered.slice(end + 1)
      pending.get(reply.id)?.(reply)
      pending.delete(reply.id)
    }
  })
  let id = 0
  const rpc = (method: string, params?: object): Promise<any> =>
    new Promise((resolve) => {
      pending.set(++id, resolve)
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`)
    })
  const client: Client = {
    label: "MCP",
    catalog: async () =>
      (await rpc("tools/list")).result.tools.map((tool: McpAdapter.Tool) => ({
        tag: tool.name,
        description: tool.description,
        payload: tool.inputSchema
      })),
    call: async (tag, payload) => {
      const { result } = await rpc("tools/call", { name: McpAdapter.toolName(tag), arguments: payload })
      return result.isError === true
        ? { ok: false, code: result.structuredContent.code }
        : { ok: true, value: JSON.parse(result.content[0].text) }
    }
  }
  return {
    client,
    rpc,
    close: async () => {
      input.end()
      return session
    }
  }
}

const cliClient = async (engine: Core.Engine): Promise<Client> => {
  const cli = await run(CliAdapter.make({ engine, evidence: { kind: "incur", sessionFile: tokens.incur } }))
  return {
    label: "CLI",
    catalog: async () =>
      (await run(cli.commands)).map((command) => ({
        tag: command.name,
        description: command.description,
        payload: command.options
      })),
    call: async (tag, payload) => {
      const published = (await run(cli.commands)).find((command) => command.name === tag)?.flags ?? []
      const flags = Object.entries(payload).flatMap(([field, value]) => [
        published.find((flag) => flag.field === field)?.flag ?? CliAdapter.flagOf(field),
        typeof value === "string" ? value : JSON.stringify(value)
      ])
      const exit = await run(cli.run([tag, ...flags]))
      return exit.exitCode === 0
        ? { ok: true, value: JSON.parse(exit.stdout) }
        : { ok: false, code: JSON.parse(exit.stderr).code }
    }
  }
}

const refused = (error: any): Outcome => ({ ok: false, code: String(error.reason) })

const sdkClient = async (engine: Core.Engine): Promise<Client> => {
  const sdk = await run(SdkAdapter.make({
    engine,
    evidence: { kind: "sdk", runCredential: Redacted.make(tokens.sdk) }
  }))
  const promises = SdkAdapter.promises(sdk)
  return {
    label: "SDK",
    catalog: async () =>
      (await promises.catalog()).map((entry) => ({
        tag: entry.tag,
        description: entry.description,
        payload: entry.payload
      })),
    call: (tag, payload) => promises.call(tag, payload).then((value): Outcome => ({ ok: true, value }), refused)
  }
}

const guiClient = async (engine: Core.Engine) => {
  const gui = await run(GuiAdapter.make({
    engine,
    frame: { session: tokens.frame, plugin: "smoke-panel" },
    person: { session: tokens.person }
  }))
  const client: Client = {
    label: "GUI",
    catalog: async () =>
      (await run(gui.actions.list)).map((entry) => ({
        tag: entry.tag,
        description: entry.description,
        payload: entry.payload
      })),
    call: async (tag, payload) => {
      const isFlow = (await run(gui.palette)).some((entry) => entry.tag === tag)
      const effect: Effect.Effect<unknown, unknown> = isFlow
        ? Effect.map(gui.actions.dispatch(tag, payload), (dispatched) => dispatched.requested)
        : gui.queries.read(tag, payload)
      const result = await run(Effect.result(effect))
      return result._tag === "Success" ? { ok: true, value: result.success } : refused(result.failure)
    }
  }
  return { gui, client }
}

const verify = Principal.sessions({
  [tokens.mcp]: { kind: "mcp", subject: "person", session: "s-mcp", capabilities },
  [tokens.incur]: { kind: "incur", subject: "person", session: "s-cli", capabilities },
  [tokens.sdk]: { kind: "sdk", subject: "person", session: "s-sdk", capabilities },
  [tokens.person]: { kind: "gui", door: "person", subject: "person", session: "s-gui", capabilities },
  [tokens.frame]: {
    kind: "gui",
    door: "frame",
    plugin: "smoke-panel",
    subject: "person",
    session: "s-frame",
    capabilities
  }
}, { "smoke-panel": capabilities })

const unwrap = (outcome: Outcome, label: string) => {
  if (!outcome.ok) throw new Error(`${label} refused ${outcome.code}`)
  return outcome.value
}

describe("a local SQLite node serves one catalog and one history to MCP, CLI, SDK and GUI", () => {
  let repo: string
  let file: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "smithers-local-node-four-"))
    mkdirSync(join(repo, ".smithers", "workflows"), { recursive: true })
    writeFileSync(join(repo, ".smithers", "workflows", "smoke.vibe"), smokeVibe)
    file = join(repo, ".smithers", "node.sqlite")
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  const open = async () => {
    const node = await startNode({
      file,
      shard,
      node: "local",
      token: tokens.mcp,
      verify,
      flows: [...discover(repo), approve]
    })
    await run(node.engine.register(smokeRuns))
    const mcp = stdioMcp(node)
    const gui = await guiClient(node.engine)
    const clients: ReadonlyArray<Client> = [
      mcp.client,
      await cliClient(node.engine),
      await sdkClient(node.engine),
      gui.client
    ]
    return {
      node,
      mcp,
      gui: gui.gui,
      clients,
      close: async () => {
        expect(await mcp.close()).toBe("closed")
        await node.close()
      }
    }
  }

  it("discovers smoke.vibe from the temp repo", () => {
    expect(discover(repo).map(({ tag, description }) => ({ tag, description }))).toEqual([
      { tag: "smoke", description: "Record one smoke run against the local node." }
    ])
  })

  it("every client publishes the same workflow catalog, with the person-only flow absent", async () => {
    const { clients, gui, close } = await open()
    try {
      const catalogs = await Promise.all(clients.map(async (client) => {
        const entries = await client.catalog()
        // MCP names tools with `__` for `/`; every other wire publishes the tag itself.
        const normal = entries.map((entry) => ({ ...entry, tag: entry.tag.replaceAll("__", "/") }))
        return [...normal].sort((a, b) => a.tag.localeCompare(b.tag))
      }))
      const [mcp, cli, sdk, frame] = catalogs
      expect(mcp!.map((entry) => entry.tag)).toEqual(["ref/cause", "shard/append", "smoke", "smoke/runs"])
      const [smoke] = discover(repo)
      expect(mcp!.find((entry) => entry.tag === "smoke")).toEqual({
        tag: "smoke",
        description: smoke!.description,
        payload: smoke!.payload
      })
      // MCP, the CLI and the SDK publish flows and queries alike: the same bytes.
      expect(CauseReceipt.canonical(cli as any), "CLI").toBe(CauseReceipt.canonical(mcp as any))
      expect(CauseReceipt.canonical(sdk as any), "SDK").toBe(CauseReceipt.canonical(mcp as any))
      // A GUI frame's action list holds flows only; queries are read by name. Its flows are the same bytes.
      const queries = new Set(["ref/cause", "smoke/runs"])
      expect(CauseReceipt.canonical(frame as any), "GUI").toBe(
        CauseReceipt.canonical(mcp!.filter((entry) => !queries.has(entry.tag)) as any)
      )
      // The person-only flow is the host strip's alone.
      expect((await run(gui.hostStrip.items)).map((entry) => entry.tag)).toEqual(["smoke/approve"])
    } finally {
      await close()
    }
  })

  it("a run started from any one client yields a receipt every other client reads back byte for byte", async () => {
    const { clients, node, close } = await open()
    const receipts: Array<string> = []
    try {
      for (const [index, origin] of clients.entries()) {
        const payload = { run: `smoke-${index + 1}`, note: `from ${origin.label}` }
        const started = unwrap(await origin.call("smoke", payload), origin.label)
        expect(started, origin.label).toMatchObject({
          runId: `run-${index + 1}`,
          outputRef: `out/run-${index + 1}`,
          output: payload,
          cause: { outputRef: `out/run-${index + 1}`, nodeId: "smoke", attempt: 1, journalSeq: index + 1 }
        })
        expect(started.cause.promptHash, origin.label).toMatch(/^[0-9a-f]{64}$/)
        const receipt = CauseReceipt.canonical(started.cause)
        receipts.push(receipt)

        // Immediately, with no sync step: every client, the origin included, reads the same receipt and the same row.
        for (const reader of clients) {
          const cause = unwrap(await reader.call("ref/cause", { ref: started.outputRef }), reader.label)
          expect(cause.rows.map(CauseReceipt.canonical), `${origin.label} -> ${reader.label}`).toEqual([receipt])
          const rows = unwrap(await reader.call("smoke/runs", { key: payload.run }), reader.label)
          expect(rows.rows, `${origin.label} -> ${reader.label}`).toEqual([payload])
        }
        // The commit is the node's SQLite shard head.
        expect((await node.sync()).position.seq, origin.label).toBe(index + 1)
      }
      expect(new Set(receipts).size).toBe(4)
    } finally {
      await close()
    }

    // The receipts are durable: a node reopened on the same SQLite file answers ref/cause with the same bytes.
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const { state } = db.prepare("SELECT state FROM node_shard WHERE id = 1").get() as { state: string }
      expect(JSON.parse(state).head.head).toBe(4)
    } finally {
      db.close()
    }
    const again = await open()
    try {
      for (const [index, receipt] of receipts.entries()) {
        for (const reader of again.clients) {
          const cause = unwrap(await reader.call("ref/cause", { ref: `out/run-${index + 1}` }), reader.label)
          expect(cause.rows.map(CauseReceipt.canonical), `reopened ${reader.label}`).toEqual([receipt])
        }
      }
    } finally {
      await again.close()
    }
  })

  it("refuses the person-only flow from an agent principal on MCP, CLI and SDK, and from a frame, writing nothing", async () => {
    const { clients, gui, node, close } = await open()
    try {
      const before = node.engine.snapshot()
      for (const client of clients) {
        const outcome = await client.call("smoke/approve", { run: "smoke-1" })
        expect(outcome, client.label).toEqual({ ok: false, code: "person_only" })
      }
      expect(node.engine.snapshot()).toBe(before)
      expect((await node.sync()).position.seq).toBe(0)

      // The same flow is live: the person's own press through the host strip commits it.
      const pressed = await run(gui.hostStrip.press("smoke/approve", { run: "smoke-1" }))
      expect(pressed).toMatchObject({ output: { run: "smoke-1" }, cause: { nodeId: "smoke/approve", journalSeq: 1 } })
      expect((await node.sync()).position.seq).toBe(1)
    } finally {
      await close()
    }
  })
})
