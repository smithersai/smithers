import { describe, expect, test } from "bun:test"

import { parseCliArgs } from "./args"

describe("parseCliArgs", () => {
  test("returns help when no command is provided", () => {
    expect(parseCliArgs([])).toEqual({
      ok: true,
      command: {
        kind: "help",
      },
    })
  })

  test("parses daemon command", () => {
    expect(parseCliArgs(["daemon"])).toEqual({
      ok: true,
      command: {
        kind: "daemon",
      },
    })
  })

  test("parses start command", () => {
    expect(parseCliArgs(["start"])).toEqual({
      ok: true,
      command: {
        kind: "start",
      },
    })
  })

  test("parses start help", () => {
    expect(parseCliArgs(["start", "--help"])).toEqual({
      ok: true,
      command: {
        kind: "help",
        topic: "start",
      },
    })
  })

  test("rejects removed start web flags", () => {
    expect(parseCliArgs(["start", "--open"])).toEqual({
      ok: false,
      error:
        "The Burns UI was removed from this repo. `burns start` no longer accepts web options; use `burns start` or `burns daemon` with no extra flags.",
    })
  })

  test("rejects removed web command", () => {
    expect(parseCliArgs(["web"])).toEqual({
      ok: false,
      error:
        "The Burns UI was removed from this repo. `burns web` and `burns ui` are no longer available.",
    })
  })

  test("rejects removed ui command", () => {
    expect(parseCliArgs(["ui", "run", "run-123"])).toEqual({
      ok: false,
      error:
        "The Burns UI was removed from this repo. `burns web` and `burns ui` are no longer available.",
    })
  })

  test("rejects unknown command", () => {
    expect(parseCliArgs(["unknown"])).toEqual({
      ok: false,
      error: "Unknown command: unknown",
    })
  })
})
