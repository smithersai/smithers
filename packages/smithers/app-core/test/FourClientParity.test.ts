import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { CauseReceipt, type Core, McpAdapter } from "../src/index.ts"
import { type Client, clients, guiClient, run, world } from "./support/fixture.ts"

const answer = { runId: "run-7", value: "yes" }

describe("tracer bullet: run/answer is the person's alone", () => {
  it("is absent from MCP tools/list, the CLI's commands, the SDK's catalog and the frame's actions", async () => {
    const { engine } = await world()
    const { all, mcp, gui } = await clients(engine)
    expect((await mcp.rpc("tools/list")).result.tools.map((tool: McpAdapter.Tool) => tool.name)).not.toContain(
      "run__answer"
    )
    for (const client of all) {
      const offered = await client.offered()
      expect(offered, client.label).toContain(client.label === "MCP" ? "plan__upsert-node" : "plan/upsert-node")
      expect(offered, client.label).not.toContain(client.label === "MCP" ? "run__answer" : "run/answer")
      expect(offered, client.label).not.toContain(client.label === "MCP" ? "pr__merge" : "pr/merge")
    }
    expect((await run(gui.gui.hostStrip.items)).map((entry) => entry.tag)).toEqual(["run/answer", "pr/merge"])
  })

  it("refuses person_only through MCP, the CLI, the SDK and a frame's dispatch, and writes nothing", async () => {
    const { engine } = await world()
    const { all } = await clients(engine)
    const before = engine.snapshot()
    for (const client of all) {
      const outcome = await client.call("run/answer", answer)
      expect(outcome, client.label).toMatchObject({ ok: false, code: "person_only" })
    }
    expect(engine.snapshot()).toBe(before)
  })

  it("names the refusal the same way on every wire", async () => {
    const { engine } = await world()
    const { mcp, cli, sdk, gui } = await clients(engine)
    const viaMcp = await mcp.rpc("tools/call", { name: "run__answer", arguments: answer })
    expect(viaMcp.result).toMatchObject({
      isError: true,
      structuredContent: { code: "person_only", operation: "run/answer", cause: "agent" }
    })
    const viaCli = await run(cli.cli.run(["run/answer", "--run-id", "run-7", "--value", "yes"]))
    expect([viaCli.exitCode, viaCli.stdout, JSON.parse(viaCli.stderr).code]).toEqual([1, "", "person_only"])
    await expect(sdk.promises.call("run/answer", answer)).rejects.toMatchObject({
      _tag: "@smthrs/app-core/CoreError",
      reason: "person_only",
      code: "flow"
    })
    expect(await run(Effect.flip(gui.gui.actions.dispatch("run/answer", answer)))).toMatchObject({
      _tag: "plugin/PluginRefused",
      plugin: "plan-tree",
      reason: "person_only"
    })
  })

  it("succeeds only through hostStrip.press with the person's session", async () => {
    const { engine } = await world()
    const { gui } = await guiClient(engine)
    const requested = await run(gui.hostStrip.press("run/answer", answer))
    expect(requested).toMatchObject({ runId: "run-1", outputRef: "out/run-1", output: answer })
    expect(requested.cause).toMatchObject({ nodeId: "run/answer", attempt: 1, journalSeq: 1 })
    expect((await run(gui.queries.read("run/answers"))).rows).toEqual([answer])

    // A host that holds no person session cannot press: an agent's token is not a GUI session.
    const { gui: headless } = await guiClient(engine, { person: "tok-agent" })
    expect(await run(Effect.flip(headless.hostStrip.press("run/answer", answer)))).toMatchObject({
      _tag: "@smthrs/app-core/AuthRefused",
      reason: "unknown_credential"
    })
    expect((await run(gui.queries.read("run/answers"))).rows).toHaveLength(1)
  })
})

describe("zero-diff addition", () => {
  const tagNote: Core.Flow = {
    tag: "notes/tag",
    title: "Tag a note",
    payload: {
      type: "object",
      properties: {
        id: { type: "string" },
        weight: { type: "integer" },
        pinned: { type: "boolean" },
        labels: { type: "array", items: { type: "string" } }
      },
      required: ["id", "weight", "pinned", "labels"],
      additionalProperties: false
    },
    run: (payload, tx) => {
      tx.put("tags", String(payload["id"]), payload)
      return payload
    }
  }

  it("a flow registered after the clients were built appears in all four and runs through each", async () => {
    const { engine } = await world()
    const { all, gui } = await clients(engine)
    for (const client of all) expect(await client.offered(), client.label).not.toContain("notes/tag")

    await run(engine.register(tagNote))
    await run(engine.register({ name: "notes/tags", title: "Tags", collection: "tags" }))

    for (const client of all) {
      const tag = client.label === "MCP" ? McpAdapter.toolName("notes/tag") : "notes/tag"
      expect(await client.offered(), client.label).toContain(tag)
    }
    expect((await run(gui.gui.palette)).map((entry) => entry.tag)).toContain("notes/tag")

    for (const [at, client] of all.entries()) {
      const payload = { id: `n${at}`, weight: at, pinned: at % 2 === 0, labels: ["a", client.label] }
      const outcome = await client.call("notes/tag", payload)
      expect(outcome, client.label).toMatchObject({
        ok: true,
        value: { output: payload, cause: { nodeId: "notes/tag" } }
      })
      const rows = await client.call("notes/tags", { key: payload.id })
      expect(rows, client.label).toMatchObject({ ok: true, value: { rows: [payload] } })
    }
    expect(JSON.parse(engine.snapshot()).head).toBe(4)
  })
})

describe("four-client parity", () => {
  const unwrap = (outcome: Awaited<ReturnType<Client["call"]>>) => {
    if (!outcome.ok) throw new Error(`refused ${outcome.code}`)
    return outcome.value
  }

  /** Five steps over a plan tree and a workflow, then the cause of each workflow output. */
  const trace = async (client: Client) => {
    const call = async (tag: string, payload: Record<string, Core.Json>) => unwrap(await client.call(tag, payload))
    const draft = await call("plan/upsert-node", { page: "roadmap", blockId: "b1", title: "Draft" })
    const first = await call("workflow/start", { page: "roadmap", blockId: "b1" })
    const revised = await call("plan/upsert-node", { page: "roadmap", blockId: "b1", title: "Revised" })
    const second = await call("workflow/start", { page: "roadmap", blockId: "b1" })
    const pane = await call("pane/maximize", { paneId: second.outputRef })
    const causes = [
      await call("ref/cause", { ref: first.outputRef }),
      await call("ref/cause", { ref: second.outputRef })
    ]
    return { steps: [draft, first, revised, second, pane], causes, nodes: await call("plan/nodes", {}) }
  }

  it("the same trace through MCP, CLI, SDK and GUI gives byte-identical snapshots and cause links", async () => {
    const observed: Array<{ label: string; transcript: string; snapshot: string; hash: string }> = []
    for (const label of ["MCP", "CLI", "SDK", "GUI"] as const) {
      // One engine per client: nothing is shared but the catalog.
      const { engine } = await world()
      const client = (await clients(engine)).all.find((candidate) => candidate.label === label)!
      const seen = await trace(client)

      expect(seen.steps.map((step) => step.runId), label).toEqual(["run-1", "run-2", "run-3", "run-4", "run-5"])
      const [first, second] = seen.causes.map((page) => page.rows[0])
      expect(first, label).toEqual({
        outputRef: "out/run-2",
        runId: "run-2",
        nodeId: "workflow/start",
        attempt: 1,
        journalSeq: 2,
        planRef: { page: "roadmap", blockId: "b1", rev: "r1" },
        promptHash: seen.steps[1].cause.promptHash
      })
      expect(second.planRef, label).toEqual({ page: "roadmap", blockId: "b1", rev: "r2" })
      // What ref/cause reads back is the receipt the submit returned.
      expect([first, second], label).toEqual([seen.steps[1].cause, seen.steps[3].cause])
      expect(seen.steps[4].cause.planRef, label).toEqual({ origin: "direct" })
      expect(first.promptHash, label).toMatch(/^[0-9a-f]{64}$/)
      expect(first.promptHash, label).toBe(second.promptHash)
      expect(seen.nodes.rows, label).toEqual([{ page: "roadmap", blockId: "b1", title: "Revised", rev: "r2" }])

      const snapshot = engine.snapshot()
      observed.push({
        label,
        transcript: CauseReceipt.canonical(seen),
        snapshot,
        hash: await run(CauseReceipt.sha256(snapshot))
      })
    }

    const [mcp, ...rest] = observed
    for (const other of rest) {
      expect(other.snapshot, other.label).toBe(mcp!.snapshot)
      expect(other.hash, other.label).toBe(mcp!.hash)
      expect(other.transcript, other.label).toBe(mcp!.transcript)
    }
    expect(new Set(observed.map((each) => each.hash)).size).toBe(1)
    const state = JSON.parse(mcp!.snapshot)
    expect(state.head).toBe(5)
    expect(state.causes.map((receipt: CauseReceipt.CauseReceipt) => receipt.outputRef)).toEqual([
      "out/run-1",
      "out/run-2",
      "out/run-3",
      "out/run-4",
      "out/run-5"
    ])
    expect(state.collections.panes.maximized).toEqual({ paneId: "out/run-4" })
  })

  // Regression, W2-D review (Medium, CliAdapter.ts:175): the CLI read `--format` as its own output
  // option, so a flow whose payload needs `format` ran through MCP, SDK and GUI but not the CLI.
  it("a flow that requires { format: \"csv\" } runs the same through MCP, CLI, SDK and GUI", async () => {
    const exportTable: Core.Flow = {
      tag: "table/export",
      title: "Export a table",
      payload: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["csv", "tsv"] },
          table: { type: "string", minLength: 1 }
        },
        required: ["format", "table"],
        additionalProperties: false
      },
      run: (payload, tx) => {
        tx.put("exports", String(payload["table"]), payload)
        return payload
      }
    }
    const payload = { format: "csv", table: "plan" }
    const observed: Array<{ label: string; transcript: string; snapshot: string }> = []
    for (const label of ["MCP", "CLI", "SDK", "GUI"] as const) {
      const { engine } = await world()
      const client = (await clients(engine)).all.find((candidate) => candidate.label === label)!
      // Registered after the client was built: no client is told about the field.
      await run(engine.register(exportTable))
      await run(engine.register({ name: "table/exports", title: "Exports", collection: "exports" }))

      const exported = await client.call("table/export", payload)
      expect(exported, label).toMatchObject({
        ok: true,
        value: { runId: "run-1", output: payload, cause: { nodeId: "table/export", journalSeq: 1 } }
      })
      const rows = await client.call("table/exports", { key: "plan" })
      expect(rows, label).toMatchObject({ ok: true, value: { rows: [payload], cursor: "1" } })
      // A value outside the enum is the core's refusal on every wire, never a usage error.
      expect(await client.call("table/export", { format: "xml", table: "plan" }), label).toMatchObject({
        ok: false,
        code: label === "GUI" ? "invalid_fields" : "invalid_payload"
      })
      observed.push({
        label,
        transcript: CauseReceipt.canonical({ exported: unwrap(exported), rows: unwrap(rows) }),
        snapshot: engine.snapshot()
      })
    }
    const [mcp, ...rest] = observed
    for (const other of rest) {
      expect(other.snapshot, other.label).toBe(mcp!.snapshot)
      expect(other.transcript, other.label).toBe(mcp!.transcript)
    }
    expect(JSON.parse(mcp!.snapshot).collections.exports).toEqual({ plan: payload })
  })

  it("a different history gives different bytes", async () => {
    const [a, b] = await Promise.all([world(), world()])
    const one = (await clients(a.engine)).sdk.client
    const two = (await clients(b.engine)).sdk.client
    await trace(one)
    await trace(two)
    expect(a.engine.snapshot()).toBe(b.engine.snapshot())
    unwrap(await two.call("pane/maximize", { paneId: "other" }))
    expect(a.engine.snapshot()).not.toBe(b.engine.snapshot())
  })
})
