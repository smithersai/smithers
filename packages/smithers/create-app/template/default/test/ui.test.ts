import type { AppCard } from "@smthrs/create-app/ui"
import * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Context, Effect, Option, Schema } from "effect"
import { describe, expect, test, vi } from "vitest"
import * as Ui from "../tools/ui.ts"

const setup = () => {
  const cards: Array<AppCard> = []
  const collecting = Ui.makeCollecting(cards)
  const sink = { emit: vi.fn(collecting.emit), update: vi.fn(collecting.update) }
  const source = Ui.uiSource(
    Context.make(Ui.CardSink, sink).pipe(
      Context.add(Ui.PaneNames, Ui.makePanes([
        { name: "balance", fullscreen: false },
        { name: "detail", fullscreen: true }
      ]))
    )
  )
  return { cards, sink, source }
}

const invoke = async (
  source: FlowBinding.Source,
  name: string,
  input: Schema.Json,
  session = "execution-first",
  ordinal = 0,
  frame = 0
) => {
  const bindings = await Effect.runPromise(source.bindings())
  const binding = bindings.find((entry) => entry.descriptor.name === name)!
  return Effect.runPromise(binding.run(
    new Cell.Call({
      flowName: name,
      input,
      capabilities: [],
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
      placement: Option.none(),
      identity: new Cell.CallIdentity({ session, frame, cell: "cell", ordinal, declaration: "test", layers: [] })
    })
  ))
}

const paneInput = { name: "balance", props: { eth: "12.5" }, title: "Balance" }

const cardId = (result: Cell.CallResult): string => {
  expect(result.outcome).toBe("success")
  return Schema.decodeUnknownSync(Ui.PaneOutput)(result.value).cardId
}

describe("UI card identity and updates", () => {
  test.each([
    ["ui/pane", paneInput],
    ["ui/html", { html: "<p>Balance</p>" }]
  ] as const)("%s namespaces executions and preserves replay identity", async (name, input) => {
    const { source, cards } = setup()
    const first = cardId(await invoke(source, name, input))
    const second = cardId(await invoke(source, name, input, "execution-second"))
    const replay = cardId(await invoke(source, name, input))
    expect(second).not.toBe(first)
    expect(replay).toBe(first)
    expect(cards.map((card) => card.id)).toEqual([first, second, first])
    expect(cardId(await invoke(source, name, input, "execution-first", 1))).not.toBe(first)
    expect(cardId(await invoke(source, name, input, "execution-first", 0, 1))).not.toBe(first)
  })

  test("render then update replaces the entire card at its existing position", async () => {
    const { source, sink, cards } = setup()
    const first = cardId(await invoke(source, "ui/pane", paneInput))
    const other = cardId(await invoke(source, "ui/html", { html: "<p>Keep</p>" }, "execution-first", 1))
    const updated = cardId(await invoke(source, "ui/pane", {
      cardId: first, name: "detail", props: { eth: "13" }
    }, "execution-second"))
    expect(updated).toBe(first)
    expect(sink.emit).toHaveBeenCalledTimes(2)
    expect(sink.update).toHaveBeenCalledTimes(1)
    expect(cards).toEqual([
      { kind: "pane", id: first, name: "detail", props: { eth: "13" }, fullscreen: true },
      { kind: "html", id: other, html: "<p>Keep</p>" }
    ])
  })

  test("an update with an absent id inserts through the collecting sink", async () => {
    const { source, sink, cards } = setup()
    expect(cardId(await invoke(source, "ui/pane", { ...paneInput, cardId: "restored-card" }))).toBe("restored-card")
    expect(sink.emit).not.toHaveBeenCalled()
    expect(sink.update).toHaveBeenCalledTimes(1)
    expect(cards).toEqual([
      { kind: "pane", id: "restored-card", ...paneInput, fullscreen: false }
    ])
  })

  test("an update still refuses an unregistered pane without changing the card", async () => {
    const { source, sink, cards } = setup()
    const first = cardId(await invoke(source, "ui/pane", paneInput))
    const before = [...cards]
    const result = await invoke(source, "ui/pane", { cardId: first, name: "missing", props: {} }, "execution-first", 1)
    expect(result.code).toBe("flow_failed")
    expect(result.message).toContain("Registered panes: balance, detail")
    expect(sink.update).not.toHaveBeenCalled()
    expect(cards).toEqual(before)
  })
})

describe("ui/html description", () => {
  test("says the frame is sandboxed and never claims a sanitizer", async () => {
    const bindings = await Effect.runPromise(setup().source.bindings())
    const descriptor = JSON.stringify(bindings.find((entry) => entry.descriptor.name === "ui/html")!.descriptor)
    expect(descriptor).not.toMatch(/sanitiz/i)
    expect(descriptor).toContain("scriptless sandboxed frame with no network")
  })
})

describe("collectedCards", () => {
  test("resetCollectedCards empties the array the bound sink appends to", () => {
    Ui.collectedCards.push({ kind: "html", id: "stale", html: "<p>earlier test</p>" })
    Ui.resetCollectedCards()
    expect(Ui.collectedCards).toEqual([])
  })
})
