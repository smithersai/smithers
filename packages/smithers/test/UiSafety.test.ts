import { Effect } from "effect"
import { PassThrough, Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Ui from "../src/Ui.ts"

describe("plain terminal safety", () => {
  it("removes supplied terminal controls across plain renderers", async () => {
    const chunks: Array<string> = []
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk))
        callback()
      }
    })
    const ui = Ui.make({ output, interactive: false })
    const supplied = "safe\u001b[2J\u001b]0;owned\u0007text\rdeny\ballow\u0007\u0085\u009f\u202e\u2066\n\tnext\r\nlast"
    await Effect.runPromise(Effect.gen(function*() {
      yield* ui.info(supplied)
      yield* ui.note(supplied, supplied)
      yield* ui.checklist(supplied, [{ name: supplied, detail: supplied, level: "ok" }])
      ui.spinner().start(supplied)
      yield* ui.confirm({ message: supplied, nonInteractive: false })
      yield* ui.pickSuggestion([supplied], { message: supplied, label: (value) => value })
      yield* ui.streamSuggestions(
        (async function*() {
          yield supplied
        })(),
        { label: (value) => value }
      )
    }))
    expect(chunks.join("")).not.toMatch(/(?![\n\t])[\p{Cc}\p{Cf}]/u)
    expect(chunks.join("")).toContain("safetextdenyallow\n\tnext\nlast")
  })
})

describe("stream ownership", () => {
  for (const failure of ["label", "output"] as const) {
    it(`closes the iterator when ${failure} throws`, async () => {
      let closed = false
      async function* source() {
        try {
          yield "item"
          yield "later"
        } finally {
          closed = true
        }
      }
      const output = new Writable({
        write(_chunk, _encoding, callback) {
          if (failure === "output") throw new Error("output failed")
          callback()
        }
      })
      const exit = await Effect.runPromiseExit(
        Ui.make({ output, interactive: false }).streamSuggestions(source(), {
          label: (value) => {
            if (failure === "label") throw new Error("label failed")
            return value
          }
        })
      )
      expect(exit._tag).toBe("Failure")
      expect(closed).toBe(true)
    })
  }
})

describe("prompt ownership", () => {
  for (const kind of ["pick", "confirm", "text"] as const) {
    it(`removes ${kind} input listeners on interruption`, async () => {
      const input = new PassThrough()
      let rendered!: () => void
      const ready = new Promise<void>((resolve) => {
        rendered = resolve
      })
      const output = new Writable({
        write(_chunk, _encoding, callback) {
          rendered()
          callback()
        }
      })
      const ui = Ui.make({ output, input, interactive: true })
      const controller = new AbortController()
      const effect: Effect.Effect<unknown> = kind === "pick" ?
        ui.pickSuggestion(["one"], { message: "Pick", label: (value) => value })
        : kind === "confirm"
        ? ui.confirm({ message: "Confirm", nonInteractive: false })
        : ui.text("Text")
      const running = Effect.runPromiseExit(effect, { signal: controller.signal })
      await ready
      controller.abort()
      await running
      expect(input.listenerCount("keypress")).toBe(0)
      expect(output.listenerCount("resize")).toBe(0)
      input.destroy()
      output.destroy()
    })
  }
})
