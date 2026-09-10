/**
 * The persistent realm: one QuickJS context for a whole run.
 *
 * These cases fix what the REPL mode promises the model — declarations survive
 * into the next cell, a throw leaves the names it had already bound, printing is
 * the channel to the next turn, and the transition is a call rather than a
 * return.
 */
import { Deferred, Effect, Fiber, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellValidation from "../src/CellValidation.ts"
import * as bytes from "../src/internal/bytes.ts"
import * as CellPrompt from "../src/internal/cellPrompt.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"
import type * as VariablesPanel from "../src/VariablesPanel.ts"

const projection = (name: string): Cell.FlowProjection =>
  new Cell.FlowProjection({
    name,
    description: `The ${name} flow.`,
    capabilities: [],
    tier: "sealed",
    placement: Option.none(),
    input: Option.none()
  })

const flows = { echo: projection("echo") }

const succeeds: Sandbox.Handler = (invocation) =>
  Effect.succeed(new Cell.CallResult({ outcome: "success", value: { seen: invocation.input } }))

/** Runs a sequence of cells against one realm and reports every frame. */
const session = (
  cells: ReadonlyArray<string>,
  options: {
    readonly limits?: Sandbox.Limits | undefined
    readonly call?: Sandbox.Handler | undefined
    readonly catalog?: Readonly<Record<string, Cell.FlowProjection>> | undefined
  } = {}
): Promise<ReadonlyArray<Sandbox.RealmFrame>> =>
  Effect.gen(function*() {
    const sandbox = yield* QuickJSSandbox.make
    const open = sandbox.openRealm
    expect(open).toBeDefined()
    const realm = yield* open!({ flows: options.catalog ?? flows, limits: options.limits })
    const frames: Array<Sandbox.RealmFrame> = []
    for (const [index, text] of cells.entries()) {
      frames.push(
        yield* realm.evaluate({
          cell: Cell.source(text),
          frame: index,
          call: options.call ?? succeeds
        })
      )
    }
    return frames
  }).pipe(Effect.scoped, Effect.runPromise)

const named = (bindings: ReadonlyArray<VariablesPanel.Binding>, name: string): VariablesPanel.Binding | undefined =>
  bindings.find((binding) => binding.name === name)

describe("QuickJSSandbox.openRealm", () => {
  it("rejects hoisted host-binding replacement without damaging the next cell", async () => {
    const frames = await session([
      "if (true) { var ctx = 1 }",
      "for (var console of [1]) {}",
      "console.log(typeof ctx.call)"
    ])
    expect(frames[0]!.outcome).toMatchObject({ _tag: "rejected", code: "compile_failed" })
    expect(frames[1]!.outcome).toMatchObject({ _tag: "rejected", code: "compile_failed" })
    expect(frames[2]!.outcome._tag).toBe("settled")
    expect(frames[2]!.prints).toBe("function")
  })

  it("keeps a cell's top-level declarations bound in the next cell", async () => {
    const frames = await session([
      "const kept = 41\nlet counter = 1",
      "counter = counter + kept\nconsole.log(counter)"
    ])
    expect(frames[1]!.prints).toBe("42")
    expect(named(frames[1]!.bindings, "kept")).toEqual({ name: "kept", type: "number", size: "41" })
  })

  it("projects every FlowProjection field into ctx.flows", async () => {
    const input = { type: "object", properties: { path: { type: "string" } } } as const
    const complete = new Cell.FlowProjection({
      name: "echo",
      description: "The echo flow.",
      capabilities: ["fs:read:**"],
      tier: "sealed",
      placement: Option.some("local"),
      input: Option.some(input)
    })
    const frames = await session(["console.log(JSON.stringify(ctx.flows.echo))"], {
      catalog: { echo: complete }
    })
    const exposed = JSON.parse(frames[0]!.prints) as Record<string, unknown>

    expect(Object.keys(exposed).sort()).toEqual(Object.keys(Cell.FlowProjection.fields).sort())
    expect(exposed["placement"]).toBe("local")
    expect(exposed["input"]).toEqual(input)
  })

  it("lets a later cell re-declare a name instead of dying on a redeclaration", async () => {
    const frames = await session([
      "const result = 1",
      "const result = 2\nconsole.log(result)"
    ])
    expect(frames[1]!.outcome._tag).toBe("settled")
    expect(frames[1]!.prints).toBe("2")
  })

  it("clears a name re-declared without an initializer", async () => {
    const frames = await session([
      "let held = 'first'",
      "let held\nconsole.log(String(held))"
    ])
    expect(frames[1]!.prints).toBe("undefined")
    expect(named(frames[1]!.bindings, "held")).toEqual({ name: "held", type: "unset", size: "" })
  })

  it("binds a top-level class as a redeclarable name", async () => {
    const frames = await session([
      "class Widget { constructor(size) { this.size = size } }",
      "const made = new Widget(3)\nconsole.log(made.size)"
    ])
    expect(frames[1]!.prints).toBe("3")
    expect(named(frames[1]!.bindings, "Widget")?.type).toBe("function")
  })

  it("keeps the names a cell bound before it threw, and lets the next cell carry on", async () => {
    const frames = await session([
      "const before = 'kept'\nthrow new Error('stop')\nconst after = 'never'",
      "console.log(before, typeof after)"
    ])
    expect(frames[0]!.outcome._tag).toBe("raised")
    expect(named(frames[0]!.bindings, "before")).toEqual({ name: "before", type: "string", size: "4 chars" })
    expect(named(frames[0]!.bindings, "after")).toEqual({ name: "after", type: "unset", size: "" })
    expect(frames[1]!.prints).toBe("kept undefined")
  })

  it("renders a printed structure as JSON rather than as [object Object]", async () => {
    const frames = await session(["console.log('Source:', { b: 2, a: 1 })"])
    expect(frames[0]!.prints).toBe(`Source: {"a":1,"b":2}`)
  })

  it("prints functions, symbols and undefined as themselves", async () => {
    const frames = await session([
      "console.info(undefined)\nconsole.warn(function named() {})\nconsole.error(Symbol('tag'))"
    ])
    expect(frames[0]!.prints.split("\n")[0]).toBe("undefined")
    expect(frames[0]!.prints.split("\n")[2]).toBe("Symbol(tag)")
  })

  it("gives one lone statement the whole frame budget, from both ends", async () => {
    // The bug this closes, in its smallest form. The old per-statement cap cut
    // this at 4 KiB of head and the frame budget went unspent; a fused print
    // whose head is a warning banner therefore lost its own verdict line.
    const frames = await session([
      `const wide = "HEAD" + "x".repeat(${Sandbox.printFrameBytes * 2}) + "TAIL"\nconsole.log(wide)`
    ])
    expect(frames[0]!.prints).toContain("still bound in the realm")
    expect(frames[0]!.prints.startsWith("HEAD")).toBe(true)
    expect(frames[0]!.prints.endsWith("TAIL")).toBe(true)
    expect(frames[0]!.prints).toContain(`of ${Sandbox.printFrameBytes * 2 + 8} bytes elided`)
    expect(frames[0]!.prints.length).toBeLessThan(Sandbox.printFrameBytes + 300)
  })

  it("leaves a short statement whole while its long sibling pays for the budget", async () => {
    const frames = await session([
      `const wide = "z".repeat(${
        Sandbox.printFrameBytes * 2
      })\nconsole.log("the short line survives")\nconsole.log(wide)`
    ])
    expect(frames[0]!.prints.split("\n")[0]).toBe("the short line survives")
    expect(frames[0]!.prints).toContain("still bound in the realm")
    expect(frames[0]!.prints.length).toBeLessThan(Sandbox.printFrameBytes + 300)
  })

  it("bounds a whole frame's print buffer from the middle", async () => {
    const frames = await session([
      `for (let index = 0; index < 12; index++) console.log("y".repeat(${Sandbox.printFrameBytes / 4}))`
    ])
    expect(frames[0]!.prints).toContain("elided from the middle")
    expect(frames[0]!.prints.length).toBeLessThan(Sandbox.printFrameBytes + 300)
  })

  it("drops whole statements from the middle when a frame prints more than it can floor", async () => {
    // Sixty statements of four times the floor: no apportionment leaves each of
    // them a share worth reading, so whole ones go from the middle and are
    // counted rather than every one of them being cut to its own notice.
    const frames = await session([
      `for (var index = 0; index < 60; index++) console.log(index + ":" + "w".repeat(${
        Sandbox.printStatementFloor * 4
      }) + ":" + index)`
    ])
    expect(frames[0]!.prints.startsWith("0:")).toBe(true)
    expect(frames[0]!.prints.endsWith(":59")).toBe(true)
    expect(frames[0]!.prints).toContain("print statements elided from the middle of this frame")
    expect(frames[0]!.prints.length).toBeLessThanOrEqual(Sandbox.printFrameBytes)
  })

  it("keeps every line of a frame that printed many short ones", async () => {
    // The other half of the same rule: a count that does not depend on what the
    // statements cost dropped a hundred and sixty-eight of these while the frame
    // budget sat unspent.
    const frames = await session([
      `for (var index = 0; index < 200; index++) console.log("line " + index)`
    ])
    expect(frames[0]!.prints.split("\n")).toHaveLength(200)
    expect(frames[0]!.prints).toContain("line 100")
    expect(frames[0]!.prints).not.toContain("elided")
  })

  it("cuts a multibyte statement between characters, never through one", async () => {
    // A cut through a surrogate pair does not shorten a value by a character, it
    // replaces that character with half of one — and two ends joined without a
    // marker can fuse two halves into a character nothing printed.
    const frames = await session([
      `console.log("A" + "\\u{1F600}".repeat(${Sandbox.printFrameBytes}) + "Z")`
    ])
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(frames[0]!.prints))
      .toBe(false)
    expect(frames[0]!.prints.startsWith("A\u{1F600}")).toBe(true)
    expect(frames[0]!.prints.endsWith("\u{1F600}Z")).toBe(true)
    expect(bytes.size(frames[0]!.prints)).toBeLessThanOrEqual(Sandbox.printFrameBytes)
  })

  it("bounds an emoji print by the real UTF-8 frame budget", async () => {
    const count = 10_000
    const frames = await session([`console.log("\\u{1F600}".repeat(${count}))`])

    expect(frames[0]!.prints).toContain(`of ${count * 4} bytes elided`)
    expect(bytes.size(frames[0]!.prints)).toBeLessThanOrEqual(Sandbox.printFrameBytes)
  })

  it("resolves a flow call and hands the result back inside the same cell", async () => {
    const frames = await session([
      "const answer = await ctx.call('echo', { ask: 1 })\nconsole.log(answer)"
    ])
    expect(frames[0]!.prints).toBe(`{"seen":{"ask":1}}`)
  })

  it("settles a completion from ctx.done", async () => {
    const frames = await session(["ctx.done('the check passes')"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag).toBe("settled")
    expect(outcome._tag === "settled" && outcome.transition._tag).toBe("complete")
    expect(outcome._tag === "settled" && outcome.transition._tag === "complete" && outcome.transition.output)
      .toBe("the check passes")
  })

  it("raises a catchable refusal when ctx.done omits its output", async () => {
    const frames = await session([
      `try { ctx.done() } catch (error) { console.log(error.message) }
       ctx.done("caught")`
    ])
    const outcome = frames[0]!.outcome

    expect(frames[0]!.prints).toBe(
      "ctx.done(output) takes the run's answer; call it with the value the task asked for"
    )
    expect(outcome._tag === "settled" && outcome.transition._tag === "complete" && outcome.transition.output)
      .toBe("caught")
  })

  it("accepts an explicit null completion as the string null", async () => {
    const frames = await session(["ctx.done(null)"])
    const outcome = frames[0]!.outcome

    expect(outcome._tag === "settled" && outcome.transition._tag === "complete" && outcome.transition.output)
      .toBe("null")
  })

  it("lets the first intent call win, because it took effect where it was called", async () => {
    const frames = await session(["ctx.done('first')\nctx.done('second')"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "settled" && outcome.transition._tag === "complete" && outcome.transition.output)
      .toBe("first")
  })

  it("stops dispatching calls once a cell has completed, and says why", async () => {
    // The guard shape the contract teaches puts `ctx.done` in the middle of a
    // cell. What follows it must not run — the run is over — and must not throw,
    // because a throw would discard a frame that had already finished the run.
    const frames = await session([
      "ctx.done('the check passes')\nconst after = await ctx.call('echo', { ask: 1 })\nconsole.log(after.ok, after.error.code)"
    ])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "settled" && outcome.transition._tag).toBe("complete")
    expect(frames[0]!.prints).toBe("false run_completed")
  })

  it("stops dispatching calls after a park too", async () => {
    const frames = await session([
      "ctx.park('waiting-input', 'which branch?')\nconst after = await ctx.call('echo', { ask: 1 })\nconsole.log(after.error.hint)"
    ])
    expect(frames[0]!.outcome._tag === "settled" && frames[0]!.outcome.transition._tag).toBe("park")
    expect(frames[0]!.prints).toContain("guard the ctx.done or ctx.park")
  })

  it("runs the rest of a completed cell's own code out harmlessly", async () => {
    const frames = await session([
      "const tally = [1, 2, 3]\nif (tally.length === 3) ctx.done('three')\nconst doubled = tally.map(n => n * 2)\nconsole.log(doubled)"
    ])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "settled" && outcome.transition._tag === "complete" && outcome.transition.output)
      .toBe("three")
    expect(frames[0]!.prints).toBe("[2,4,6]")
  })

  it("clears the seal for the retry of a frame whose park was refused", async () => {
    // A park with a reason outside the three is rejected and the SAME frame is
    // asked again. A realm still sealed from the refused attempt would answer
    // that retry with `run_completed` for every call it made.
    const frames = await session([
      "ctx.park('tea-break', 'later')\nawait ctx.call('echo', { ask: 1 })",
      "const answer = await ctx.call('echo', { ask: 2 })\nconsole.log(answer)"
    ])
    expect(frames[0]!.outcome._tag).toBe("rejected")
    expect(frames[1]!.prints).toBe(`{"seen":{"ask":2}}`)
  })

  it("does not seal a completion the realm refused to encode", async () => {
    const frames = await session([
      "try { ctx.done(function () {}) } catch (error) { console.log('refused') }\nconst answer = await ctx.call('echo', { ask: 3 })\nconsole.log(answer.seen.ask)"
    ])
    expect(frames[0]!.outcome._tag === "settled" && frames[0]!.outcome.transition._tag).toBe("continue")
    expect(frames[0]!.prints).toBe("refused\n3")
  })

  it("settles a park from ctx.park", async () => {
    const frames = await session(["ctx.park('waiting-input', 'which branch?')"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "settled" && outcome.transition._tag).toBe("park")
  })

  it("refuses a park whose reason is not one of the three", async () => {
    const frames = await session(["ctx.park('tea-break', 'later')"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag).toBe("rejected")
    expect(outcome._tag === "rejected" && outcome.message).toContain("waiting-input")
  })

  it("carries a justification on the continue a quiet cell settles", async () => {
    const frames = await session(["ctx.justify('the failing assertion is still unread')"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "settled" && outcome.transition._tag === "continue" && outcome.transition.justification)
      .toBe("the failing assertion is still unread")
  })

  it("ends a turn when a cell calls nothing", async () => {
    const frames = await session(["const noted = 1"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "settled" && outcome.transition._tag).toBe("continue")
  })

  it("refuses a top-level return in the frame that wrote it", async () => {
    const frames = await session(["return { intent: 'continue' }"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag).toBe("rejected")
    expect(outcome._tag === "rejected" && outcome.message).toContain("ctx.done")
  })

  it("refuses a non-serializable completion output by name", async () => {
    const frames = await session(["ctx.done(function () {})"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag).toBe("raised")
    expect(outcome._tag === "raised" && outcome.message).toContain("ctx.done output")
  })

  it("charges each frame its own step budget and survives spending one", async () => {
    const frames = await session([
      "let spun = 0\nwhile (spun < 5000000) spun = spun + 1",
      "console.log('still here')"
    ], { limits: { steps: 200 } })
    expect(frames[0]!.outcome._tag).toBe("rejected")
    expect(frames[1]!.prints).toBe("still here")
  })

  it("keeps the realm alive after a heap exhaustion and frees it by assignment", async () => {
    const frames = await session([
      "var big = []\ntry { while (true) big.push('x'.repeat(1024)) } catch (error) { console.log(error.name) }",
      "console.log('the frame the budget refuses')",
      "big = null\nconsole.log('recovered')"
    ], { limits: { memoryBytes: 4 * 1024 * 1024 } })
    // The ceiling reaches the cell as an ordinary throw it can catch, and every
    // name the cell had already bound is still bound after it.
    expect(frames[0]!.prints).toContain("Error")
    // What that cell kept is what the run is now over its ceiling by, so the
    // next frame is refused — naming `big`, which is the name the frame after
    // it assigns over.
    expect(frames[1]!.outcome._tag === "rejected" && frames[1]!.outcome.code).toBe("limit_exceeded")
    expect(frames[1]!.outcome._tag === "rejected" && frames[1]!.outcome.message).toContain("big (")
    expect(frames[2]!.prints).toBe("recovered")
  })

  it("counts an aliased object once per reference, which over-states rather than under-states", async () => {
    // Deliberate, and stated here so a later reader does not "fix" it: the walk
    // detects cycles from the ancestors of the value it is on, not from a set of
    // everything it has seen, because allocating a Set inside a realm at its
    // heap ceiling aborts the runtime at teardown. Two references to one object
    // are therefore weighed twice. A ceiling that errs toward refusing is the
    // safe direction, and the refusal is spent where it lands, so the frame
    // after it runs and can restructure.
    const frames = await session([
      `var shared = { payload: "x".repeat(2 * 1024 * 1024) }
       var aliases = [shared, shared]`,
      "console.log('measured')"
    ], { limits: { memoryBytes: 8 * 1024 * 1024, steps: Number.MAX_SAFE_INTEGER } })

    // 2 MiB held once, aliased twice, weighed as 3 x 2 MiB against an 8 MiB
    // ceiling: still under it, and visibly more than the realm holds.
    expect(frames[1]!.outcome._tag).toBe("settled")
    expect(named(frames[0]!.bindings, "aliases")).toBeDefined()
  }, 60_000)

  it("weighs a cyclic object without hanging or exhausting the node budget", async () => {
    const frames = await session([
      "var cycle = { label: 'root' }\ncycle.self = cycle",
      "console.log('cycle measured')"
    ], { limits: { steps: Number.MAX_SAFE_INTEGER } })

    expect(frames[1]!.outcome._tag).toBe("settled")
    expect(frames[1]!.prints).toBe("cycle measured")
  })

  it("never invokes a global accessor while probing the realm", async () => {
    const frames = await session([
      `var getterCalled = false
       Object.defineProperty(globalThis, "x", {
         configurable: true,
         get: function () { getterCalled = true; throw new Error("nope") }
       })`,
      "console.log(String(getterCalled))"
    ])

    expect(frames[0]!.outcome._tag).toBe("settled")
    expect(named(frames[0]!.bindings, "x")).toMatchObject({ type: "accessor" })
    expect(frames[1]!.prints).toBe("false")
  })

  it("gives a cell no way to answer reflection with a trap instead of its own keys", async () => {
    // The last hole in the weighing, closed by removing the capability rather
    // than by measuring around it. Every read the probe makes goes through the
    // intrinsics it captured before any cell ran, which stops a cell rebinding
    // `Object`, and every property comes off its own descriptor, which stops a
    // getter running. Neither defence survives a value that IS the trap: a proxy
    // answers `getOwnPropertyNames` from its handler, so before `Proxy` was
    // removed this exact payload — 8 MiB of live string under a 4 MiB ceiling —
    // weighed as an empty object and the next frame ran.
    //
    // Both halves are asserted, because the second is what makes the first worth
    // anything: the constructor is gone, AND the payload it would have hidden is
    // weighed and refused when it is bound in the open. The chunk loop is there
    // because `setMemoryLimit` does refuse one allocation wider than the whole
    // ceiling; what it never sees is the accumulation.
    const build = `var target = { chunks: [] }
       for (var index = 0; index < 128; index++) target.chunks.push("x".repeat(64 * 1024))`
    const limits = {
      memoryBytes: 4 * 1024 * 1024,
      steps: Number.MAX_SAFE_INTEGER,
      timeMs: 60_000
    }

    const trapped = await session([
      `${build}
       var hidden = new Proxy(target, { ownKeys: function () { return [] } })`
    ], { limits })
    const raised = trapped[0]!.outcome

    expect(raised._tag).toBe("raised")
    expect(raised._tag === "raised" && raised.name).toBe("ReferenceError")
    expect(raised._tag === "raised" && raised.message).toContain("Proxy")

    const open = await session([
      build,
      "console.log('refused')",
      "target = undefined\nconsole.log('recovered')"
    ], { limits })
    const refusal = open[1]!.outcome

    expect(open[0]!.outcome._tag).toBe("settled")
    expect(refusal).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
    expect(refusal._tag === "rejected" && refusal.message).toContain("target")
    expect(open[2]!.prints).toBe("recovered")
  }, 60_000)

  it("refuses a realm whose node budget cannot measure one root, then lets the freeing frame run", async () => {
    const frames = await session([
      `var tooWide = []
       for (var index = 0; index < 200100; index++) tooWide.push({})`,
      "console.log('refused')",
      "tooWide = undefined\nconsole.log('recovered')"
    ], {
      limits: {
        memoryBytes: Sandbox.defaultLimits.memoryBytes,
        steps: Number.MAX_SAFE_INTEGER,
        timeMs: 60_000
      }
    })
    const refusal = frames[1]!.outcome

    expect(refusal).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
    expect(refusal._tag === "rejected" && refusal.message).toContain("tooWide")
    expect(refusal._tag === "rejected" && refusal.message).toContain("too large to measure")
    expect(frames[1]!.prints).toBe("")
    expect(frames[2]!.prints).toBe("recovered")
  }, 60_000)

  it("refuses a root that exceeds the probe's depth ceiling", async () => {
    const frames = await session([
      `var tooDeep = {}
       var cursor = tooDeep
       for (var depth = 0; depth < 40; depth++) { cursor.next = {}; cursor = cursor.next }`,
      "console.log('refused')"
    ], { limits: { steps: Number.MAX_SAFE_INTEGER } })
    const refusal = frames[1]!.outcome

    expect(refusal).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
    expect(refusal._tag === "rejected" && refusal.message).toContain("tooDeep")
    expect(refusal._tag === "rejected" && refusal.message).toContain("too large to measure")
  })

  /** Two strings each under the ceiling, together over it. */
  const accumulate = [
    "var first = 'w'.repeat(3 * 1024 * 1024)",
    "var second = 'w'.repeat(3 * 1024 * 1024)"
  ]

  it("spends the memory refusal on the frame it lands in, so the freeing cell runs", async () => {
    const frames = await session([
      ...accumulate,
      "console.log('this frame is refused')",
      "second = null\nconsole.log('freed')",
      "console.log('still open for business')"
    ], { limits: { memoryBytes: 4 * 1024 * 1024 } })
    // Nothing stops either binding cell: the weight is only knowable once the
    // cell that made it has run.
    expect(frames[0]!.outcome._tag).toBe("settled")
    expect(frames[1]!.outcome._tag).toBe("settled")
    // The frame that opens over the ceiling is refused, and the refusal is spent
    // there: it says the next cell runs, and the next cell does.
    const refusal = frames[2]!.outcome
    expect(refusal._tag === "rejected" && refusal.code).toBe("limit_exceeded")
    expect(refusal._tag === "rejected" && refusal.message).toContain("your next cell does run")
    expect(frames[2]!.prints).toBe("")
    // Frame 3 is the freeing cell. It ran, which is the whole point: a refusal
    // that stood would have refused this one too and asked it again to free.
    expect(frames[3]!.prints).toBe("freed")
    // And with the realm back under its ceiling, nothing is refused after it.
    expect(frames[4]!.outcome._tag).toBe("settled")
    expect(frames[4]!.prints).toBe("still open for business")
  })

  it("refuses again when the frame it let through freed nothing", async () => {
    const frames = await session([
      ...accumulate,
      "console.log('this frame is refused')",
      "console.log('and this cell frees nothing')",
      "console.log('so this frame is refused too')"
    ], { limits: { memoryBytes: 4 * 1024 * 1024 } })
    expect(frames[2]!.outcome._tag === "rejected" && frames[2]!.outcome.code).toBe("limit_exceeded")
    expect(frames[3]!.prints).toBe("and this cell frees nothing")
    expect(frames[4]!.outcome._tag === "rejected" && frames[4]!.outcome.code).toBe("limit_exceeded")
  })

  it("reports a cell that awaits something the realm can never settle", async () => {
    const frames = await session(["await new Promise(function () {})"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "rejected" && outcome.code).toBe("stalled")
  })

  it("refuses a cell the boundary parse rejects without touching the realm", async () => {
    const frames = await session(["const broken = (", "console.log('unharmed')"])
    expect(frames[0]!.outcome._tag).toBe("rejected")
    expect(frames[1]!.prints).toBe("unharmed")
  })

  it("stops a cell at its flow-call ceiling", async () => {
    const frames = await session([
      "await ctx.call('echo', { n: 1 })\nawait ctx.call('echo', { n: 2 })"
    ], { limits: { calls: 1 } })
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "rejected" && outcome.code).toBe("limit_exceeded")
  })

  it("gives up the frame at the whole-evaluation ceiling", async () => {
    // The handler reports that the frame is already running before the clock
    // moves at all; the test clock then holds the frame 1 ms short of its
    // ceiling and crosses it, so the reading is the ceiling, not host speed.
    const outcome = await Effect.gen(function*() {
      const dispatched = yield* Deferred.make<void>()
      const sandbox = yield* QuickJSSandbox.make
      const realm = yield* sandbox.openRealm!({ flows, limits: { totalMs: 10, callMs: 5000 } })
      const fiber = yield* realm.evaluate({
        cell: Cell.source("await ctx.call('echo', { slow: true })"),
        frame: 0,
        call: () => Deferred.succeed(dispatched, undefined).pipe(Effect.andThen(Effect.never))
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(dispatched)
      yield* TestClock.adjust(9)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      return (yield* Fiber.join(fiber)).outcome
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise)
    expect(outcome).toStrictEqual(
      new Cell.Rejected({
        code: "limit_exceeded",
        message: "This cell exceeded its wall-clock limit of 10 milliseconds"
      })
    )
  })

  it("hands a failed call back as a value the cell can branch on", async () => {
    const frames = await session(["const got = await ctx.call('echo', {})\nconsole.log(got.ok, got.error.code)"], {
      call: () =>
        Effect.succeed(
          new Cell.CallResult({ outcome: "failure", value: null, code: "unknown_flow", message: "no such flow" })
        )
    })
    expect(frames[0]!.prints).toBe("false unknown_flow")
  })

  it("leaves an inner const scoped to its block", async () => {
    const frames = await session([
      "for (const item of [1, 2]) { const doubled = item * 2 }\nconsole.log(typeof doubled)"
    ])
    expect(frames[0]!.prints).toBe("undefined")
    expect(named(frames[0]!.bindings, "doubled")).toBeUndefined()
    expect(named(frames[0]!.bindings, "item")).toBeUndefined()
  })

  it("refuses a limit it cannot validate before the realm is built", async () => {
    const failure = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.make
      return yield* sandbox.openRealm!({ flows, limits: { steps: -1 } }).pipe(Effect.flip)
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(failure.code).toBe("unsupported")
  })

  it("holds no name of its own in the panel before any cell runs", async () => {
    const frames = await session(["console.log('opened')"])
    expect(frames[0]!.bindings.map((binding) => binding.name)).toEqual([])
  })

  it("reads compute time through the injected synchronous clock, per frame", async () => {
    let now = 0
    const frames = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.makeWithClock
      const realm = yield* sandbox.openRealm!({
        flows,
        limits: { timeMs: 2, steps: Number.MAX_SAFE_INTEGER }
      })
      return [yield* realm.evaluate({ cell: Cell.source("while (true) {}"), frame: 0, call: succeeds })]
    }).pipe(
      Effect.scoped,
      Effect.provideService(QuickJSSandbox.ComputeClock, { now: () => now++ }),
      Effect.runPromise
    )
    expect(frames[0]!.outcome).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
  })

  it("fails to open at all when the prelude cannot fit the heap", async () => {
    // A prelude that cannot be installed is the binding failing at its job, not
    // a cell failing at its own, so it travels in the error channel.
    const wide: Record<string, Cell.FlowProjection> = {}
    for (let index = 0; index < 400; index++) {
      wide[`flow${index}`] = new Cell.FlowProjection({
        name: `flow${index}`,
        description: "z".repeat(8192),
        capabilities: [],
        tier: "sealed",
        placement: Option.none(),
        input: Option.none()
      })
    }
    const failure = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.make
      return yield* sandbox.openRealm!({
        flows: wide,
        limits: { memoryBytes: Sandbox.minimumMemoryBytes, steps: Number.MAX_SAFE_INTEGER }
      }).pipe(Effect.flip)
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(failure).toMatchObject({ code: "runtime_failed", message: "The sandbox prelude failed to install" })
  })

  it("refuses zero step and time budgets before they can interrupt realm scaffolding", async () => {
    for (const limits of [{ steps: 0 }, { timeMs: 0 }]) {
      const result = await Effect.gen(function*() {
        const sandbox = yield* QuickJSSandbox.make
        return yield* Effect.result(sandbox.openRealm!({ flows, limits }))
      }).pipe(Effect.scoped, Effect.runPromise)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "unsupported", message: expect.stringContaining(Object.keys(limits)[0]!) }
      })
    }
  })

  it("refuses source the boundary parse accepts and the realm does not", async () => {
    const frames = await session(["function f() { using resource = null; }\nf()"])
    const outcome = frames[0]!.outcome
    expect(outcome).toMatchObject({ _tag: "rejected", code: "compile_failed" })
    expect(outcome._tag === "rejected" && outcome.message).toContain("The cell did not compile:")
  })

  it("hands a call that settled with no value at all back as null", async () => {
    const frames = await session(["const got = await ctx.call('echo', {})\nconsole.log(String(got))"], {
      call: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))
    })
    expect(frames[0]!.prints).toBe("null")
  })

  it("keeps driving a cell whose first call is issued after an await", async () => {
    const frames = await session([
      "await Promise.resolve(1)\nconst late = await ctx.call('echo', { n: 1 })\nconsole.log(late.seen.n)"
    ])
    expect(frames[0]!.prints).toBe("1")
  })

  it("settles every bridge queued behind the call that trips the ceiling", async () => {
    const frames = await session([
      `const all = await Promise.all([ctx.call('echo', { n: 1 }), ctx.call('echo', { n: 2 }), ctx.call('echo', { n: 3 })])`
    ], { limits: { calls: 1 } })
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "rejected" && outcome.code).toBe("limit_exceeded")
  })

  it("keeps reading the panel after a cell replaces the reflection it reads through", async () => {
    const frames = await session([
      "const kept = 'held'",
      "Object.getOwnPropertyNames = null\nconst added = 1"
    ])
    expect(named(frames[0]!.bindings, "kept")).toBeDefined()
    // The probe holds the intrinsics a fresh realm had, so the frame that broke
    // reflection for its own later code is still the frame whose new name the
    // panel reports. A panel that read `Object` at call time would have gone
    // silent here, and gone silent for the rest of the run.
    expect(named(frames[1]!.bindings, "added")?.type).toBe("number")
    expect(named(frames[1]!.bindings, "kept")).toBeDefined()
  })

  it("keeps the last panel it could read when a cell spends the budget the probe shares", async () => {
    let now = 0
    let tick = 0
    const frames = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.makeWithClock
      const realm = yield* sandbox.openRealm!({
        flows,
        limits: { timeMs: 5, steps: Number.MAX_SAFE_INTEGER }
      })
      // Wide enough that weighing it costs the interpreter real time, which is
      // what puts the probe inside the budget the cell has already spent.
      const first = yield* realm.evaluate({
        cell: Cell.source(
          "const kept = 'held'\nvar wide = []\nfor (var index = 0; index < 100000; index++) wide.push(index)"
        ),
        frame: 0,
        call: succeeds
      })
      tick = 100
      const second = yield* realm.evaluate({
        cell: Cell.source("var added = 1\nwhile (true) {}"),
        frame: 1,
        call: succeeds
      })
      return [first, second]
    }).pipe(
      Effect.scoped,
      Effect.provideService(QuickJSSandbox.ComputeClock, { now: () => (now += tick) }),
      Effect.runPromise
    )
    expect(named(frames[0]!.bindings, "kept")).toBeDefined()
    expect(frames[1]!.outcome._tag).toBe("rejected")
    // The frame's interrupt is still raised when the probe runs, so the reading
    // is the previous frame's. Nothing false is said; nothing new can be.
    expect(frames[1]!.bindings).toEqual(frames[0]!.bindings)
  })

  it("goes on serving ctx.call and console.log to a cell that rebound an intrinsic", async () => {
    const frames = await session([
      "const Object = { gone: true }\nconst JSON = 1",
      "const answer = await ctx.call('echo', { n: 7 })\nconsole.log('still here', answer)"
    ])
    // Under a realm that outlives the cell, one top-level declaration of a name
    // the host's own realm-side code reads through would have killed every
    // later frame of the run with `TypeError: not a function`. The prelude binds
    // what it needs before any cell runs, so the cost of shadowing `Object` is
    // the cell's own code and nothing else.
    expect(frames[0]!.outcome._tag).toBe("settled")
    expect(frames[1]!.outcome._tag).toBe("settled")
    expect(frames[1]!.prints).toBe(`still here {"seen":{"n":7}}`)
  })

  it("names a value JSON cannot walk instead of printing [object Object]", async () => {
    const frames = await session([
      "var loop = { name: 'root' }\nloop.self = loop\nconsole.log(loop)"
    ])
    expect(frames[0]!.prints).toContain("unprintable object")
    expect(frames[0]!.prints).toContain("still bound")
    expect(frames[0]!.prints).not.toContain("[object Object]")
  })

  it("bounds what the host keeps while a cell prints, and says how much it dropped", async () => {
    const frames = await session([
      `var chunk = 'p'.repeat(1024)\nfor (var index = 0; index < 4000; index++) console.log(chunk)`
    ], { limits: { steps: 100_000 } })
    expect(frames[0]!.outcome._tag).toBe("settled")
    expect(frames[0]!.prints).toContain("further print statements were not kept")
    // The model still reads a frame-sized buffer; what changed is that the host
    // stopped copying payloads out of the sandbox once it had one.
    expect(frames[0]!.prints.length).toBeLessThan(Sandbox.printFrameBytes * 2)
  })
})

describe("Sandbox.replTransition", () => {
  it("produces the minimal continuation contract", () => {
    const transition = Sandbox.replTransition(undefined, undefined)
    expect(transition).toEqual(new Cell.Continue({ justification: undefined }))
    expect(Schema.encodeUnknownSync(Cell.Transition)(transition)).toBeDefined()
  })
})

describe("CellValidation.normalize", () => {
  const normalized = (text: string): string => CellValidation.normalize(text)

  it("moves only the keyword of a top-level declaration", () => {
    expect(normalized("const a = 1")).toBe("var a = 1")
    expect(normalized("let b = 2")).toBe("var b = 2")
    expect(normalized("const { x, y = 2 } = source")).toBe("var { x, y = 2 } = source")
    expect(normalized("let p = 1, q = 2")).toBe("var p = 1, q = 2")
  })

  it("gives an uninitialized declaration an explicit undefined, so re-declaring clears it", () => {
    expect(normalized("let held")).toBe("var held = undefined")
    expect(normalized("let one = 1, two")).toBe("var one = 1, two = undefined")
  })

  it("binds a top-level class to a name a later cell may rebind", () => {
    expect(normalized("class Widget { run() {} }")).toBe("var Widget = class Widget { run() {} };")
  })

  it("leaves a top-level function alone, because it already redeclares", () => {
    expect(normalized("function f() { const inner = 1; return inner }"))
      .toBe("function f() { const inner = 1; return inner }")
  })

  it("leaves every nested declaration exactly as written", () => {
    const nested = "if (true) {\n  const inner = 1\n}\nfor (const item of list) { let seen = item }"
    expect(normalized(nested)).toBe(nested)
  })

  it("changes nothing in a cell that declares nothing at the top level", () => {
    expect(normalized("await ctx.call('echo', {})")).toBe("await ctx.call('echo', {})")
  })

  it("erases type-only syntax before it normalizes, so a typed cell persists too", () => {
    const validated = CellValidation.validate(Cell.source("const total: number = 1", "typescript"))
    expect(validated.compiled).toContain("var total = 1")
  })

  it("refuses a return the realm could not compile, wherever the cell put it", () => {
    const nested = CellValidation.validate(Cell.source("if (ready) {\n  return { intent: 'continue' }\n}"))
    expect(nested.rejected?.code).toBe("compile_failed")
    expect(nested.rejected?.message).toContain("line 2")
  })

  /**
   * The realm's own two names, in every shape a top-level declaration takes.
   *
   * The refusal is what keeps the normalization honest: a top-level `const ctx`
   * becomes a `var ctx`, and a `var` over an existing global assigns rather than
   * shadows, so without this the declaration would take `ctx.call` away from
   * every later cell of the run.
   */
  it.each([
    ["a const", "const ctx = 1", "ctx"],
    ["a let", "let console = 1", "console"],
    ["a function", "function ctx() {}", "ctx"],
    ["a class", "class console {}", "console"],
    ["an object pattern", "const { ctx } = { ctx: 1 }", "ctx"],
    ["a nested object pattern", "const { a: { console: console } } = { a: { console: 1 } }", "console"],
    ["an array pattern with a hole", "const [, ctx] = [1, 2]", "ctx"]
  ])("refuses %s that claims the realm's own binding", (_shape, text, name) => {
    const refused = CellValidation.validate(Cell.source(text))
    expect(refused.rejected?.code).toBe("compile_failed")
    expect(refused.rejected?.message).toContain(`may not declare \`${name}\``)
  })

  it("leaves a nested declaration of the realm's names alone, because it shadows nothing", () => {
    const nested = CellValidation.validate(
      Cell.source("function scope() {\n  const ctx = 1\n  return ctx\n}\nvar out = scope()")
    )
    expect(nested.rejected).toBeUndefined()
  })
})

describe("the REPL contract's worked example", () => {
  /**
   * A model imitates the example, so the example has to be code that runs.
   *
   * The two cells the contract shows are extracted from the rendered text and
   * evaluated against a real realm, with a handler standing in for the flows
   * they name. Nothing here checks prose: it checks that the second cell reads
   * names the first one bound, that the failed-call branch the comment promises
   * is the branch that runs, and that the run finishes through `ctx.done` —
   * which is the whole shape the example is teaching.
   */
  const shown = {
    grep: projection("grep"),
    read: projection("read"),
    bash: projection("bash"),
    edit: projection("edit")
  }

  it("runs, in order, in the realm it is written for", async () => {
    const contract = CellPrompt.make(shown).find((section) => section.id === "cell-contract")?.text ?? ""
    const blocks = [...contract.matchAll(/```cell\n([\s\S]*?)```/g)].map((match) => match[1]!)
    expect(blocks).toHaveLength(2)

    // Two trees, which is the whole point of the example: the edit lands on the
    // live one and the baseline is taken against `ctx.base`, so the probe still
    // reports a failure from the tree the run opened on while the edit stands.
    let edited = false
    const stubbed: Sandbox.Handler = (invocation) =>
      Effect.sync(() => {
        const value = ((): unknown => {
          switch (invocation.flow) {
            case "grep":
              return { ok: true, matches: [{ file: "src/units/widen.ts", line: 42, text: "  return value" }] }
            case "read":
              return { content: "line one\n  return value\nline three" }
            case "bash": {
              const fixed = invocation.at === undefined && edited
              return { stdout: fixed ? "1 passed" : "1 failed", exitCode: fixed ? 0 : 1 }
            }
            case "edit":
              edited = true
              return { ok: true, hunk: "-  return value\n+  return widen(value)" }
            default:
              return null
          }
        })()
        return new Cell.CallResult({ outcome: "success", value: value as never })
      })

    const frames = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.make
      const realm = yield* sandbox.openRealm!({ flows: shown })
      const out: Array<Sandbox.RealmFrame> = []
      for (const [index, text] of blocks.entries()) {
        out.push(yield* realm.evaluate({ cell: Cell.source(text), frame: index, call: stubbed }))
      }
      return out
    }).pipe(Effect.scoped, Effect.runPromise)

    // The recon cell settles, binds every name the second cell reads, and prints
    // the bytes the edit is chosen from.
    expect(frames[0]!.outcome._tag).toBe("settled")
    expect(frames[0]!.bindings.map((binding) => binding.name)).toEqual(["found", "hit", "region"])
    expect(frames[0]!.prints).toContain("return value")

    // The fix-and-prove cell is the guard shape end to end: the edit lands, the
    // baseline probe reports a failure from `ctx.base`, the identical probe
    // passes on the live tree, and the completion is behind a check of the two
    // exit codes rather than in front of them. No call reverts anything: the
    // one and only `edit` in the whole example is the one that stands.
    const fix = blocks[1]!
    expect([...fix.matchAll(/ctx\.call\("edit"/g)]).toHaveLength(1)
    expect(fix).not.toMatch(/git (checkout|restore|stash|reset)/)
    const finished = frames[1]!.outcome
    expect(finished._tag === "settled" && finished.transition._tag).toBe("complete")
    expect(finished._tag === "settled" && finished.transition._tag === "complete" && finished.transition.output)
      .toContain("failed before the edit and exits 0 after it")
    expect(frames[1]!.prints).toContain("+  return widen(value)")
    expect(frames[1]!.prints).toContain("1 0")
  })

  it("does not complete when the guard's check fails", async () => {
    // The same second cell, against a tree the edit does not fix. The guard is
    // the whole difference between a run that answers and a run that carries on,
    // and nothing else in the cell changes.
    const contract = CellPrompt.make(shown).find((section) => section.id === "cell-contract")?.text ?? ""
    const blocks = [...contract.matchAll(/```cell\n([\s\S]*?)```/g)].map((match) => match[1]!)
    const stubbed: Sandbox.Handler = (invocation) =>
      Effect.sync(() =>
        new Cell.CallResult({
          outcome: "success",
          value: ((): unknown => {
            switch (invocation.flow) {
              case "grep":
                return { ok: true, matches: [{ file: "src/units/widen.ts", line: 42, text: "  return value" }] }
              case "read":
                return { content: "line one\n  return value\nline three" }
              case "bash":
                return { stdout: "1 failed", exitCode: 1 }
              default:
                return { ok: true, hunk: "-  return value\n+  return widen(value)" }
            }
          })() as never
        })
      )

    const frames = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.make
      const realm = yield* sandbox.openRealm!({ flows: shown })
      const out: Array<Sandbox.RealmFrame> = []
      for (const [index, text] of blocks.entries()) {
        out.push(yield* realm.evaluate({ cell: Cell.source(text), frame: index, call: stubbed }))
      }
      return out
    }).pipe(Effect.scoped, Effect.runPromise)

    const carried = frames[1]!.outcome
    expect(carried._tag === "settled" && carried.transition._tag).toBe("continue")
    expect(frames[1]!.prints).toContain("1 1")
  })
})
