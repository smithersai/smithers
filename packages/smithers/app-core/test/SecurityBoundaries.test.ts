import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as fc from "fast-check"
import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CauseReceipt, Core, Principal, SdkAdapter } from "../src/index.ts"
import { clients, evidence, guiClient, mcpClient, run, world } from "./support/fixture.ts"

const refusal = <A, E>(effect: Effect.Effect<A, E>) => run(Effect.flip(effect))
const delegated = [evidence.mcp, evidence.incur, evidence.sdk, evidence.frame] as const
const personDoors = ["strip", "key", "slash", "palette"] as const
const merge = { operation: "pr/merge", payload: { number: 12 } }

describe("principals", () => {
  it("every delegated door mints a delegate, and only the four host doors mint the person", async () => {
    const { credentials } = await world()
    const acts = await Promise.all(delegated.map(async (from) => {
      const facts = credentials.authority(await run(credentials.mint(from)))
      return [facts?.door, facts?.act, facts?.subject]
    }))
    expect(acts).toEqual([
      ["mcp", "agent", "will"],
      ["incur", "agent", "will"],
      ["sdk", "flow", "will"],
      ["gui.frame", "app", "will"]
    ])
    for (const door of personDoors) {
      const facts = credentials.authority(await run(credentials.mint({ kind: "gui", door, session: "sess-will" })))
      expect([facts?.door, facts?.act]).toEqual([`gui.${door}`, undefined])
    }
  })

  it("an object Credentials did not mint has no authority, however it is shaped", async () => {
    const { credentials, engine } = await world()
    const real = await run(credentials.mint(evidence.strip))
    const forgeries = [
      {},
      { subject: "will", act: undefined, capabilities: ["pr:merge"] },
      { ...real },
      Object.create(real as object),
      new Proxy(real as object, {}),
      null,
      "will"
    ] as unknown as ReadonlyArray<Principal.Principal>
    for (const forged of forgeries) {
      expect(credentials.authority(forged)).toBeUndefined()
      const core = engine.bind(forged)
      const refused = [
        await refusal(core.catalog()),
        await refusal(core.submit({ operation: "plan/upsert-node", payload: { page: "p", blockId: "b", title: "t" } })),
        await refusal(core.read({ query: "plan/nodes" })),
        await refusal(Stream.runCollect(core.changes({ query: "plan/nodes" }, "0")))
      ]
      expect(refused.map((error) => error.reason)).toEqual(Array(4).fill("unauthorized"))
      expect(await refusal(credentials.receipt(forged, { operation: "pr/merge", target: "x" }))).toMatchObject({
        reason: "not_a_person"
      })
    }
    expect(JSON.parse(engine.snapshot()).head).toBe(0)
  })

  it("a credential is good only for the door kind it was granted for", async () => {
    const { engine } = await world()
    const wrong: ReadonlyArray<Principal.DoorEvidence> = [
      { kind: "gui", door: "strip", session: "tok-agent" },
      { kind: "gui", door: "palette", session: "run-credential" },
      { kind: "gui", door: "key", session: "/home/will/.smithers/session" },
      { kind: "mcp", transport: "http", tokenRef: "sess-will" },
      { kind: "incur", sessionFile: "tok-agent" },
      { kind: "gui", door: "slash", session: "__proto__" },
      { kind: "mcp", transport: "stdio", tokenRef: "constructor" }
    ]
    for (const from of wrong) {
      expect(await refusal(engine.open(from)), JSON.stringify(from)).toMatchObject({
        _tag: "@smthrs/app-core/AuthRefused",
        reason: "unknown_credential"
      })
    }
  })

  it("no delegate, payload or receipt text runs a person-only or protected flow", async () => {
    const { engine } = await world()
    const cores = await Promise.all(delegated.map((from) => run(engine.open(from))))
    const before = engine.snapshot()
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...cores),
        fc.constantFrom("run/answer", "pr/merge"),
        fc.oneof(fc.jsonValue(), fc.constant({ runId: "run-7", value: "yes" }), fc.constant({ number: 12 })),
        fc.option(fc.string(), { nil: undefined }),
        async (core, operation, payload, receipt) => {
          const refused = await refusal(
            core.submit({ operation, payload, ...(receipt === undefined ? {} : { receipt }) })
          )
          expect(refused.reason).toBe("person_only")
          expect(engine.snapshot()).toBe(before)
        }
      ),
      { numRuns: 200 }
    )
  })

  it("each of the person's four doors runs a person-only flow", async () => {
    const { engine } = await world()
    const { gui } = await guiClient(engine)
    for (const [at, door] of personDoors.entries()) {
      const requested = await run(gui.hostStrip.press("run/answer", { runId: `run-${at}`, value: door }, { door }))
      expect(requested.output).toEqual({ runId: `run-${at}`, value: door })
    }
    expect((await run(gui.queries.read("run/answers"))).rows).toHaveLength(4)
  })
})

describe("protected acts", () => {
  const timed = async () => {
    const clock = { now: 1_000 }
    const { credentials, engine } = await world({ now: () => clock.now })
    const person = await run(engine.open(evidence.strip))
    return { clock, credentials, engine, person }
  }

  it("needs the person's confirmation: a press alone is refused, a confirmed press merges", async () => {
    const { engine } = await timed()
    const { gui } = await guiClient(engine)
    expect(await refusal(gui.hostStrip.press("pr/merge", { number: 12 }))).toMatchObject({
      reason: "receipt_required",
      target: "pr/merge"
    })
    expect(JSON.parse(engine.snapshot()).head).toBe(0)
    const merged = await run(gui.hostStrip.press("pr/merge", { number: 12 }, { confirmed: true }))
    expect(merged).toMatchObject({ output: { number: 12 }, cause: { nodeId: "pr/merge", journalSeq: 1 } })
  })

  it("a receipt is spent once", async () => {
    const { engine, person } = await timed()
    const receipt = await run(engine.confirm(evidence.strip, merge))
    expect(receipt).toMatch(/^[0-9a-f]{32}$/)
    expect((await run(person.submit({ ...merge, receipt }))).runId).toBe("run-1")
    expect(await refusal(person.submit({ ...merge, receipt }))).toMatchObject({
      reason: "receipt_required",
      code: "receipt_invalid"
    })
    expect(JSON.parse(engine.snapshot()).head).toBe(1)
  })

  it("a receipt lives 60 seconds", async () => {
    const { clock, engine, person } = await timed()
    const late = await run(engine.confirm(evidence.strip, merge))
    clock.now += Principal.receiptLifetime
    expect(await refusal(person.submit({ ...merge, receipt: late }))).toMatchObject({
      reason: "receipt_required",
      code: "receipt_expired"
    })
    const inTime = await run(engine.confirm(evidence.strip, merge))
    clock.now += Principal.receiptLifetime - 1
    expect((await run(person.submit({ ...merge, receipt: inTime }))).runId).toBe("run-1")
  })

  it("a receipt confirms one payload, one flow and one session", async () => {
    const { engine, person } = await timed()
    const other = await run(engine.confirm(evidence.strip, merge))
    expect(await refusal(person.submit({ operation: "pr/merge", payload: { number: 13 }, receipt: other })))
      .toMatchObject({ reason: "receipt_required", code: "receipt_invalid" })
    // The mismatch spent it: the right payload no longer redeems it either.
    expect(await refusal(person.submit({ ...merge, receipt: other }))).toMatchObject({ code: "receipt_invalid" })

    const ada = await run(engine.open({ kind: "gui", door: "strip", session: "sess-ada" }))
    const wills = await run(engine.confirm(evidence.strip, merge))
    expect(await refusal(ada.submit({ ...merge, receipt: wills }))).toMatchObject({ code: "receipt_invalid" })
    expect(await refusal(person.submit({ ...merge, receipt: "0".repeat(32) }))).toMatchObject({
      code: "receipt_invalid"
    })
    expect(JSON.parse(engine.snapshot()).head).toBe(0)
  })

  it("no delegate is issued a receipt", async () => {
    const { credentials, engine } = await timed()
    for (const from of delegated) {
      expect(
        await refusal(credentials.receipt(await run(credentials.mint(from)), { operation: "pr/merge", target: "x" }))
      )
        .toMatchObject({ reason: "not_a_person" })
      // The type forbids it; a cast that gets past the type finds no person door to open.
      expect(await refusal(engine.confirm(from as unknown as Principal.PersonEvidence, merge))).toMatchObject({
        _tag: "@smthrs/app-core/AuthRefused",
        reason: "unknown_door"
      })
    }
  })
})

describe("capabilities", () => {
  it("a token's ceiling narrows what its agent may run", async () => {
    const { engine } = await world()
    const { client } = await mcpClient(engine, { kind: "mcp", transport: "http", tokenRef: "tok-narrow" })
    expect(await client.call("plan/upsert-node", { page: "p", blockId: "b", title: "t" })).toMatchObject({ ok: true })
    expect(await client.call("pane/maximize", { paneId: "x" })).toMatchObject({
      ok: false,
      code: "capability_exceeded"
    })
    expect(await client.call("pr/merges", {})).toMatchObject({ ok: false, code: "capability_exceeded" })
  })

  it("a frame holds the viewer's capabilities inside its plugin's ceiling, and an unknown plugin holds none", async () => {
    const { engine } = await world()
    const { gui: narrow } = await guiClient(engine, { plugin: "narrow" })
    expect((await run(narrow.actions.dispatch("plan/upsert-node", { page: "p", blockId: "b", title: "t" }))).runId)
      .toBe("run-1")
    expect(await refusal(narrow.actions.dispatch("pane/maximize", { paneId: "x" }))).toMatchObject({
      _tag: "plugin/PluginRefused",
      plugin: "narrow",
      reason: "outside_ceiling"
    })
    const { gui: unknown } = await guiClient(engine, { plugin: "nobody" })
    expect(await refusal(unknown.actions.dispatch("plan/upsert-node", { page: "p", blockId: "b", title: "t" })))
      .toMatchObject({ reason: "outside_ceiling" })
    expect(await refusal(narrow.queries.read("pr/merges"))).toMatchObject({ reason: "outside_ceiling" })
    expect(await refusal(narrow.queries.read("no/such"))).toMatchObject({ reason: "undeclared_query" })
    expect(await refusal(narrow.actions.dispatch("no/such"))).toMatchObject({ reason: "undeclared_event" })
    expect(await refusal(narrow.actions.dispatch("plan/upsert-node", { page: "p" }))).toMatchObject({
      reason: "invalid_fields"
    })
  })
})

describe("ref/cause", () => {
  it("answers provenance_missing for a reference no receipt was stamped for", async () => {
    const { engine } = await world()
    for (const client of (await clients(engine)).all) {
      expect(await client.call("ref/cause", { ref: "out/run-99" }), client.label).toMatchObject({
        ok: false,
        code: "provenance_missing"
      })
      expect(await client.call("ref/cause", {}), client.label).toMatchObject({
        ok: false,
        code: client.label === "GUI" ? "invalid_fields" : "invalid_payload"
      })
    }
  })

  it("answers unauthorized for another person's private output, and leaks none of it", async () => {
    const { engine } = await world()
    const will = await run(engine.open(evidence.strip))
    const ada = await run(engine.open({ kind: "gui", door: "strip", session: "sess-ada" }))
    const note = await run(will.submit({ operation: "notes/write", payload: { title: "Acquire Initech in March" } }))

    const refused = await refusal(ada.read({ query: "ref/cause", params: { ref: note.outputRef } }))
    expect(refused).toMatchObject({ reason: "unauthorized", target: note.outputRef })
    const leaked = JSON.stringify(refused)
    for (const secret of ["Initech", "notes/write", note.cause.promptHash, "will", "direct", "attempt"]) {
      expect(leaked, secret).not.toContain(secret)
    }
    expect(await refusal(Stream.runCollect(ada.changes({ query: "ref/cause", params: { ref: note.outputRef } }, "0"))))
      .toMatchObject({ reason: "unauthorized" })

    // The owner reads it through any of their own doors.
    for (const from of [evidence.strip, evidence.mcp, evidence.sdk]) {
      const own = await run(engine.open(from))
      expect((await run(own.read({ query: "ref/cause", params: { ref: note.outputRef } }))).rows).toEqual([note.cause])
    }
  })

  it("a receipt is immutable", async () => {
    const { engine } = await world()
    const will = await run(engine.open(evidence.strip))
    const { cause } = await run(will.submit({ operation: "notes/write", payload: { title: "t" } }))
    expect(Object.isFrozen(cause) && Object.isFrozen(cause.planRef)).toBe(true)
    expect(() => {
      ;(cause as { runId: string }).runId = "run-forged"
    }).toThrow(TypeError)
    const ledger = CauseReceipt.ledger()
    ledger.record(cause)
    ledger.record({ ...cause, runId: "run-forged" })
    expect(ledger.lookup(cause.outputRef, "anyone")).toEqual({ _tag: "Found", receipt: cause })
  })
})

describe("payloads", () => {
  const node = { page: "p", blockId: "b", title: "t" }

  it("copies a payload as inert JSON: an accessor never runs", async () => {
    const { engine } = await world()
    const core = await run(engine.open(evidence.mcp))
    let read = false
    const hostile = Object.defineProperty({ ...node }, "title", {
      enumerable: true,
      get: () => {
        read = true
        return "t"
      }
    })
    expect(await refusal(core.submit({ operation: "plan/upsert-node", payload: hostile }))).toMatchObject({
      reason: "invalid_payload"
    })
    expect(read).toBe(false)
    for (const payload of [null, [], "text", 7, { ...node, extra: 1 }, { ...node, title: "" }, { ...node, title: 7 }]) {
      expect(await refusal(core.submit({ operation: "plan/upsert-node", payload })), JSON.stringify(payload))
        .toMatchObject({ reason: "invalid_payload" })
    }
    expect(JSON.parse(engine.snapshot()).head).toBe(0)
  })

  it("names the required fields a payload leaves out", async () => {
    const { engine } = await world()
    const { mcp, cli } = await clients(engine)
    const viaMcp = await mcp.rpc("tools/call", { name: "plan__upsert-node", arguments: { page: "p" } })
    expect(viaMcp.result).toMatchObject({
      isError: true,
      structuredContent: { code: "invalid_payload", missingFields: ["blockId", "title"] }
    })
    const viaCli = await run(cli.cli.run(["plan/upsert-node", "--page", "p"]))
    expect([viaCli.exitCode, JSON.parse(viaCli.stderr).missingFields]).toEqual([1, ["blockId", "title"]])
  })

  it("a flow that fails or throws commits nothing", async () => {
    const { engine } = await world()
    await run(engine.register({
      tag: "broken/write",
      title: "Write, then throw",
      payload: { type: "object" },
      run: (_payload, tx) => {
        tx.put("plan", "p#b", { rev: "r9" })
        throw new Error("secret detail")
      }
    }))
    await run(engine.register({
      tag: "broken/output",
      title: "Return what is not JSON",
      payload: { type: "object" },
      run: () => (() => 1) as unknown as Core.Json
    }))
    const core = await run(engine.open(evidence.sdk))
    const before = engine.snapshot()
    expect(await refusal(core.submit({ operation: "workflow/start", payload: { page: "p", blockId: "b" } })))
      .toMatchObject({ reason: "operation_failed", code: "missing_plan_node" })
    const thrown = await refusal(core.submit({ operation: "broken/write" }))
    expect(thrown).toMatchObject({ reason: "operation_failed", code: "defect" })
    expect(JSON.stringify(thrown)).not.toContain("secret detail")
    expect(await refusal(core.submit({ operation: "broken/output" }))).toMatchObject({ code: "invalid_output" })
    expect(await refusal(core.submit({ operation: "no/such" }))).toMatchObject({ reason: "not_found" })
    expect(await refusal(core.submit({ operation: "plan/nodes" }))).toMatchObject({ reason: "not_found" })
    expect(await refusal(core.read({ query: "plan/upsert-node" }))).toMatchObject({ reason: "not_found" })
    expect(engine.snapshot()).toBe(before)
  })
})

describe("catalog", () => {
  it("refuses a tag outside the grammar, a duplicate, and a flow whose payload is not an object", async () => {
    const { engine } = await world()
    const flow = (tag: string): Core.Flow => ({ tag, title: "T", payload: { type: "object" }, run: () => null })
    for (
      const tag of [
        "",
        "Upper/case",
        "a b",
        "a/b/c/d/e",
        "../x",
        `a/${"b".repeat(256)}`,
        "plan/upsert-node",
        "ref/cause"
      ]
    ) {
      expect(await refusal(engine.register(flow(tag))), tag).toMatchObject({ reason: "invalid_registration" })
    }
    expect(await refusal(engine.register({ name: "plan/nodes", title: "Again", collection: "plan" }))).toMatchObject({
      reason: "invalid_registration"
    })
    expect(await refusal(engine.register({ ...flow("ok/flow"), payload: { type: "string" } }))).toMatchObject({
      reason: "invalid_registration"
    })
    const credentials = Principal.make({ verify: Principal.sessions({}) })
    expect(await refusal(Core.make({ credentials, flows: [flow("a/b"), flow("a/b")] }))).toMatchObject({
      reason: "invalid_registration"
    })
  })

  it("pages, and refuses a cursor it did not give", async () => {
    const { engine } = await world()
    for (let at = 0; at < 70; at++) {
      await run(engine.register({ tag: `bulk/f${at}`, title: "T", payload: { type: "object" }, run: () => null }))
    }
    const core = await run(engine.open(evidence.sdk))
    const first = await run(core.catalog())
    expect([first.entries.length, first.next]).toEqual([Core.catalogPageSize, "64"])
    const second = await run(core.catalog(first.next))
    expect([second.entries.length, second.next]).toEqual([82 - 64, undefined])
    expect(await run(Core.entries(core))).toHaveLength(82)
    for (const cursor of ["-1", "x", "1e3", "83", "9999999999"]) {
      expect(await refusal(core.catalog(cursor)), cursor).toMatchObject({ reason: "invalid_cursor" })
    }
  })
})

describe("MCP wire", () => {
  it("answers initialize and ping, and nothing to a notification", async () => {
    const { engine } = await world()
    const { rpc, server } = await mcpClient(engine)
    expect((await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} })).result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "smithers", version: "1.0.0" }
    })
    expect((await rpc("ping")).result).toEqual({})
    expect(await run(server.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))))
      .toBeUndefined()
  })

  it("refuses malformed requests, unknown methods and unknown tools with JSON-RPC errors", async () => {
    const { engine } = await world()
    const { rpc, server } = await mcpClient(engine)
    const code = async (wire: string) => JSON.parse((await run(server.handle(wire))) as string).error.code
    expect(await code("{")).toBe(-32700)
    expect(await code("[]")).toBe(-32600)
    expect(await code(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }))).toBe(-32600)
    expect(await code(JSON.stringify({ jsonrpc: "2.0", id: 1.5, method: "ping" }))).toBe(-32600)
    expect(await code(JSON.stringify({ jsonrpc: "2.0", id: {}, method: "ping" }))).toBe(-32600)
    expect((await rpc("resources/list")).error.code).toBe(-32601)
    for (
      const params of [undefined, {}, { name: 7 }, { name: "no__such" }, { name: "constructor" }, {
        name: "plan/nodes"
      }]
    ) {
      expect((await rpc("tools/call", params)).error.code, JSON.stringify(params)).toBe(-32602)
    }
  })

  it("lists each tool with its schema, and leaves out both of two tags that share a name", async () => {
    const { engine } = await world()
    const { rpc } = await mcpClient(engine)
    const flow = (tag: string): Core.Flow => ({ tag, title: tag, payload: { type: "object" }, run: () => tag })
    await run(engine.register(flow("a/b__c")))
    expect((await rpc("tools/call", { name: "a__b__c" })).result.structuredContent.output).toBe("a/b__c")
    await run(engine.register(flow("a__b/c")))

    const { tools } = (await rpc("tools/list")).result
    const names = tools.map((tool: { name: string }) => tool.name)
    expect(names).toEqual([
      "ref__cause",
      "plan__upsert-node",
      "workflow__start",
      "pane__maximize",
      "notes__write",
      "plan__nodes",
      "workflow__runs",
      "pane__state",
      "run__answers",
      "pr__merges"
    ])
    expect(new Set(names).size).toBe(names.length)
    expect(tools[1]).toEqual({
      name: "plan__upsert-node",
      title: "Write a plan block",
      description: "Write a plan block",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "string", minLength: 1 },
          blockId: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 }
        },
        required: ["page", "blockId", "title"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false }
    })
    expect(tools[0].annotations).toEqual({ readOnlyHint: true })
    const before = engine.snapshot()
    expect((await rpc("tools/call", { name: "a__b__c" })).result).toMatchObject({
      isError: true,
      structuredContent: { code: "ambiguous_tool" }
    })
    expect(engine.snapshot()).toBe(before)
  })
})

describe("CLI", () => {
  it("describes every command from the catalog, and a descriptor runs it", async () => {
    const { engine } = await world()
    const { cli } = (await clients(engine)).cli
    const commands = await run(cli.commands)
    const upsert = commands.find((command) => command.name === "plan/upsert-node")!
    expect(upsert.flags).toEqual([
      { flag: "--page", field: "page", type: "string", required: true },
      { flag: "--block-id", field: "blockId", type: "string", required: true },
      { flag: "--title", field: "title", type: "string", required: true }
    ])
    expect(upsert.options).toMatchObject({ type: "object", required: ["page", "blockId", "title"] })
    expect(await run(upsert.run({ page: "p", blockId: "b", title: "t" }))).toMatchObject({ runId: "run-1" })
    expect(commands.find((command) => command.name === "ref/cause")?.readOnly).toBe(true)
  })

  it("prints one line of canonical JSON, or Markdown", async () => {
    const { engine } = await world()
    const { cli } = (await clients(engine)).cli
    const json = await run(cli.run(["plan/upsert-node", "--title", "t", "--page", "p", "--block-id", "b"]))
    expect(json.stdout).toBe(`${CauseReceipt.canonical(JSON.parse(json.stdout))}\n`)
    const markdown = await run(cli.run(["plan/nodes", "--format", "md"]))
    expect([markdown.exitCode, markdown.stderr]).toEqual([0, ""])
    const block = /^# plan\/nodes\n\n```json\n([\s\S]+)\n```\n$/.exec(markdown.stdout)
    expect(JSON.parse(block![1]!)).toEqual({ cursor: "1", rows: [{ blockId: "b", page: "p", rev: "r1", title: "t" }] })
  })

  it("exits 2 on bad usage and writes nothing", async () => {
    const { engine } = await world()
    await run(engine.register({
      tag: "typed/flow",
      title: "Typed",
      payload: {
        type: "object",
        properties: {
          count: { type: "integer" },
          ratio: { type: "number" },
          on: { type: "boolean" },
          list: { type: "array" }
        }
      },
      run: (payload) => payload
    }))
    const { cli } = (await clients(engine)).cli
    const ok = await run(cli.run(["typed/flow", "--count", "3", "--ratio", "0.5", "--on", "false", "--list", "[1]"]))
    expect(JSON.parse(ok.stdout).output).toEqual({ count: 3, ratio: 0.5, on: false, list: [1] })
    const before = engine.snapshot()
    for (
      const argv of [
        [],
        ["--format", "json"],
        ["plan/upsert-node", "--page"],
        ["plan/upsert-node", "--nope", "x"],
        ["plan/upsert-node", "--page", "a", "--page", "b"],
        ["plan/nodes", "--format", "yaml"],
        ["typed/flow", "--count", "three"],
        ["typed/flow", "--count", ""],
        ["typed/flow", "--on", "yes"],
        ["typed/flow", "--list", "[1"]
      ]
    ) {
      const exit = await run(cli.run(argv))
      expect([exit.exitCode, exit.stdout, JSON.parse(exit.stderr).code], argv.join(" ")).toEqual([2, "", "usage"])
    }
    const unknown = await run(cli.run(["no/such"]))
    expect([unknown.exitCode, JSON.parse(unknown.stderr).code]).toEqual([1, "not_found"])
    expect(engine.snapshot()).toBe(before)
  })

  it("generates the skill from the catalog", async () => {
    const { engine } = await world()
    const { cli } = (await clients(engine)).cli
    const skill = await run(cli.skill)
    expect(skill.startsWith("---\nname: smithers\n")).toBe(true)
    expect(skill).toContain(
      "### `smithers plan/upsert-node`\n\nWrite a plan block. Write a plan block\n\n- `--page <string>` (required)"
    )
    expect(skill).toContain("### `smithers ref/cause`")
    expect(skill).not.toContain("### `smithers run/answer`")
    expect(skill).toContain("## Person-only")
    expect(skill).toContain("- `run/answer`: Only the person answers a run's question.")
    expect(skill).toContain("- `pr/merge`: A protected act needs the person's confirmation.")
    await run(engine.register({ tag: "late/flow", title: "Late", payload: { type: "object" }, run: () => null }))
    expect(await run(cli.skill)).toContain("### `smithers late/flow`")
  })
})

describe("SDK and live queries", () => {
  it("is an Effect service, and the core is one too", async () => {
    const { engine } = await world()
    const viaSdk = Effect.gen(function*() {
      const sdk = yield* SdkAdapter.SmithersSdk
      yield* sdk.call("plan/upsert-node", { page: "p", blockId: "b", title: "t" })
      return (yield* sdk.read("plan/nodes")).rows.length
    }).pipe(Effect.provide(SdkAdapter.layer({ engine, evidence: evidence.sdk })))
    expect(await run(viaSdk)).toBe(1)
    const viaCore = Effect.gen(function*() {
      const core = yield* Core.SmithersCore
      return (yield* core.catalog()).entries.length
    }).pipe(Effect.provide(Core.layer(engine, evidence.mcp)))
    expect(await run(viaCore)).toBe(12)
  })

  it("follows a query's changes from a cursor", async () => {
    const { engine } = await world()
    const { promises } = (await clients(engine)).sdk
    await promises.call("plan/upsert-node", { page: "p", blockId: "b", title: "one" })
    const changes = promises.changes("plan/nodes", "0")[Symbol.asyncIterator]()
    const caughtUp = await changes.next()
    expect(caughtUp.value).toMatchObject({ cursor: "1", rows: [{ title: "one" }] })
    const next = changes.next()
    await promises.call("pane/maximize", { paneId: "elsewhere" })
    await promises.call("plan/upsert-node", { page: "p", blockId: "b", title: "two" })
    // The pane commit did not change these rows, so the next change is the second write.
    expect((await next).value).toMatchObject({ cursor: "3", rows: [{ title: "two", rev: "r2" }] })
    await changes.return?.()
    await expect(promises.read("plan/nodes", { key: "p#b" })).resolves.toMatchObject({ rows: [{ rev: "r2" }] })
    await expect(promises.read("plan/nodes", { key: "none" })).resolves.toMatchObject({ rows: [] })
    await expect(promises.changes("plan/nodes", "soon")[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      reason: "invalid_cursor"
    })
  })

  it("a live query calls back after a commit and stops when unsubscribed", async () => {
    const { engine } = await world()
    const { gui } = await guiClient(engine)
    const live = await run(gui.queries.live("plan/nodes"))
    expect(live.current()).toEqual([])
    let calls = 0
    let woke = () => {}
    const unsubscribe = live.subscribe(() => {
      calls += 1
      woke()
    })
    const changed = new Promise<void>((resolve) => {
      woke = resolve
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await run(gui.actions.dispatch("plan/upsert-node", { page: "p", blockId: "b", title: "t" }))
    await changed
    expect(live.current()).toEqual([{ page: "p", blockId: "b", title: "t", rev: "r1" }])
    unsubscribe()
    await run(gui.actions.dispatch("plan/upsert-node", { page: "p", blockId: "b", title: "u" }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(1)
  })
})

describe("portability", () => {
  it("the sources import nothing from Node and use none of its globals", () => {
    const directory = new URL("../src/", import.meta.url)
    const files = readdirSync(directory).filter((name) => name.endsWith(".ts"))
    expect(files.sort()).toEqual([
      "CauseReceipt.ts",
      "CliAdapter.ts",
      "Core.ts",
      "GuiAdapter.ts",
      "McpAdapter.ts",
      "Principal.ts",
      "SdkAdapter.ts",
      "index.ts"
    ])
    for (const name of files) {
      const source = readFileSync(new URL(name, directory), "utf8")
      const imports = Array.from(source.matchAll(/from "([^"]+)"/g), (match) => match[1]!)
      for (const specifier of imports) {
        expect(
          /^(effect\/[A-Za-z]+|@smthrs\/(canonical|plugin\/(Host|JsonSchema))|\.\/[A-Za-z]+\.ts)$/.test(specifier),
          `${name}: ${specifier}`
        )
          .toBe(true)
      }
      expect(/\b(process|Buffer|require|__dirname|global)\b[.(\[]/.test(source), name).toBe(false)
    }
  })
})
