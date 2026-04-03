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

  test("parses start command with open flag", () => {
    expect(parseCliArgs(["start", "--open"])).toEqual({
      ok: true,
      command: {
        kind: "start",
        openWeb: true,
        webUrl: "http://127.0.0.1:4173",
      },
    })
  })

  test("parses start command with custom web URL", () => {
    expect(parseCliArgs(["start", "--web-url", "http://localhost:5173"])).toEqual({
      ok: true,
      command: {
        kind: "start",
        openWeb: false,
        webUrl: "http://localhost:5173",
      },
    })
  })

  test("parses web command options", () => {
    expect(parseCliArgs(["web", "--host", "0.0.0.0", "--port", "9001", "--open"])).toEqual({
      ok: true,
      command: {
        kind: "web",
        host: "0.0.0.0",
        port: 9001,
        openWeb: true,
      },
    })
  })

  test("rejects invalid web port", () => {
    expect(parseCliArgs(["web", "--port", "abc"])).toEqual({
      ok: false,
      error: "Invalid --port value: abc",
    })
  })

  test("rejects unknown command", () => {
    expect(parseCliArgs(["unknown"])).toEqual({
      ok: false,
      error: "Unknown command: unknown",
    })
  })
})
