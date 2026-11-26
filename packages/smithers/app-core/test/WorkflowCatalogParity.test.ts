import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CauseReceipt, type Core, McpAdapter } from "../src/index.ts"
import { type Client, clients, run, world } from "./support/fixture.ts"

// The repository's own gate, `.smithers/workflows/gate.vibe`, as a catalog entry. apps/mvp discovers and plans the
// file (worker/ci/WorkflowDiscovery.ts, worker/ci/Realm.ts); this package may not import apps/mvp, so the entry is
// read from the committed text: its tag, description, payload fields and shard count. A change to any of them in
// gate.vibe changes what all four clients must agree on here.
const source = readFileSync(new URL("../../../../.smithers/workflows/gate.vibe", import.meta.url), "utf8")

const read = (pattern: RegExp, what: string): string => {
  const found = pattern.exec(source)?.[1]
  if (found === undefined) throw new Error(`gate.vibe no longer declares its ${what}`)
  return found
}

const tag = read(/Flow\.make\("([^"]+)"/, "tag")
const description = read(/description: "([^"]+)"/, "description")
const fields = [...read(/payload: \{([^}]+)\}/, "payload").matchAll(/(\w+): Schema\.String/g)].map((match) => match[1]!)
const shards = Number(read(/const SHARDS = (\d+)/, "shard count"))
const jobs = [...Array.from({ length: shards }, (_, index) => `mvp-${index + 1}`), "mvp-coverage"]

const gate: Core.Flow = {
  tag,
  title: "Gate",
  description,
  payload: {
    type: "object",
    properties: Object.fromEntries(fields.map((field) => [field, { type: "string", minLength: 1 }])),
    required: fields,
    additionalProperties: false
  },
  capabilities: ["workflow:run"],
  run: (payload, tx) => {
    const planned = { ...payload, jobs }
    tx.put("gate-runs", String(payload["run"]), planned)
    return planned
  }
}

const gateRuns: Core.Projection = { name: "gate/runs", title: "Gate runs", collection: "gate-runs" }

const payload = {
  run: "gate:delivery-1",
  repo: "smithersai/smithers",
  sha: "a".repeat(40),
  ref: "refs/heads/main",
  event: "push"
}

/** The gate's catalog entry as one client publishes it, reduced to what every wire carries. */
type Published = { readonly tag: string; readonly description: string; readonly payload: unknown }

const published = async (label: Client["label"], engine: Core.Engine): Promise<Published> => {
  const all = await clients(engine)
  if (label === "MCP") {
    const tools: ReadonlyArray<McpAdapter.Tool> = (await all.mcp.rpc("tools/list")).result.tools
    const tool = tools.find((each) => each.name === McpAdapter.toolName(tag))!
    return { tag: tool.name, description: tool.description, payload: tool.inputSchema }
  }
  if (label === "CLI") {
    const command = (await run(all.cli.cli.commands)).find((each) => each.name === tag)!
    return { tag: command.name, description: command.description, payload: command.options }
  }
  const entries = label === "SDK" ? await all.sdk.promises.catalog() : await run(all.gui.gui.actions.list)
  const entry = entries.find((each) => each.tag === tag)!
  return { tag: entry.tag, description: entry.description, payload: entry.payload }
}

const labels = ["MCP", "CLI", "SDK", "GUI"] as const

const unwrap = (outcome: Awaited<ReturnType<Client["call"]>>) => {
  if (!outcome.ok) throw new Error(`refused ${outcome.code}`)
  return outcome.value
}

/** A fresh engine with the slice-1 catalog and the gate registered after it, as a discovered workflow is. */
const gateWorld = async () => {
  const { engine } = await world()
  await run(engine.register(gate))
  await run(engine.register(gateRuns))
  return engine
}

describe("the repository's gate workflow in four clients", () => {
  it("is read from gate.vibe: the gate tag, its description, the run's five fields and 16 shards", () => {
    expect(tag).toBe("gate")
    expect(description).toBe("Run the apps/mvp test shards and enforce their combined coverage.")
    expect(fields).toEqual(["run", "repo", "sha", "ref", "event"])
    expect(jobs).toHaveLength(17)
    expect(jobs.at(-1)).toBe("mvp-coverage")
  })

  it("MCP, CLI, SDK and GUI publish the same gate entry", async () => {
    const engine = await gateWorld()
    const seen = await Promise.all(labels.map((label) => published(label, engine)))
    for (const [index, entry] of seen.entries()) {
      expect(entry, labels[index]).toEqual({ tag: "gate", description, payload: gate.payload })
    }
    for (const client of (await clients(engine)).all) expect(await client.offered(), client.label).toContain("gate")
  })

  it("one gate run through each client gives byte-identical receipts, rows and snapshots", async () => {
    const observed: Array<{ label: string; transcript: string; snapshot: string; hash: string }> = []
    for (const label of labels) {
      // One engine per client: nothing is shared but the catalog.
      const engine = await gateWorld()
      const client = (await clients(engine)).all.find((candidate) => candidate.label === label)!
      const before = engine.snapshot()

      // A run missing a field is the core's refusal on every wire, and writes nothing.
      const { sha: _sha, ...missing } = payload
      expect(await client.call(tag, missing), label).toMatchObject({
        ok: false,
        code: label === "GUI" ? "invalid_fields" : "invalid_payload"
      })
      expect(engine.snapshot(), label).toBe(before)

      const started = await client.call(tag, payload)
      expect(started, label).toMatchObject({
        ok: true,
        value: {
          runId: "run-1",
          outputRef: "out/run-1",
          output: { ...payload, jobs },
          cause: { outputRef: "out/run-1", runId: "run-1", nodeId: "gate", attempt: 1, journalSeq: 1 }
        }
      })
      const receipt = unwrap(started)
      const cause = unwrap(await client.call("ref/cause", { ref: receipt.outputRef }))
      // What ref/cause reads back is the receipt the run returned.
      expect(cause.rows, label).toEqual([receipt.cause])
      const rows = unwrap(await client.call("gate/runs", { key: payload.run }))
      expect(rows.rows, label).toEqual([{ ...payload, jobs }])

      const snapshot = engine.snapshot()
      observed.push({
        label,
        transcript: CauseReceipt.canonical({ receipt, cause, rows }),
        snapshot,
        hash: await run(CauseReceipt.sha256(snapshot))
      })
    }

    expect(observed.map((each) => each.label)).toEqual([...labels])
    const [mcp, ...rest] = observed
    for (const other of rest) {
      expect(other.snapshot, other.label).toBe(mcp!.snapshot)
      expect(other.hash, other.label).toBe(mcp!.hash)
      expect(other.transcript, other.label).toBe(mcp!.transcript)
    }
    const state = JSON.parse(mcp!.snapshot)
    expect(state.head).toBe(1)
    expect(state.causes.map((receipt: CauseReceipt.CauseReceipt) => receipt.nodeId)).toEqual(["gate"])
    expect(state.collections["gate-runs"]).toEqual({ [payload.run]: { ...payload, jobs } })
  })
})
