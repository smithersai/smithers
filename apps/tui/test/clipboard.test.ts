import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import * as Clipboard from "../src/clipboard.ts"

const selected = (text: string) => ({ getSelectedText: () => text })

describe("copyOnSelect", () => {
  it("copies a finished selection and reports it", () => {
    const renderer = new EventEmitter()
    const copied: Array<string> = []
    const reported: Array<string> = []
    Clipboard.copyOnSelect(renderer, (text) => (copied.push(text), true), (text) => reported.push(text))
    renderer.emit("selection", selected("Flow grep timed out"))
    expect(copied).toEqual(["Flow grep timed out"])
    expect(reported).toEqual(["Flow grep timed out"])
  })

  it("ignores a click that selected nothing", () => {
    const renderer = new EventEmitter()
    const copied: Array<string> = []
    Clipboard.copyOnSelect(renderer, (text) => (copied.push(text), true), () => {})
    renderer.emit("selection", selected(""))
    renderer.emit("selection", selected("  \n"))
    expect(copied).toEqual([])
  })

  it("does not report a copy the clipboard refused", () => {
    const renderer = new EventEmitter()
    const reported: Array<string> = []
    Clipboard.copyOnSelect(renderer, () => false, (text) => reported.push(text))
    renderer.emit("selection", selected("text"))
    expect(reported).toEqual([])
  })

  it("stops copying after unsubscribe", () => {
    const renderer = new EventEmitter()
    const copied: Array<string> = []
    const stop = Clipboard.copyOnSelect(renderer, (text) => (copied.push(text), true), () => {})
    stop()
    renderer.emit("selection", selected("text"))
    expect(copied).toEqual([])
  })
})
