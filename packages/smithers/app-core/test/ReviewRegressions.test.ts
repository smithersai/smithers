/**
 * One regression per finding of the W2-D landing review of `e26740bfa230`
 * (five High, one Medium). The Medium finding's four-client case is in
 * `FourClientParity.test.ts`; its CLI detail is at the end of this file.
 */

import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { describe, expect, it } from "vitest"
import { CliAdapter, Core, GuiAdapter, Principal } from "../src/index.ts"
import { clients, evidence, guiClient, mcpClient, run, world } from "./support/fixture.ts"

const refusal = <A, E>(effect: Effect.Effect<A, E>) => run(Effect.flip(effect))
// The two ways evidence becomes a principal: the engine's opener, and the issuer itself.
const both = (engine: Core.Engine, credentials: Principal.Credentials) => [
  (from: Principal.DoorEvidence) => Effect.asVoid(engine.open(from)),
  (from: Principal.DoorEvidence) => Effect.asVoid(credentials.mint(from))
]
const node = { page: "p", blockId: "b", title: "t" }
const merge = { operation: "pr/merge", payload: { number: 12 } }
const answer = { runId: "run-7", value: "yes" }

describe("High 1: a principal belongs to the credential issuer that minted it", () => {
  it("an engine refuses a principal another issuer minted in the same process", async () => {
    const a = await world()
    const b = await world()
    const minted = await run(a.credentials.mint(evidence.strip))

    expect(a.credentials.authority(minted)).toMatchObject({ subject: "will", act: undefined, door: "gui.strip" })
    expect(b.credentials.authority(minted)).toBeUndefined()

    const foreign = b.engine.bind(minted)
    const refused = [
      await refusal(foreign.catalog()),
      await refusal(foreign.submit({ operation: "plan/upsert-node", payload: node })),
      await refusal(foreign.submit({ operation: "run/answer", payload: answer })),
      await refusal(foreign.read({ query: "plan/nodes" })),
      await refusal(Stream.runCollect(foreign.changes({ query: "plan/nodes" }, "0")))
    ]
    expect(refused.map((error) => error.reason)).toEqual(Array(5).fill("unauthorized"))
    expect(JSON.parse(b.engine.snapshot()).head).toBe(0)

    // The same principal still works on the engine of the issuer that minted it.
    expect((await run(a.engine.bind(minted).submit({ operation: "run/answer", payload: answer }))).runId).toBe("run-1")
  })

  it("an issuer neither issues a receipt to, nor redeems one for, another issuer's person", async () => {
    const a = await world()
    const b = await world()
    const personA = await run(a.credentials.mint(evidence.strip))
    const personB = await run(b.credentials.mint(evidence.strip))
    const confirmed = { operation: "pr/merge", target: "x" }

    expect(await refusal(b.credentials.receipt(personA, confirmed))).toMatchObject({ reason: "not_a_person" })

    const token = await run(a.credentials.receipt(personA, confirmed))
    // B's person cannot spend A's receipt at A, and B has no such receipt for anyone.
    expect(await refusal(a.credentials.redeem(token, personB, confirmed))).toMatchObject({ reason: "not_a_person" })
    expect(await refusal(b.credentials.redeem(token, personA, confirmed))).toMatchObject({ reason: "not_a_person" })
    expect(await refusal(b.credentials.redeem(token, personB, confirmed))).toMatchObject({ reason: "receipt_invalid" })
    // The foreign attempts left A's receipt alone: its owner spends the very same token, once.
    await run(a.credentials.redeem(token, personA, confirmed))
    expect(await refusal(a.credentials.redeem(token, personA, confirmed))).toMatchObject({ reason: "receipt_invalid" })

    // Through the engines: a receipt A's person confirmed does not merge on B.
    const receipt = await run(a.engine.confirm(evidence.strip, merge))
    const onB = await run(b.engine.open(evidence.strip))
    expect(await refusal(onB.submit({ ...merge, receipt }))).toMatchObject({
      reason: "receipt_required",
      code: "receipt_invalid"
    })
    expect(await refusal(b.engine.bind(personA).submit({ ...merge, receipt }))).toMatchObject({
      reason: "unauthorized"
    })
    expect(JSON.parse(b.engine.snapshot()).head).toBe(0)
    const onA = await run(a.engine.open(evidence.strip))
    expect((await run(onA.submit({ ...merge, receipt }))).runId).toBe("run-1")
  })
})

describe("High 2: the door class and the plugin come from the verified credential", () => {
  const personDoors = ["strip", "key", "slash", "palette"] as const

  it("a frame credential opens no person door, and a person session opens no frame", async () => {
    const { credentials, engine } = await world()
    for (const door of personDoors) {
      for (const session of ["frame-plan-tree", "frame-narrow", "frame-scoped"]) {
        expect(await refusal(engine.open({ kind: "gui", door, session })), `${door} ${session}`).toMatchObject({
          _tag: "@smthrs/app-core/AuthRefused",
          reason: "door_mismatch"
        })
        expect(await refusal(credentials.mint({ kind: "gui", door, session }))).toMatchObject({
          reason: "door_mismatch"
        })
        expect(await refusal(engine.confirm({ kind: "gui", door, session }, merge))).toMatchObject({
          reason: "door_mismatch"
        })
      }
    }
    expect(await refusal(engine.openPerson({ session: "frame-plan-tree" }))).toMatchObject({ reason: "door_mismatch" })
    for (const open of both(engine, credentials)) {
      expect(await refusal(open({ kind: "gui", door: "frame", session: "sess-will", plugin: "plan-tree" })))
        .toMatchObject({ reason: "door_mismatch" })
    }
    expect(await refusal(engine.openFrame({ session: "sess-will", plugin: "plan-tree" }))).toMatchObject({
      reason: "door_mismatch"
    })
  })

  it("a frame cannot claim another plugin's installation", async () => {
    const { credentials, engine } = await world()
    // The narrow plugin's frame claims the wider plan-tree ceiling.
    expect(await refusal(engine.openFrame({ session: "frame-narrow", plugin: "plan-tree" }))).toMatchObject({
      reason: "door_mismatch"
    })
    expect(await refusal(engine.open({ kind: "gui", door: "frame", session: "frame-plan-tree", plugin: "nobody" })))
      .toMatchObject({ reason: "door_mismatch" })
    const facts = credentials.authority(await run(credentials.mint(evidence.frame)))
    expect(facts).toMatchObject({ act: "app", door: "gui.frame", plugin: "plan-tree" })
  })

  it("rejects a door it does not name", async () => {
    const { credentials, engine } = await world()
    const unknown = [
      { kind: "gui", door: "admin", session: "sess-will" },
      { kind: "gui", door: "Strip", session: "sess-will" },
      { kind: "gui", door: "", session: "sess-will" },
      { kind: "gui", session: "sess-will" },
      { kind: "gui", door: ["strip"], session: "sess-will" },
      { kind: "gui", door: "toString", session: "sess-will" },
      { kind: "gui", door: "frame", session: "frame-plan-tree" },
      { kind: "gui", door: "strip" },
      { kind: "host", session: "sess-will" },
      { session: "sess-will" },
      { kind: "mcp", transport: "pipe", tokenRef: "tok-agent" },
      { kind: "sdk", runCredential: "run-credential" },
      null,
      "gui"
    ] as unknown as ReadonlyArray<Principal.DoorEvidence>
    for (const from of unknown) {
      for (const open of both(engine, credentials)) {
        expect(await refusal(open(from)), JSON.stringify(from)).toMatchObject({
          _tag: "@smthrs/app-core/AuthRefused",
          reason: "unknown_door"
        })
      }
    }
    expect(await refusal(engine.openPerson({ session: "sess-will", door: "frame" as never }))).toMatchObject({
      reason: "unknown_door"
    })
    // The same matrix at confirmation, each carrying the person's valid session:
    // no missing or null door defaults to the strip, and the kind is checked.
    const atConfirm = [
      ...unknown,
      { kind: "gui", door: null, session: "sess-will" },
      { kind: "gui", door: undefined, session: "sess-will" },
      { kind: "host", door: "strip", session: "sess-will" },
      { door: "strip", session: "sess-will" },
      { kind: null, door: "strip", session: "sess-will" },
      { kind: "GUI", door: "strip", session: "sess-will" },
      evidence.frame,
      evidence.mcp,
      evidence.sdk
    ] as unknown as ReadonlyArray<Principal.PersonEvidence>
    for (const from of atConfirm) {
      expect(await refusal(engine.confirm(from, merge)), String(JSON.stringify(from))).toMatchObject({
        _tag: "@smthrs/app-core/AuthRefused",
        reason: "unknown_door"
      })
    }
    // Well-formed person evidence still confirms.
    expect(typeof await run(engine.confirm(evidence.strip, merge))).toBe("string")
    expect(await refusal(engine.openPerson({ session: "sess-will", door: "admin" as never }))).toMatchObject({
      reason: "unknown_door"
    })
  })

  it("extra fields on a frame never select the person: every opener reads only its own fields", async () => {
    const { credentials, engine } = await world()
    // What the old `{ kind: "gui", door: "frame", ...frame }` spread let through.
    const hostile = {
      session: "frame-plan-tree",
      plugin: "plan-tree",
      door: "strip",
      kind: "gui",
      act: undefined,
      subject: "ada",
      capabilities: ["pr:merge"]
    }
    const before = engine.snapshot()

    const gui = await run(GuiAdapter.make({ engine, frame: hostile, person: { session: "frame-plan-tree" } }))
    expect(await refusal(gui.actions.dispatch("run/answer", answer))).toMatchObject({
      _tag: "plugin/PluginRefused",
      reason: "person_only"
    })
    expect(await refusal(gui.actions.dispatch("pr/merge", { number: 12 }))).toMatchObject({ reason: "person_only" })
    // The strip of a host that holds only a frame credential presses nothing either.
    expect(await refusal(gui.hostStrip.press("run/answer", answer))).toMatchObject({ reason: "door_mismatch" })
    expect(await refusal(gui.hostStrip.press("pr/merge", { number: 12 }, { confirmed: true }))).toMatchObject({
      reason: "door_mismatch"
    })

    const framed = await run(engine.openFrame(hostile))
    expect(await refusal(framed.submit({ operation: "run/answer", payload: answer }))).toMatchObject({
      reason: "person_only",
      code: "app"
    })
    for (const open of both(engine, credentials)) {
      // Evidence that names a person door with a frame's fields is a person door, and the credential refuses it.
      expect(await refusal(open(hostile as unknown as Principal.DoorEvidence))).toMatchObject({
        reason: "door_mismatch"
      })
    }
    const facts = credentials.authority(
      await run(credentials.mint({ ...hostile, door: "frame" } as unknown as Principal.DoorEvidence))
    )
    expect(facts).toEqual({
      subject: "will",
      session: "s-frame-plan-tree",
      door: "gui.frame",
      act: "app",
      capabilities: ["plan:write", "workflow:run", "pane:write"],
      plugin: "plan-tree"
    })
    expect(engine.snapshot()).toBe(before)
  })

  it("a verifier that authenticates no door class mints no GUI principal, and an engine checks what was minted", async () => {
    const everything = ["plan:write"]
    // A verifier in the old shape: it vouches for the session and says nothing about the door.
    const silent = Principal.make({
      verify: () => Effect.succeed({ subject: "will", session: "s", capabilities: everything })
    })
    for (const door of ["strip", "frame"] as const) {
      expect(await refusal(silent.mint({ kind: "gui", door, session: "x", plugin: "plan-tree" } as never))).toMatchObject({
        reason: "door_mismatch"
      })
    }
    // A GUI credential does not open a delegate door.
    const guiOnly = Principal.make({
      verify: () => Effect.succeed({ subject: "will", session: "s", capabilities: everything, gui: { door: "person" } })
    })
    expect(await refusal(guiOnly.mint(evidence.mcp))).toMatchObject({ reason: "door_mismatch" })

    // An issuer that mints the person whatever the door: the frame opener still refuses.
    const real = Principal.make({
      verify: () => Effect.succeed({ subject: "will", session: "s", capabilities: everything, gui: { door: "person" } })
    })
    const lax: Principal.Credentials = {
      ...real,
      mint: () => real.mint({ kind: "gui", door: "strip", session: "x" })
    }
    const engine = await run(Core.make({ credentials: lax }))
    expect(await refusal(engine.openFrame({ session: "x", plugin: "plan-tree" }))).toMatchObject({
      reason: "door_mismatch"
    })
    expect(await refusal(engine.openMcp({ transport: "stdio", tokenRef: "x" }))).toMatchObject({
      reason: "door_mismatch"
    })
    await run(engine.openPerson({ session: "x" }))
  })
})

describe("High 3: a frame's ceilings intersect", () => {
  it("holds the session's grants inside the credential's ceiling and inside the plugin's ceiling", async () => {
    const { credentials, engine } = await world()
    const held = async (session: string, plugin = "plan-tree") =>
      credentials.authority(await run(credentials.mint({ kind: "gui", door: "frame", session, plugin })))?.capabilities

    // Grants: everything. Credential ceiling: pane:write, pr:merge. Plugin ceiling: plan:write, workflow:run, pane:write.
    expect(await held("frame-scoped")).toEqual(["pane:write"])
    // Grants: plan:write, pr:merge. No credential ceiling. The plugin ceiling does not add what was not granted.
    expect(await held("frame-limited")).toEqual(["plan:write"])
    expect(await held("frame-plan-tree")).toEqual(["plan:write", "workflow:run", "pane:write"])
    expect(await held("frame-nobody", "nobody")).toEqual([])

    const { gui: scoped } = await guiClient(engine, { frame: "frame-scoped" })
    // The plugin ceiling alone would allow this; the viewer's scoped credential does not.
    expect(await refusal(scoped.actions.dispatch("plan/upsert-node", node))).toMatchObject({
      _tag: "plugin/PluginRefused",
      reason: "outside_ceiling"
    })
    expect(await refusal(scoped.actions.dispatch("workflow/start", { page: "p", blockId: "b" }))).toMatchObject({
      reason: "outside_ceiling"
    })
    // The credential ceiling alone would allow this; the plugin's does not.
    expect(await refusal(scoped.queries.read("pr/merges"))).toMatchObject({ reason: "outside_ceiling" })
    expect(JSON.parse(engine.snapshot()).head).toBe(0)
    expect((await run(scoped.actions.dispatch("pane/maximize", { paneId: "x" }))).runId).toBe("run-1")

    const { gui: limited } = await guiClient(engine, { frame: "frame-limited" })
    expect(await refusal(limited.actions.dispatch("pane/maximize", { paneId: "y" }))).toMatchObject({
      reason: "outside_ceiling"
    })
    expect((await run(limited.actions.dispatch("plan/upsert-node", node))).runId).toBe("run-2")
  })
})

const deeplyFrozen = (value: unknown): boolean =>
  typeof value !== "object" || value === null ||
  (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen))

describe("High 4: the catalog exposes copies of registration metadata, deeply frozen", () => {
  it("neither a catalog reader nor the registrant can change what authorizes a submission", async () => {
    const { engine } = await world()
    const capabilities = ["pr:merge"]
    const payload = {
      type: "object" as const,
      properties: { id: { type: "string" as const, minLength: 1 } },
      required: ["id"],
      additionalProperties: false
    }
    const guarded: Core.Flow = {
      tag: "guarded/write",
      title: "Guarded",
      payload,
      capabilities,
      run: (fields, tx) => {
        tx.put("guarded", String(fields["id"]), fields)
        return fields
      }
    }
    const projection = { name: "guarded/rows", title: "Guarded rows", collection: "guarded", capabilities }
    await run(engine.register(guarded))
    await run(engine.register(projection))

    const { sdk } = await clients(engine)
    const all = await sdk.promises.catalog()
    for (const entry of all) expect(deeplyFrozen(entry), entry.tag).toBe(true)
    const page = await run((await run(engine.open(evidence.sdk))).catalog())
    expect(deeplyFrozen(page)).toBe(true)

    const entry = all.find((each) => each.tag === "guarded/write")!
    expect(entry.capabilities).toEqual(["pr:merge"])
    expect(entry.capabilities).not.toBe(capabilities)
    expect(entry.payload).not.toBe(payload)
    expect(entry.payload.properties).not.toBe(payload.properties)

    // A catalog reader tries to drop the capability and loosen the schema.
    const writable = entry as unknown as {
      capabilities: Array<string>
      payload: { required: Array<string>; additionalProperties: boolean; properties: Record<string, unknown> }
      personOnly?: string
      protected: boolean
    }
    expect(() => writable.capabilities.pop()).toThrow(TypeError)
    expect(() => {
      writable.capabilities = []
    }).toThrow(TypeError)
    expect(() => writable.payload.required.pop()).toThrow(TypeError)
    expect(() => {
      writable.payload.additionalProperties = true
    }).toThrow(TypeError)
    expect(() => {
      writable.payload.properties["extra"] = {}
    }).toThrow(TypeError)
    const merges = all.find((each) => each.tag === "pr/merges") as unknown as { capabilities: Array<string> }
    expect(() => merges.capabilities.pop()).toThrow(TypeError)
    const cause = all.find((each) => each.tag === "ref/cause") as unknown as { payload: { required: Array<string> } }
    expect(() => cause.payload.required.pop()).toThrow(TypeError)

    // The registrant edits the objects it registered with.
    capabilities.length = 0
    payload.required.length = 0
    payload.additionalProperties = true
    ;(payload.properties as Record<string, unknown>)["id"] = { type: "integer" }
    ;(guarded as { personOnly?: string }).personOnly = "changed"
    ;(projection as { collection: string }).collection = "merges"

    // A token without pr:merge is still refused; a holder still meets the registered schema.
    const { client: narrow } = await mcpClient(engine, { kind: "mcp", transport: "http", tokenRef: "tok-narrow" })
    expect(await narrow.call("guarded/write", { id: "a" })).toMatchObject({ ok: false, code: "capability_exceeded" })
    expect(await narrow.call("guarded/rows", {})).toMatchObject({ ok: false, code: "capability_exceeded" })
    const full = await run(engine.open(evidence.sdk))
    expect(await refusal(full.submit({ operation: "guarded/write", payload: {} }))).toMatchObject({
      reason: "invalid_payload",
      missingFields: ["id"]
    })
    expect(await refusal(full.submit({ operation: "guarded/write", payload: { id: 7 } }))).toMatchObject({
      reason: "invalid_payload"
    })
    expect(await refusal(full.submit({ operation: "guarded/write", payload: { id: "a", extra: 1 } }))).toMatchObject({
      reason: "invalid_payload"
    })
    expect(JSON.parse(engine.snapshot()).head).toBe(0)
    // Still a delegate's flow, and the query still reads its own collection.
    expect((await run(full.submit({ operation: "guarded/write", payload: { id: "a" } }))).runId).toBe("run-1")
    expect((await run(full.read({ query: "guarded/rows" }))).rows).toEqual([{ id: "a" }])
    expect((await sdk.promises.catalog()).find((each) => each.tag === "guarded/write")).toEqual(entry)
  })

  it("a handler runs without its registration record as `this`, and cannot loosen its own authorization", async () => {
    const { engine } = await world()
    const receivers: Array<unknown> = []
    const attempts: Array<string> = []
    const selfish: Core.Flow = {
      tag: "selfish/write",
      title: "Selfish",
      payload: { type: "object", properties: {}, additionalProperties: false },
      personOnly: "the person decides",
      run: function(this: unknown, fields, tx) {
        receivers.push(this)
        for (const edit of [
          (self: Record<string, unknown>) => (self["personOnly"] = undefined),
          (self: Record<string, unknown>) => (self["protected"] = false),
          (self: Record<string, unknown>) => (self["private"] = false),
          (self: Record<string, unknown>) => (self["run"] = () => ({}))
        ]) {
          try {
            edit(this as Record<string, unknown>)
            attempts.push("changed")
          } catch {
            attempts.push("refused")
          }
        }
        tx.put("selfish", "row", fields)
        return fields
      }
    }
    await run(engine.register(selfish))
    const person = await run(engine.open(evidence.strip))
    expect((await run(person.submit({ operation: "selfish/write", payload: {} }))).runId).toBe("run-1")
    expect(receivers).toEqual([undefined])
    expect(attempts).toEqual(Array(4).fill("refused"))
    // The flow is still the person's alone.
    const delegate = await run(engine.open(evidence.sdk))
    expect(await refusal(delegate.submit({ operation: "selfish/write", payload: {} }))).toMatchObject({
      reason: "person_only",
      code: "flow"
    })
    expect(JSON.parse(engine.snapshot()).head).toBe(1)
  })

  it("refuses a registration whose metadata is not JSON", async () => {
    const { engine } = await world()
    const cyclic: Record<string, unknown> = { type: "string" }
    cyclic["self"] = cyclic
    for (
      const bad of [
        { type: "object", properties: { when: (() => 1) as never } },
        { type: "object", properties: { loop: cyclic as never } }
      ] as ReadonlyArray<Core.Flow["payload"]>
    ) {
      expect(await refusal(engine.register({ tag: "bad/meta", title: "Bad", payload: bad, run: () => null })))
        .toMatchObject({ reason: "invalid_registration" })
    }
    const core = await run(engine.open(evidence.sdk))
    expect((await run(Core.entries(core))).map((entry) => entry.tag)).not.toContain("bad/meta")
  })
})

describe("High 5: a read is a detached, frozen value", () => {
  it("two reads give two frozen copies, and editing one changes neither state, journal nor receipts", async () => {
    const { engine } = await world()
    const { promises } = (await clients(engine)).sdk
    const written = (await promises.call("plan/upsert-node", node)) as Core.Requested
    const before = engine.snapshot()

    const one = await promises.read("plan/nodes", { key: "p#b" })
    const two = await promises.read("plan/nodes", { key: "p#b" })
    const every = await promises.read("plan/nodes")
    expect(one.rows[0]).toEqual({ ...node, rev: "r1" })
    expect(one.rows[0]).not.toBe(two.rows[0])
    expect(one.rows[0]).not.toBe(every.rows[0])
    for (const page of [one, two, every]) expect(deeplyFrozen(page)).toBe(true)
    expect(deeplyFrozen(written)).toBe(true)
    expect(written.output).not.toBe(one.rows[0])

    const row = one.rows[0] as unknown as { title: string; rev: string; injected?: boolean }
    expect(() => {
      row.title = "edited by a reader"
    }).toThrow(TypeError)
    expect(() => {
      row.injected = true
    }).toThrow(TypeError)
    expect(() => (one.rows as Array<unknown>).push({ page: "x" })).toThrow(TypeError)
    expect(() => {
      ;(written.output as { title: string }).title = "edited by the writer"
    }).toThrow(TypeError)

    expect(engine.snapshot()).toBe(before)
    const after = await promises.read("plan/nodes", { key: "p#b" })
    expect([after.cursor, after.rows]).toEqual(["1", [{ ...node, rev: "r1" }]])
    const receipt = await promises.read("ref/cause", { ref: written.outputRef })
    expect(receipt.rows).toEqual([written.cause])
    expect(deeplyFrozen(receipt)).toBe(true)
  })

  it("a flow holds copies too: edits to what it read or wrote do not reach the commit", async () => {
    const { engine } = await world()
    const leaked: Array<unknown> = []
    const frozen: Array<boolean> = []
    const flow = (tag: string, step: Core.Flow["run"]): Core.Flow => ({
      tag,
      title: tag,
      payload: { type: "object" },
      run: step
    })
    await run(engine.register(flow("tamper/read-then-fail", (_payload, tx) => {
      const row = tx.get("plan", "p#b") as unknown as { title: string }
      const rows = tx.rows("plan") as unknown as Array<{ title: string }>
      leaked.push(row, rows)
      frozen.push(deeplyFrozen(row), deeplyFrozen(rows), row !== rows[0])
      try {
        row.title = "edited in a failed flow"
      } catch { /* frozen */ }
      try {
        rows[0]!.title = "edited in a failed flow"
      } catch { /* frozen */ }
      return new Core.Failed("gave_up", "the flow gave up")
    })))
    await run(engine.register(flow("tamper/edit-in-place", (_payload, tx) => {
      // The old engine handed out the committed row itself; this edit then needed no put.
      ;(tx.get("plan", "p#b") as unknown as { title: string }).title = "edited in place"
      return null
    })))
    await run(engine.register(flow("tamper/write-then-edit", (payload, tx) => {
      frozen.push(deeplyFrozen(payload))
      const row = { title: "as written", tags: ["a"] }
      tx.put("drafts", "d1", row)
      row.title = "edited after put"
      row.tags.push("b")
      leaked.push(row)
      return { ok: true }
    })))

    const core = await run(engine.open(evidence.sdk))
    await run(core.submit({ operation: "plan/upsert-node", payload: node }))
    await run(engine.register({ name: "drafts/rows", title: "Drafts", collection: "drafts" }))
    const before = engine.snapshot()

    expect(await refusal(core.submit({ operation: "tamper/read-then-fail" }))).toMatchObject({
      reason: "operation_failed",
      code: "gave_up"
    })
    expect(await refusal(core.submit({ operation: "tamper/edit-in-place" }))).toMatchObject({
      reason: "operation_failed",
      code: "defect"
    })
    expect(frozen).toEqual([true, true, true])
    // Both failed: the snapshot and the cursor are where they were.
    expect(engine.snapshot()).toBe(before)
    expect((await run(core.read({ query: "plan/nodes" }))).cursor).toBe("1")

    expect((await run(core.submit({ operation: "tamper/write-then-edit" }))).journalSeq).toBe(2)
    expect((await run(core.read({ query: "drafts/rows" }))).rows).toEqual([{ title: "as written", tags: ["a"] }])
    // The flow kept its own row. Editing it after the commit changes nothing.
    const kept = leaked[2] as { title: string; tags: Array<string> }
    kept.title = "edited after commit"
    kept.tags.length = 0
    const committed = engine.snapshot()
    expect(JSON.parse(committed).collections.drafts).toEqual({ d1: { title: "as written", tags: ["a"] } })
    expect(JSON.parse(committed).head).toBe(2)
    expect((await run(core.read({ query: "plan/nodes" }))).rows).toEqual([{ ...node, rev: "r1" }])
  })
})

describe("Medium 6: every payload field has an unambiguous CLI flag", () => {
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
    run: (payload) => payload
  }

  it("a field named format is --arg.format, and --format stays the output option", async () => {
    const { engine } = await world()
    await run(engine.register(exportTable))
    const { cli } = (await clients(engine)).cli
    const command = (await run(cli.commands)).find((each) => each.name === "table/export")!
    expect(command.flags.map((flag) => [flag.field, flag.flag])).toEqual([
      ["format", "--arg.format"],
      ["table", "--table"]
    ])
    expect(await run(cli.skill)).toContain("- `--arg.format <string>` (required)")

    const output = { format: "csv", table: "plan" }
    for (
      const argv of [
        ["--arg.format", "csv", "--table", "plan"],
        ["--arg.format", "csv", "--arg.table", "plan"],
        ["--input-json", JSON.stringify(output)],
        ["--input-json", "{\"table\":\"plan\"}", "--arg.format", "csv"],
        ["--arg.format", "csv", "--table", "plan", "--out-format", "json"],
        ["--format", "json", "--arg.format", "csv", "--table", "plan"]
      ]
    ) {
      const exit = await run(cli.run(["table/export", ...argv]))
      expect([exit.exitCode, exit.stderr], argv.join(" ")).toEqual([0, ""])
      expect(JSON.parse(exit.stdout).output, argv.join(" ")).toEqual(output)
    }
    // Both at once: the payload's format and the output's format do not meet.
    const markdown = await run(cli.run(["table/export", "--arg.format", "tsv", "--table", "plan", "--format", "md"]))
    expect(markdown.stdout.startsWith("# table/export\n\n```json\n")).toBe(true)
    expect(markdown.stdout).toContain("\"format\": \"tsv\"")

    const before = engine.snapshot()
    // The old ambiguous spelling is a usage error that names the flag to use.
    const old = await run(cli.run(["table/export", "--format", "csv", "--table", "plan"]))
    expect([old.exitCode, JSON.parse(old.stderr).code]).toEqual([2, "usage"])
    expect(JSON.parse(old.stderr).detail).toContain("--arg.format")
    for (
      const argv of [
        ["--arg.format", "csv", "--arg.format", "tsv", "--table", "plan"],
        ["--input-json", JSON.stringify(output), "--arg.format", "csv"],
        ["--input-json", JSON.stringify(output), "--table", "plan"],
        ["--input-json", "{}", "--input-json", "{}"],
        ["--input-json", "[1]"],
        ["--input-json", "{"],
        ["--input-json", "null"],
        ["--arg.nope", "x"],
        ["--arg.", "x"],
        ["--out-format", "csv"]
      ]
    ) {
      const exit = await run(cli.run(["table/export", ...argv]))
      expect([exit.exitCode, exit.stdout, JSON.parse(exit.stderr).code], argv.join(" ")).toEqual([2, "", "usage"])
    }
    // A wrong value reaches the core, which answers as it does on every other wire.
    const refused = await run(cli.run(["table/export", "--input-json", "{\"format\":\"xml\",\"table\":\"plan\"}"]))
    expect([refused.exitCode, JSON.parse(refused.stderr).code]).toEqual([1, "invalid_payload"])
    expect(engine.snapshot()).toBe(before)
  })

  it("two fields that normalize to one flag, and fields named like the CLI's options, each keep a flag", async () => {
    const { engine } = await world()
    const text = { type: "string" } as const
    await run(engine.register({
      tag: "clash/fields",
      title: "Clashing fields",
      payload: {
        type: "object",
        properties: {
          plan_id: text,
          planId: text,
          outFormat: text,
          inputJson: text,
          "arg.x": text,
          x: text,
          plain: text
        } as Core.Flow["payload"]["properties"] & {},
        additionalProperties: false
      },
      run: (payload) => payload
    }))
    const { cli } = (await clients(engine)).cli
    const command = (await run(cli.commands)).find((each) => each.name === "clash/fields")!
    const flags = command.flags.map((flag) => flag.flag)
    expect(new Set(flags).size).toBe(flags.length)
    for (const flag of flags) expect(CliAdapter.reservedFlags).not.toContain(flag)
    expect(Object.fromEntries(command.flags.map((flag) => [flag.field, flag.flag]))).toMatchObject({
      plan_id: "--arg.plan_id",
      planId: "--arg.planId",
      outFormat: "--arg.outFormat",
      inputJson: "--arg.inputJson",
      "arg.x": "--arg.arg.x",
      x: "--x",
      plain: "--plain"
    })

    const argv = command.flags.flatMap((flag) => [flag.flag, `value of ${flag.field}`])
    const exit = await run(cli.run(["clash/fields", ...argv, "--out-format", "json"]))
    expect([exit.exitCode, exit.stderr]).toEqual([0, ""])
    const output = JSON.parse(exit.stdout).output
    for (const flag of command.flags) expect(output[flag.field], flag.field).toBe(`value of ${flag.field}`)
    expect(Object.keys(output).sort()).toEqual(command.flags.map((flag) => flag.field).sort())

    // The short flag two fields would share names neither.
    const shared = await run(cli.run(["clash/fields", "--plan-id", "a"]))
    expect([shared.exitCode, JSON.parse(shared.stderr).code]).toEqual([2, "usage"])
  })
})

it("publishes a durable flow only after its persistence succeeds", async () => {
  const { credentials } = await world()
  let unavailable = true
  const tag = "plan/record"
  const engine = await run(Core.make({
    credentials,
    initialJournalSeq: 4,
    flows: [{
      tag,
      title: "Record node",
      payload: { type: "object", properties: {}, additionalProperties: false },
      run: (_input, tx) => {
        tx.put("plan", "one", { value: 1 })
        return { value: 1 }
      }
    }],
    projections: [{ name: "plan/read", title: "Read plan", collection: "plan" }],
    persist: () => unavailable
      ? Effect.fail(new Core.CoreError({ reason: "operation_failed", target: tag, detail: "Disk unavailable" }))
      : Effect.void
  }))
  const api = await run(engine.open(evidence.strip))
  expect(await refusal(api.submit({ operation: tag }))).toMatchObject({ reason: "operation_failed" })
  expect(await run(api.read({ query: "plan/read" }))).toEqual({ cursor: "4", rows: [] })
  expect(await refusal(api.read({ query: "ref/cause", params: { ref: "out/run-5" } }))).toMatchObject({
    reason: "provenance_missing"
  })
  unavailable = false
  expect(await run(api.submit({ operation: tag }))).toMatchObject({ runId: "run-5", journalSeq: 5 })
  expect(await run(api.read({ query: "plan/read" }))).toEqual({ cursor: "5", rows: [{ value: 1 }] })
})
