import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Protocol from "../../../src/closure/zig/Protocol.ts"

const words = (...values: ReadonlyArray<number>): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer)
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const message = (tag: number, ...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const body = Protocol.join(parts)
  return Protocol.join([words(tag, body.length), body])
}

const stepCompleted = 0x8000_0006
const buildCompleted = 0x8000_0004

/** What a real `zig build --listen=-` wrote for the fixture project's five compile steps. */
const recorded = new Uint8Array(readFileSync(new URL("../../fixtures/closure-zig/build-reply.bin", import.meta.url)))

describe("Protocol requests", () => {
  it("asks the build server for steps by index, then to exit", () => {
    expect(Protocol.buildRequest([15, 16])).toEqual(words(0x8000_0000, 16, 2, 0, 15, 16, 0, 0))
    expect(Protocol.buildRequest([])).toEqual(words(0x8000_0000, 8, 0, 0, 0, 0))
  })

  it("asks the compiler for one update, then to exit", () => {
    expect(Protocol.compileRequest).toEqual(words(1, 0, 0, 0))
  })
})

describe("Protocol.decodeBuild", () => {
  it("reads a real reply: the configuration, each step's output and a compile error", () => {
    const reply = Protocol.decodeBuild(recorded)
    expect(reply.configuration).toBe(".zig-cache/c/59d067fc3a6d187a4433d35c46ce3fc9")
    expect(reply.configurationFailed).toBe(false)
    expect(reply.completed).toBe(true)
    expect(reply.steps).toEqual([
      {
        step: 20,
        status: "success",
        problems: [],
        outputs: [{ prefix: "local-cache", path: "o/8d2799b65fcec91a92936c84c3d5759b/words.zig" }]
      },
      {
        step: 18,
        status: "failure",
        problems: [{ message: "unable to load \"missing.zig\": FileNotFound", file: "src/missing.zig" }],
        outputs: []
      },
      {
        step: 19,
        status: "success",
        problems: [],
        outputs: [{ prefix: "local-cache", path: "o/7e9126b3c2a69fe58a3207dfa876333b/hello" }]
      },
      {
        step: 17,
        status: "success",
        problems: [],
        outputs: [{ prefix: "local-cache", path: "o/1fcfe7f1d4a5d3333a3423dbafd9e318/gamma" }]
      },
      {
        step: 16,
        status: "success",
        problems: [],
        outputs: [{ prefix: "local-cache", path: "o/3ffd405d361a75c93c9130469b642676/beta" }]
      },
      {
        step: 15,
        status: "success",
        problems: [],
        outputs: [{ prefix: "local-cache", path: "o/52073c1db88556951f73aed6b76d5646/alpha" }]
      }
    ])
  })

  it("knows a build that stopped early from one that finished", () => {
    const cut = recorded.subarray(0, recorded.length - 20)
    expect(Protocol.decodeBuild(cut).completed).toBe(false)
    expect(Protocol.decodeBuild(cut).steps.length).toBe(5)
    expect(Protocol.decodeBuild(new Uint8Array())).toEqual({
      configuration: undefined,
      configurationFailed: false,
      steps: [],
      completed: false
    })
    // A header that promises more bytes than there are.
    expect(Protocol.decodeBuild(words(buildCompleted, 4)).completed).toBe(false)
  })

  it("reports a build.zig that did not compile", () => {
    expect(Protocol.decodeBuild(message(0x8000_0002, words(0, 0))).configurationFailed).toBe(true)
  })

  it("reads every status, an error with no file and a status it does not know", () => {
    // One error message at word 3: text at byte 1, no source location.
    const bundle = [words(1, 7, 0, 1, 1, 0, 0, 3), bytes("\0no file\0")]
    const reply = Protocol.decodeBuild(Protocol.join([
      message(stepCompleted, words(1, 2, 0, 0, 0)),
      message(stepCompleted, words(2, 3, 0, 0, 0)),
      message(stepCompleted, words(3, 9, 0, 0, 0)),
      message(stepCompleted, words(4, 1, 8, 9, 0), ...bundle)
    ]))
    expect(reply.steps.map((step) => step.status)).toEqual(["skipped", "skipped-oom", "unknown", "failure"])
    expect(reply.steps[3]?.problems).toEqual([{ message: "no file", file: undefined }])
  })

  it("does not read past a body that is shorter than it claims", () => {
    // Claims two outputs and one error but carries neither.
    expect(Protocol.decodeBuild(message(stepCompleted, words(5, 0, 0, 0, 2))).steps).toEqual([
      { step: 5, status: "success", problems: [], outputs: [] }
    ])
    expect(Protocol.decodeBuild(message(stepCompleted, words(5, 1, 3, 0, 0), words(4, 9, 0))).steps[0]?.problems)
      .toEqual([])
    expect(Protocol.decodeBuild(message(stepCompleted, words(6))).steps).toEqual([
      { step: 6, status: "success", problems: [], outputs: [] }
    ])
    // An output with no bytes at all, and an unterminated error text.
    expect(Protocol.decodeBuild(message(stepCompleted, words(7, 0, 0, 0, 1, 0, 0), Uint8Array.of())).steps[0]?.outputs)
      .toEqual([])
    expect(
      Protocol.decodeBuild(message(stepCompleted, words(8, 1, 8, 4, 0), words(1, 7, 0, 1, 1, 0, 0, 3), bytes("\0abc")))
        .steps[0]?.problems
    ).toEqual([{ message: "abc", file: undefined }])
  })
})

describe("Protocol.decodeCompile", () => {
  it("reads the files a compilation read and its errors", () => {
    // Prefixes are sent one higher, so zero can end a path.
    const inputs = message(6, Uint8Array.of(5), bytes("src/beta.zig"), Uint8Array.of(0, 2), bytes("std/std.zig"))
    // One error at word 3 with its location at words 7 to 14: the file name is at byte 5.
    const errors = message(
      1,
      words(16, 15),
      words(1, 15, 0, 1, 1, 7, 0, 5, 0, 0, 0, 0, 0, 0, 0, 3),
      bytes("\0bad\0src/x.zig\0")
    )
    expect(Protocol.decodeCompile(Protocol.join([message(0, bytes("0.17.1")), inputs, errors]))).toEqual({
      inputs: [{ prefix: "build-root", path: "src/beta.zig" }, { prefix: "zig-lib", path: "std/std.zig" }],
      problems: [{ message: "bad", file: "src/x.zig" }]
    })
  })

  it("says so when the compiler reported no files", () => {
    expect(Protocol.decodeCompile(new Uint8Array())).toEqual({ inputs: undefined, problems: [] })
    expect(Protocol.decodeCompile(message(1, words(0, 0)))).toEqual({ inputs: undefined, problems: [] })
  })

  it("gives an entry with no prefix byte an unknown prefix", () => {
    expect(Protocol.decodeCompile(message(6, Uint8Array.of(5), bytes("a"), Uint8Array.of(0))).inputs).toEqual([
      { prefix: "build-root", path: "a" },
      { prefix: "unknown", path: "" }
    ])
  })
})

describe("Protocol bytes", () => {
  it("joins chunks and reads UTF-8", () => {
    expect(Protocol.join([Uint8Array.of(1), new Uint8Array(), Uint8Array.of(2, 3)])).toEqual(Uint8Array.of(1, 2, 3))
    expect(Protocol.join([])).toEqual(new Uint8Array())
    expect(Protocol.utf8(bytes("zig ⚡"))).toBe("zig ⚡")
  })
})
