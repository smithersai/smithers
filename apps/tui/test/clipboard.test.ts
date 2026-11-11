import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Clipboard from "../src/clipboard.ts"

const selected = (text: string) => ({ getSelectedText: () => text })

describe("copyOnSelect", () => {
  it("copies a finished selection and reports it", async () => {
    const renderer = new EventEmitter()
    const copied: Array<string> = []
    const reported: Array<string> = []
    Clipboard.copyOnSelect(renderer, (text) => (copied.push(text), true), (text) => reported.push(text))
    renderer.emit("selection", selected("Flow grep timed out"))
    await Bun.sleep(0)
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

  it("reports a copy the clipboard refused as a failure, not a copy", async () => {
    const renderer = new EventEmitter()
    const reported: Array<string> = []
    const failed: Array<string> = []
    Clipboard.copyOnSelect(renderer, async () => false, (text) => reported.push(text), (text) => failed.push(text))
    renderer.emit("selection", selected("text"))
    await Bun.sleep(0)
    expect(reported).toEqual([])
    expect(failed).toEqual(["text"])
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

describe("write", () => {
  it("tries wl-copy under Wayland before the X11 commands", () => {
    expect(Clipboard.commands("linux", { WAYLAND_DISPLAY: "wayland-0" }).map(([command]) => command)).toEqual([
      "wl-copy",
      "xclip",
      "xsel"
    ])
    expect(Clipboard.commands("linux", {}).map(([command]) => command)).toEqual(["xclip", "xsel"])
    expect(Clipboard.commands("darwin", {}).map(([command]) => command)).toEqual(["pbcopy"])
  })

  it("keeps the event loop responsive while the clipboard command waits for release", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tui-clipboard-"))
    const input = join(directory, "input")
    const ready = join(directory, "ready")
    const release = join(directory, "release")
    // The child watchdog bounds a synchronous regression even while the test's timer cannot run.
    const holding = ["sh", [
      "-c",
      "cat > \"$1\"; touch \"$2\"; i=0; while [ $i -lt 200 ]; do [ -e \"$3\" ] && exit 0; sleep 0.05; i=$((i + 1)); done; exit 1",
      "clipboard-test",
      input,
      ready,
      release
    ]] as const
    // Put the holding command first: a missing-command await must not hide a synchronous call.
    const pending = Clipboard.write("copied text\n", [holding])
    let settled = false
    void pending.then(() => {
      settled = true
    })
    try {
      for (let i = 0; i < 500 && !existsSync(ready); i++) await Bun.sleep(10)
      expect(existsSync(ready)).toBe(true)
      await Bun.sleep(20)
      expect(settled).toBe(false)
      expect(readFileSync(input, "utf8")).toBe("copied text\n")
    } finally {
      writeFileSync(release, "")
      await pending
    }
    expect(await pending).toBe(true)
  }, 20_000)

  it("falls through a missing command and reports when none can copy", async () => {
    const input = join(mkdtempSync(join(tmpdir(), "tui-clipboard-")), "input")
    expect(
      await Clipboard.write("fallback text", [
        ["definitely-not-a-clipboard", []],
        ["sh", ["-c", "cat > \"$1\"", "clipboard-test", input]]
      ])
    ).toBe(true)
    expect(readFileSync(input, "utf8")).toBe("fallback text")
    expect(await Clipboard.write("x", [["definitely-not-a-clipboard", []]])).toBe(false)
  })
})
