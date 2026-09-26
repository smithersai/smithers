/**
 * A completion written before the calls its own reply made had returned.
 *
 * Several `cell` blocks in one reply run as one program, so a reply that
 * probes and then answers completes the run before the model has read the
 * probe. Real seats did exactly this in about one delivery in three: a builder
 * ran `ctx.call("bash", …)`, printed it, and in the same reply completed with
 * "blocked: workspace inspection did not return an observable result"; a
 * checker did the same with "verification output unavailable".
 */
import { ModelRequest } from "@smthrs/model"
import { Effect, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as FailedCall from "../src/FailedCall.ts"
import { HarnessError } from "../src/HarnessError.ts"
import type * as Frame from "../src/internal/frame.ts"
import * as UnobservedCall from "../src/internal/unobservedCall.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Steering from "../src/Steering.ts"
import { confidentEvaluator, descriptor, emits, of, pattern, run, window } from "./fixtures/cellTurn.ts"
import * as ScriptedEngine from "./fixtures/scriptedEngine.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const bash = descriptor("bash", { capabilities: ["proc:spawn:*"] })
const edit = descriptor("edit", { capabilities: ["proc:spawn:*"] })

/** Every other completion demand is off, so each case is about this one. */
const armedOptions = {
  session: "session-1",
  seat: "cerebras:test-model",
  modelParams: ModelRequest.GenerationParams.make(),
  layers: ["layer-a"],
  capabilityEnvelope: ["proc:spawn:*"].map(pattern),
  placement: Option.none(),
  contextWindow: window,
  maxFrames: 4,
  repeatCap: 0,
  unmovedCap: 0,
  narrowingCap: 0,
  unresolvedCap: 0,
  claimCap: 0
}

const armed = (maxFrames = 4) => CellTurn.make({ ...armedOptions, maxFrames })

const tail: ScriptedEngine.CallStep = { _tag: "Success", value: { exitCode: 0, stdout: "last line: Maintained." } }
const status: ScriptedEngine.CallStep = { _tag: "Success", value: { exitCode: 0, stdout: " M README.md" } }

/** The builder's reply from the qualification run: a probe, then a blind answer. */
const probeThenAnswer = `const survey = await ctx.call("bash", { command: "tail -n 1 README.md" })
console.log(survey.stdout)
\`\`\`
\`\`\`cell
const result = { status: "blocked", summary: "No command output was available." }
ctx.done(JSON.stringify(result))`

const answer = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
  JSON.stringify(of(events, "resolved")[0]?.message.content)

const drive = (
  cells: ReadonlyArray<string>,
  calls: ReadonlyArray<ScriptedEngine.CallStep>,
  maxFrames = 4
) => run({ state: armed(maxFrames), flows: [bash, edit], script: cells.map(emits), calls })

describe("CellTurn completion over unread calls", () => {
  it("lets a completion alone stand", async () => {
    const { events } = await drive([`ctx.done("Nothing to run.")`], [])

    expect(of(events, "unobserved-demanded")).toEqual([])
    expect(answer(events)).toContain("Nothing to run.")
  })

  it("refuses a call then a blind done in one reply, shows the output, and accepts the next reply's done", async () => {
    const { events, model } = await drive(
      [probeThenAnswer, `ctx.done("README ends with: Maintained.")`],
      [tail]
    )

    expect(of(events, "unobserved-demanded")).toEqual([
      expect.objectContaining({
        calls: [{ flow: "bash", ordinal: 1, ok: true, summary: expect.stringContaining("last line: Maintained.") }],
        nextFrame: 1
      })
    ])
    // Refused, not failed: the frame continued into a second model call.
    expect(of(events, "turn-closed").map((event) => event.outcome)).toEqual(["continue", "resolved"])
    const handedBack = JSON.stringify(model.recorder.requests[1]?.messages)
    expect(handedBack).toContain(UnobservedCall.heading)
    expect(handedBack).toContain("Answer after reading the calls' output")
    // What the cell printed and what the call returned both reach the model.
    expect(handedBack).toContain("What your cell printed:\\nlast line: Maintained.")
    expect(handedBack).toContain("1. bash -> ok")
    expect(answer(events)).toContain("README ends with: Maintained.")
    expect(answer(events)).not.toContain("No command output")
  })

  it("names every call a blind answer followed, in ledger order", async () => {
    const { events } = await drive(
      [
        `const a = await ctx.call("bash", { command: "tail -n 1 README.md" })
         const b = await ctx.call("bash", { command: "git status --porcelain" })
         console.log(a.stdout, b.stdout)
         ctx.done("Checked.")`,
        `ctx.done("README changed only.")`
      ],
      [tail, status]
    )

    expect(of(events, "unobserved-demanded")[0]?.calls.map((call) => [call.ordinal, call.flow])).toEqual([
      [1, "bash"],
      [2, "bash"]
    ])
    expect(answer(events)).toContain("README changed only.")
  })

  it("hands a failed call in a try to the failed-call demand first, then accepts the next done", async () => {
    const { events, model } = await drive(
      [
        `let seen
         try { seen = await ctx.call("bash", { command: "tail -n 1 README.md" }) } catch (error) { console.log(error) }
         console.log(seen)
         ctx.done("Verified.")`,
        `ctx.done("Not verified: the command failed.")`
      ],
      [{ _tag: "Failure", message: "Flow bash failed: no such file" }]
    )

    // One demand per completion, most fundamental first.
    expect(of(events, "failed-call-demanded")).toHaveLength(1)
    expect(of(events, "unobserved-demanded")).toEqual([])
    expect(JSON.stringify(model.recorder.requests[1]?.messages)).toContain(FailedCall.heading)
    expect(answer(events)).toContain("Not verified: the command failed.")
  })

  it("refuses a blind done after a try whose later line threw", async () => {
    const { events } = await drive(
      [
        `let parsed
         try { const r = await ctx.call("bash", { command: "cat package.json" }); parsed = JSON.parse(r.stdout) } catch { console.log("unparsed") }
         ctx.done("Read the package.")`,
        `ctx.done("package.json is not JSON.")`
      ],
      [{ _tag: "Success", value: { exitCode: 0, stdout: "not json" } }]
    )

    expect(of(events, "unobserved-demanded")).toHaveLength(1)
    expect(answer(events)).toContain("package.json is not JSON.")
  })

  it("spares a completion guarded by the result, the shape the cell contract teaches", async () => {
    const { events } = await drive(
      [
        `const after = await ctx.call("bash", { command: "npm test" })
         console.log(after.stdout)
         if (after.exitCode === 0) ctx.done("npm test exits 0.")`
      ],
      [tail]
    )

    expect(of(events, "unobserved-demanded")).toEqual([])
    expect(answer(events)).toContain("npm test exits 0.")
  })

  it("spares a completion whose answer is the result", async () => {
    const { events } = await drive(
      [`const seen = await ctx.call("bash", { command: "tail -n 1 README.md" }); ctx.done(seen.stdout)`],
      [tail]
    )

    expect(of(events, "unobserved-demanded")).toEqual([])
    expect(answer(events)).toContain("last line: Maintained.")
  })

  it("spares an effect whose result the cell discarded", async () => {
    const { events } = await drive(
      [`await ctx.call("edit", { path: "README.md", oldString: "a", newString: "b" })\nctx.done("Edited README.md.")`],
      [status]
    )

    expect(of(events, "unobserved-demanded")).toEqual([])
    expect(answer(events)).toContain("Edited README.md.")
  })

  it("asks once per run: a later blind answer stands", async () => {
    const { events } = await drive(
      [
        probeThenAnswer,
        `const again = await ctx.call("bash", { command: "tail -n 1 README.md" }); console.log(again.stdout)`,
        `const third = await ctx.call("bash", { command: "tail -n 1 README.md" }); console.log(third); ctx.done("Stands.")`
      ],
      [tail, tail, tail]
    )

    expect(of(events, "unobserved-demanded")).toHaveLength(1)
    expect(answer(events)).toContain("Stands.")
  })

  it("lets a blind answer stand when no frame is left to answer in", async () => {
    const { events } = await drive([probeThenAnswer], [tail], 1)

    expect(of(events, "unobserved-demanded")).toEqual([])
    expect(answer(events)).toContain("No command output")
  })

  it("replays the recorded demand instead of judging again", async () => {
    const records = new Map<string, unknown>()
    const attempt = async (seen: ScriptedEngine.CallStep) => {
      const model = ScriptedModel.make([
        emits(probeThenAnswer),
        emits(`ctx.park("waiting-input", "May I append the line?")`)
      ])
      const engine = ScriptedEngine.make(model.model, [seen])
      const events: Array<AgentEvent.AgentEvent> = []
      const outcome = await CellTurn.run({
        state: CellTurn.make({ ...armedOptions, approvalChannel: true }),
        flows: [bash]
      }).pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.provide(journaled(engine, records)),
        Effect.provide(QuickJSSandbox.layer),
        Effect.provide(Steering.layerNoop()),
        Effect.provide(confidentEvaluator),
        Effect.result,
        Effect.runPromise
      )
      return { events, engine, outcome }
    }

    const original = await attempt(tail)
    // A host whose probe would now read differently: the recorded judgement,
    // not a fresh one, decides the replayed frame.
    const replay = await attempt({ _tag: "Success", value: { exitCode: 1, stdout: "changed since" } })

    expect(of(original.events, "unobserved-demanded")).toHaveLength(1)
    expect(of(replay.events, "unobserved-demanded")).toEqual(of(original.events, "unobserved-demanded"))
    expect(of(replay.events, "turn-closed")).toEqual(of(original.events, "turn-closed"))
    expect(JSON.stringify(of(replay.events, "unobserved-demanded"))).not.toContain("changed since")
    expect(replay.outcome._tag).toBe("Failure")
  })
})

const boundaryKey = (boundary: EngineLike.RecordBoundary<unknown>): string =>
  `${boundary.name}\u0000${
    boundary.identity.session ?? ""
  }\u0000${boundary.identity.frame}\u0000${boundary.identity.boundary}`

/** A scripted engine whose recorded boundaries persist in `records`, so a second run replays them. */
const journaled = (fixture: ScriptedEngine.Fixture, records: Map<string, unknown>) =>
  EngineLike.layer(
    EngineLike.make({
      ...fixture.engine,
      record: (boundary) => {
        const held = records.get(boundaryKey(boundary))
        if (held !== undefined) {
          return Effect.fromResult(Schema.decodeUnknownResult(boundary.success)(held)).pipe(
            Effect.mapError((cause) => new HarnessError({ code: "engine_failed", message: "undecodable", cause }))
          )
        }
        const encode = Schema.encodeUnknownSync(
          boundary.success as unknown as Schema.Schema<unknown> & { readonly "EncodingServices": never }
        )
        return boundary.execute.pipe(
          Effect.tap((value) => Effect.sync(() => void records.set(boundaryKey(boundary), encode(value))))
        )
      }
    })
  )

describe("UnobservedCall", () => {
  const blind = UnobservedCall.blind

  it("reads the qualification replies the way the evidence reads them", () => {
    // Builder frame 417 and checker frame 1106: a probe, printed, then a
    // completion built from a literal.
    expect(blind(probeThenAnswer.replace("```\n```cell\n", ""))).toBe(true)
    // Builder frame 836: the completion sits behind the checks' exit codes.
    expect(blind(`const applied = await ctx.call("bash", {})
      const tree = await ctx.call("bash", {})
      if (applied.exitCode === 0 && tree.stdout.includes(" M README.md")) {
        ctx.done(JSON.stringify({ status: "done" }))
      } else console.log("not yet", tree.stdout)`)).toBe(false)
  })

  it("follows results through the program's own bindings", () => {
    expect(
      blind(
        `const seen = await ctx.call("bash", {}); const result = { s: 1 }; result.summary = "Seen: " + JSON.stringify(seen); ctx.done(JSON.stringify(result))`
      )
    ).toBe(false)
    expect(blind(`const all = []; all.push(await ctx.call("bash", {})); ctx.done(String(all.length))`)).toBe(false)
    expect(blind(`async function probe() { return ctx.call("bash", {}) } const r = await probe(); ctx.done(r.stdout)`))
      .toBe(false)
    expect(blind(`const { stdout, ...rest } = await ctx.call("bash", {}); ctx.done(stdout)`)).toBe(false)
    expect(
      blind(`const [first, , third = 1] = await Promise.all([ctx.call("a", {}), ctx.call("b", {})]); ctx.done(first)`)
    ).toBe(false)
    expect(blind(`const lines = await ctx.call("bash", {}); let n; for (const line of lines) n = line; ctx.done(n)`))
      .toBe(false)
    expect(blind(`const lines = await ctx.call("bash", {}); let k; for (k in lines) {} ctx.done(k)`)).toBe(false)
    expect(blind(`const lines = await ctx.call("bash", {}); let k; for (k of lines) {} ctx.done(k)`)).toBe(false)
    expect(blind(`const r = await ctx.call("bash", {}); const key = "stdout"; ctx.done({ [key]: r }[key])`)).toBe(false)
    expect(blind(`const r = await ctx.call("bash", {}); ctx.done(r["stdout"])`)).toBe(false)
  })

  it("reads a name, never a property or key that shares it", () => {
    expect(blind(`const seen = await ctx.call("bash", {}); console.log(seen); ctx.done(other.seen)`)).toBe(true)
    expect(blind(`const seen = await ctx.call("bash", {}); console.log(seen); ctx.done(JSON.stringify({ seen: 1 }))`))
      .toBe(true)
    expect(
      blind(`const seen = await ctx.call("bash", {}); console.log(seen); ctx.done(String({ seen() { return 1 } }))`)
    ).toBe(true)
    expect(
      blind(
        `const seen = await ctx.call("bash", {}); console.log(seen); class A { seen() {} #seen() {} }; ctx.done("x")`
      )
    ).toBe(true)
    // Assigning to something that is not a name moves nothing.
    expect(blind(`const seen = await ctx.call("bash", {}); console.log(seen); [0][0] = seen; ctx.done("x")`)).toBe(true)
  })

  it("spares a program that reads a result in a condition, a call's input, or the completion", () => {
    const probe = `const r = await ctx.call("bash", {});\n`
    for (
      const acting of [
        `if (r.ok) ctx.done("a"); else ctx.done("b")`,
        `r.exitCode === 0 ? ctx.done("a") : console.log(r)`,
        `r.exitCode === 0 && ctx.done("a")`,
        `while (r.exitCode === 0) { ctx.done("a"); break }`,
        `do { ctx.done("a") } while (r.exitCode !== 0)`,
        `switch (r.exitCode) { case 0: ctx.done("a") }`,
        `switch (1) { case r.exitCode: ctx.done("a"); break; default: console.log(1) }`,
        `if (r.exitCode !== 0) { console.log(r); return }\nctx.done("a")`,
        `if (r.exitCode !== 0) throw new Error("no")\nctx.done("a")`,
        `if (r.ok) console.log(r)\nctx.done("a")`,
        `if (r.ok) ctx.done(r.stdout)\nctx.done("fallback")`,
        // Asked, saved the answer, completed: the program acted on the result.
        `await ctx.call("note/save", { text: "decision=" + r.approved })\nctx.done("settled")`
      ]
    ) expect(blind(probe + acting)).toBe(false)
    expect(blind(`for (const [name, input] of [["bash", {}], ["test", {}]]) {
      const result = await ctx.call(name, input); if (result.ok === false) console.log(name)
    }
    ctx.done("done")`)).toBe(false)
    for (
      const blindly of [
        `if (other) ctx.done("a")`,
        `other && ctx.done("a")`,
        `if (other) {} else ctx.done("a")`,
        `if (other) return\nctx.done("a")`,
        `switch (other) { case 1: console.log(r); default: ctx.done("a") }`,
        `console.log(r.stdout, r?.stderr); console.info(r)\nctx.done("blocked: output not observed")`
      ]
    ) expect(blind(probe + blindly)).toBe(true)
  })

  it("never calls a cell blind that kept no result, completed nowhere it can see, or does not parse", () => {
    expect(blind(`await ctx.call("edit", {}); ctx.done("Edited.")`)).toBe(false)
    expect(blind(`ctx.call("edit", {}); void ctx.call("edit", {}); void (await ctx.call("edit", {})); ctx.done("x")`))
      .toBe(false)
    expect(blind(`ctx.done("Nothing called.")`)).toBe(false)
    // A completion reached through an alias is not seen, so it reads as blind.
    expect(blind(`const r = await ctx.call("bash", {}); const finish = ctx["done"]; finish(r)`)).toBe(true)
    expect(blind("const r = await ctx.call(\"bash\", {}); ctx.done(`unterminated")).toBe(false)
  })

  it("names the calls only when the cell completed blind", () => {
    const settled: ReadonlyArray<Pick<Frame.ObservedCall, "flow" | "ok" | "ordinal" | "summary">> = [
      { flow: "bash", ok: false, ordinal: 4, summary: "Flow bash failed: nope" }
    ]
    const source = `const r = await ctx.call("bash", {}); console.log(r); ctx.done("x")`
    expect(UnobservedCall.find(settled, source)).toEqual([
      { flow: "bash", ok: false, ordinal: 4, summary: "Flow bash failed: nope" }
    ])
    expect(UnobservedCall.find([], source)).toEqual([])
    expect(UnobservedCall.find(settled, `ctx.done("x")`)).toEqual([])
    expect(UnobservedCall.demand(UnobservedCall.find(settled, source))).toBe(
      `${UnobservedCall.heading}:\n- 4. bash -> FAILED: Flow bash failed: nope\n\nAnswer after reading the calls' output, in a reply of its own.`
    )
  })

  it("decodes a state journaled before the counter existed as having asked nothing", () => {
    const encoded = Schema.encodeSync(CellTurn.State)(armed()) as Record<string, unknown>
    delete encoded.unobservedDemands
    expect(Schema.decodeUnknownSync(CellTurn.State)(encoded).unobservedDemands).toBe(0)
  })
})
