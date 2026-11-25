import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { CliAdapter, Core, GuiAdapter, McpAdapter, Principal, SdkAdapter } from "../../src/index.ts"

const text = { type: "string", minLength: 1 } as const

const object = (properties: Core.Flow["payload"]["properties"] & {}) => ({
  type: "object" as const,
  properties,
  required: Object.keys(properties),
  additionalProperties: false
})

const revision = (row: Core.Json | undefined): number =>
  typeof row === "object" && row !== null && "rev" in row ? Number(String(row.rev).slice(1)) : 0

/** The slice-1 flows: a plan tree, a workflow, a pane, a person-only answer, a protected merge and a private note. */
export const flows: ReadonlyArray<Core.Flow> = [
  {
    tag: "plan/upsert-node",
    title: "Write a plan block",
    payload: object({ page: text, blockId: text, title: text }),
    capabilities: ["plan:write"],
    run: (payload, tx) => {
      const key = `${String(payload["page"])}#${String(payload["blockId"])}`
      const row = { ...payload, rev: `r${revision(tx.get("plan", key)) + 1}` }
      tx.put("plan", key, row)
      return row
    }
  },
  {
    tag: "workflow/start",
    title: "Start a workflow from a plan block",
    payload: object({ page: text, blockId: text }),
    capabilities: ["workflow:run"],
    run: (payload, tx) => {
      const page = String(payload["page"])
      const blockId = String(payload["blockId"])
      const node = tx.get("plan", `${page}#${blockId}`)
      if (node === undefined) return new Core.Failed("missing_plan_node", "the plan has no such block")
      const plan = { page, blockId, rev: `r${revision(node)}` }
      tx.causedBy(plan)
      tx.put("runs", String(tx.rows("runs").length + 1), plan)
      return plan
    }
  },
  {
    tag: "pane/maximize",
    title: "Maximize a pane",
    payload: object({ paneId: text }),
    capabilities: ["pane:write"],
    run: (payload, tx) => {
      tx.put("panes", "maximized", payload)
      return payload
    }
  },
  {
    tag: "run/answer",
    title: "Answer a run's question",
    payload: object({ runId: text, value: text }),
    personOnly: "Only the person answers a run's question.",
    run: (payload, tx) => {
      tx.put("answers", String(payload["runId"]), payload)
      return payload
    }
  },
  {
    tag: "pr/merge",
    title: "Merge a pull request",
    payload: object({ number: { type: "integer", minimum: 1 } }),
    capabilities: ["pr:merge"],
    protected: true,
    run: (payload, tx) => {
      tx.put("merges", String(payload["number"]), payload)
      return payload
    }
  },
  {
    tag: "notes/write",
    title: "Write a private note",
    payload: object({ title: text }),
    private: true,
    run: (payload, tx) => {
      tx.put("notes", String(tx.rows("notes").length + 1), payload)
      return payload
    }
  }
]

export const projections: ReadonlyArray<Core.Projection> = [
  { name: "plan/nodes", title: "Plan blocks", collection: "plan" },
  { name: "workflow/runs", title: "Workflow runs", collection: "runs" },
  { name: "pane/state", title: "Pane state", collection: "panes" },
  { name: "run/answers", title: "Answers", collection: "answers" },
  { name: "pr/merges", title: "Merges", collection: "merges", capabilities: ["pr:merge"] }
]

const everything = ["plan:write", "workflow:run", "pane:write", "pr:merge"]

export const evidence = {
  mcp: { kind: "mcp", transport: "stdio", tokenRef: "tok-agent" },
  incur: { kind: "incur", sessionFile: "/home/will/.smithers/session" },
  sdk: { kind: "sdk", runCredential: Redacted.make("run-credential") },
  frame: { kind: "gui", door: "frame", session: "frame-plan-tree", plugin: "plan-tree" },
  strip: { kind: "gui", door: "strip", session: "sess-will" }
} as const satisfies Record<string, Principal.DoorEvidence>

export const run = Effect.runPromise

/** One engine with the slice-1 catalog, and the credentials of one person's four doors. */
export const world = async (options: { readonly now?: () => number } = {}) => {
  const credentials = Principal.make({
    verify: Principal.sessions({
      "tok-agent": { kind: "mcp", subject: "will", session: "s-mcp", capabilities: everything },
      "tok-narrow": {
        kind: "mcp",
        subject: "will",
        session: "s-narrow",
        capabilities: everything,
        ceiling: ["plan:write"]
      },
      "/home/will/.smithers/session": { kind: "incur", subject: "will", session: "s-cli", capabilities: everything },
      "run-credential": { kind: "sdk", subject: "will", session: "s-run", capabilities: everything },
      "sess-will": { kind: "gui", door: "person", subject: "will", session: "s-gui", capabilities: everything },
      "sess-ada": { kind: "gui", door: "person", subject: "ada", session: "s-ada", capabilities: everything },
      // One frame credential per plugin installation. The host issues it; the frame cannot pick its plugin.
      "frame-plan-tree": {
        kind: "gui",
        door: "frame",
        plugin: "plan-tree",
        subject: "will",
        session: "s-frame-plan-tree",
        capabilities: everything
      },
      "frame-narrow": {
        kind: "gui",
        door: "frame",
        plugin: "narrow",
        subject: "will",
        session: "s-frame-narrow",
        capabilities: everything
      },
      "frame-nobody": {
        kind: "gui",
        door: "frame",
        plugin: "nobody",
        subject: "will",
        session: "s-frame-nobody",
        capabilities: everything
      },
      // The plan-tree frame of a viewer whose own credential is scoped.
      "frame-scoped": {
        kind: "gui",
        door: "frame",
        plugin: "plan-tree",
        subject: "will",
        session: "s-frame-scoped",
        capabilities: everything,
        ceiling: ["pane:write", "pr:merge"]
      },
      // The plan-tree frame of a viewer whose session was granted less than the plugin declares.
      "frame-limited": {
        kind: "gui",
        door: "frame",
        plugin: "plan-tree",
        subject: "will",
        session: "s-frame-limited",
        capabilities: ["plan:write", "pr:merge"]
      }
    }, { "plan-tree": ["plan:write", "workflow:run", "pane:write"], narrow: ["plan:write"] }),
    ...(options.now === undefined ? {} : { now: options.now })
  })
  const engine = await run(Core.make({ credentials, flows, projections }))
  return { credentials, engine }
}

export type Outcome =
  | { readonly ok: true; readonly value: any }
  | { readonly ok: false; readonly code: string; readonly error: any }

/** One client, driven only through its own wire: what it offers, and a call by tag. */
export interface Client {
  readonly label: "MCP" | "CLI" | "SDK" | "GUI"
  /** The tags the client offers a delegate. */
  readonly offered: () => Promise<ReadonlyArray<string>>
  readonly call: (tag: string, payload: Record<string, Core.Json>) => Promise<Outcome>
}

const refusedBy = (error: any): Outcome => ({ ok: false, code: String(error.reason), error })

export const mcpClient = async (engine: Core.Engine, from: Principal.McpEvidence = evidence.mcp) => {
  const server = await run(McpAdapter.make({ engine, evidence: from }))
  let id = 0
  const rpc = async (method: string, params?: unknown): Promise<any> =>
    JSON.parse((await run(server.handle(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })))) as string)
  const client: Client = {
    label: "MCP",
    offered: async () => (await rpc("tools/list")).result.tools.map((tool: McpAdapter.Tool) => tool.name),
    call: async (tag, payload) => {
      const { result } = await rpc("tools/call", { name: McpAdapter.toolName(tag), arguments: payload })
      // The text block and the structured block are the same bytes.
      if (result.content[0].text !== JSON.stringify(JSON.parse(result.content[0].text))) {
        throw new Error("not canonical")
      }
      return result.isError === true
        ? { ok: false, code: result.structuredContent.code, error: result.structuredContent }
        : { ok: true, value: JSON.parse(result.content[0].text) }
    }
  }
  return { server, rpc, client }
}

export const cliClient = async (engine: Core.Engine) => {
  const cli = await run(CliAdapter.make({ engine, evidence: evidence.incur }))
  const client: Client = {
    label: "CLI",
    offered: async () => (await run(cli.commands)).map((command) => command.name),
    call: async (tag, payload) => {
      // The flag the command itself publishes for each field; a tag the CLI does not offer gets the short flag.
      const published = (await run(cli.commands)).find((command) => command.name === tag)?.flags ?? []
      const flags = Object.entries(payload).flatMap(([field, value]) => [
        published.find((flag) => flag.field === field)?.flag ?? CliAdapter.flagOf(field),
        typeof value === "string" ? value : JSON.stringify(value)
      ])
      const exit = await run(cli.run([tag, ...flags]))
      if (exit.exitCode !== 0) {
        const error = JSON.parse(exit.stderr)
        return { ok: false, code: error.code, error }
      }
      return { ok: true, value: JSON.parse(exit.stdout) }
    }
  }
  return { cli, client }
}

export const sdkClient = async (engine: Core.Engine) => {
  const sdk = await run(SdkAdapter.make({ engine, evidence: evidence.sdk }))
  const promises = SdkAdapter.promises(sdk)
  const client: Client = {
    label: "SDK",
    offered: async () => (await promises.catalog()).map((entry) => entry.tag),
    call: (tag, payload) => promises.call(tag, payload).then((value): Outcome => ({ ok: true, value }), refusedBy)
  }
  return { sdk, promises, client }
}

export const guiClient = async (
  engine: Core.Engine,
  options: { readonly plugin?: string; readonly person?: string; readonly frame?: string } = {}
) => {
  const plugin = options.plugin ?? "plan-tree"
  const gui = await run(GuiAdapter.make({
    engine,
    frame: { session: options.frame ?? `frame-${plugin}`, plugin },
    person: { session: options.person ?? "sess-will" }
  }))
  const client: Client = {
    label: "GUI",
    offered: async () => (await run(gui.actions.list)).map((entry) => entry.tag),
    call: async (tag, payload) => {
      const isFlow = (await run(gui.palette)).some((entry) => entry.tag === tag)
      const effect: Effect.Effect<unknown, unknown> = isFlow
        ? Effect.map(gui.actions.dispatch(tag, payload), (dispatched) => dispatched.requested)
        : gui.queries.read(tag, payload)
      return run(Effect.result(effect)).then((result): Outcome =>
        result._tag === "Success" ? { ok: true, value: result.success } : refusedBy(result.failure)
      )
    }
  }
  return { gui, client }
}

/** The four clients over one engine. */
export const clients = async (engine: Core.Engine) => {
  const mcp = await mcpClient(engine)
  const cli = await cliClient(engine)
  const sdk = await sdkClient(engine)
  const gui = await guiClient(engine)
  return { mcp, cli, sdk, gui, all: [mcp.client, cli.client, sdk.client, gui.client] }
}
