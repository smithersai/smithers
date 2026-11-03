/**
 * The current turn's executed cells.
 *
 * A saved flow starts as a script the model already ran, so the loop has to
 * keep that script somewhere. These cases fix what it keeps: one entry per
 * executed cell, in the order the cells ran, and nothing at all for a host
 * that binds no history.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as CellHistory from "../src/CellHistory.ts"

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect)

describe("CellHistory.make", () => {
  it("numbers cells by the order they executed", async () => {
    const history = await run(CellHistory.make)
    await run(history.record("ctx.done(1)"))
    await run(history.record("ctx.done(2)"))

    expect(await run(history.cells())).toEqual([
      { ordinal: 0, source: "ctx.done(1)" },
      { ordinal: 1, source: "ctx.done(2)" }
    ])
  })

  it("reports a snapshot a later cell does not change", async () => {
    const history = await run(CellHistory.make)
    await run(history.record("first"))
    const seen = await run(history.cells())
    await run(history.record("second"))

    expect(seen).toEqual([{ ordinal: 0, source: "first" }])
  })

  it("reports nothing before the first cell runs", async () => {
    const history = await run(CellHistory.make)

    expect(await run(history.cells())).toEqual([])
  })
})

describe("CellHistory.makeCells", () => {
  it("reports the list it was built over and drops what it is told", async () => {
    const history = CellHistory.makeCells([{ ordinal: 0, source: "recorded elsewhere" }])
    await run(history.record("ignored"))

    expect(await run(history.cells())).toEqual([{ ordinal: 0, source: "recorded elsewhere" }])
  })
})

describe("CellHistory.makeNoop", () => {
  it("records nothing and reports nothing", async () => {
    const history = CellHistory.makeNoop()
    await run(history.record("ctx.done(1)"))

    expect(await run(history.cells())).toEqual([])
  })

  it("takes one operation at a time", async () => {
    const history = CellHistory.makeNoop({ cells: () => Effect.succeed([{ ordinal: 3, source: "stubbed" }]) })
    await run(history.record("ctx.done(1)"))

    expect(await run(history.cells())).toEqual([{ ordinal: 3, source: "stubbed" }])
  })
})

describe("CellHistory layers", () => {
  it("provides a recorder", async () => {
    const cells = await run(
      Effect.gen(function*() {
        const history = yield* CellHistory.CellHistory
        yield* history.record("ctx.done(1)")
        return yield* history.cells()
      }).pipe(Effect.provide(CellHistory.layer))
    )

    expect(cells).toEqual([{ ordinal: 0, source: "ctx.done(1)" }])
  })

  it("provides a fixed list", async () => {
    const cells = await run(
      Effect.flatMap(CellHistory.CellHistory, (history) => history.cells()).pipe(
        Effect.provide(CellHistory.layerCells([{ ordinal: 0, source: "fixed" }]))
      )
    )

    expect(cells).toEqual([{ ordinal: 0, source: "fixed" }])
  })

  it("provides a history that keeps nothing", async () => {
    const cells = await run(
      Effect.gen(function*() {
        const history = yield* CellHistory.CellHistory
        yield* history.record("ctx.done(1)")
        return yield* history.cells()
      }).pipe(Effect.provide(CellHistory.layerNoop()))
    )

    expect(cells).toEqual([])
  })
})
