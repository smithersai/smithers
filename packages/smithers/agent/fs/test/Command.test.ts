import { Flow } from "@smthrs/core"
import { Cause, Effect, Option, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Command from "../src/Command.ts"
import * as FlowInvoker from "../src/FlowInvoker.ts"
import * as CommandLine from "../src/internal/CommandLine.ts"
import * as SchemaBridge from "../src/internal/SchemaBridge.ts"
import * as Route from "../src/Route.ts"
import { makeRoute } from "./helpers.ts"

describe("Command", () => {
  it.each([0, 4_097, 16_384])("parses a %i-character flag value through the public surface", async (length) => {
    const surface = await Effect.runPromise(Command.make([makeRoute("review")]))
    const value = "a".repeat(length)
    const parsed = await Effect.runPromise(surface.parse(`review --tags "${value}" --tags a --number 1`))
    expect(parsed.input).toEqual({ tags: [value, "a"], number: 1 })
    expect(parsed.argv).toEqual(["review", "--tags", value, "--tags", "a", "--number", "1"])
  })

  it("preserves command-token and route-name errors through the public surface", async () => {
    const surface = await Effect.runPromise(Command.make([makeRoute("review")]))
    for (
      const [command, method, description] of [
        [
          `review --tags ${"a".repeat(CommandLine.maximumTokenLength + 1)} --tags a --number 1`,
          "CommandLine.lex",
          `A command token may contain at most ${CommandLine.maximumTokenLength} characters`
        ],
        [
          "a".repeat(Route.maximumRouteNameLength + 1),
          "CommandTree.resolve",
          "The command name exceeds its resource bounds"
        ]
      ] as const
    ) {
      const exit = await Effect.runPromise(Effect.exit(surface.parse(command)))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          code: "resource_limit",
          method,
          description
        })
      }
    }
  })

  it("lexes quotes and escapes before parsing flags", async () => {
    const argv = await Effect.runPromise(
      CommandLine.lex(
        "review --title='fix bug' --number=4821 --tag one --tag=two --no-draft -- --literal value\\ with\\ spaces"
      )
    )
    expect(argv).toEqual([
      "review",
      "--title=fix bug",
      "--number=4821",
      "--tag",
      "one",
      "--tag=two",
      "--no-draft",
      "--",
      "--literal",
      "value with spaces"
    ])
    expect(await Effect.runPromise(CommandLine.parseFlags(argv.slice(1)))).toEqual({
      args: ["--literal", "value with spaces"],
      options: {
        title: "fix bug",
        number: "4821",
        tag: ["one", "two"],
        draft: false
      }
    })
  })

  it("keeps single-quoted text literal and honours escapes elsewhere", async () => {
    expect(await Effect.runPromise(CommandLine.lex("x 'a\\nb' 'C:\\path'"))).toEqual([
      "x",
      "a\\nb",
      "C:\\path"
    ])
    expect(await Effect.runPromise(CommandLine.lex("\"a\\\"b\""))).toEqual(["a\"b"])
    expect(await Effect.runPromise(CommandLine.lex("a\\'b"))).toEqual(["a'b"])
  })

  it("does not evaluate shell syntax", async () => {
    const argv = await Effect.runPromise(CommandLine.lex("review '$HOME' \"$(whoami)\" `uname`"))
    expect(argv).toEqual(["review", "$HOME", "$(whoami)", "`uname`"])
  })

  it("reports unterminated quotes as parse failures", async () => {
    const exit = await Effect.runPromise(Effect.exit(CommandLine.lex("review 'unterminated")))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure) && failure.value.code).toBe("parse_failed")
    }
  })

  it("uses null-prototype option storage and refuses prototype-sensitive names", async () => {
    const parsed = await Effect.runPromise(CommandLine.parseFlags([
      "--safe=one",
      "--safe",
      "two",
      "--safe=three",
      "--no-draft",
      "positional"
    ]))
    expect(parsed).toEqual({
      args: ["positional"],
      options: { safe: ["one", "two", "three"], draft: false }
    })
    expect(Object.getPrototypeOf(parsed.options)).toBeNull()
    expect(Object.isFrozen(parsed.options)).toBe(true)

    for (
      const argv of [
        ["--constructor=secret"],
        ["--__proto__", "secret"],
        ["--no-constructor"],
        ["--prototype"],
        ["--=true"],
        ["--bad.name=x"]
      ]
    ) {
      const exit = await Effect.runPromise(Effect.exit(CommandLine.parseFlags(argv)))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
        expect(error.code).toBe("parse_failed")
        expect(JSON.stringify(error)).not.toContain("secret")
      }
    }
  })

  it("handles empty tokens and trailing escapes without shell evaluation", async () => {
    expect(await Effect.runPromise(CommandLine.lex("review \"\" tail\\"))).toEqual(["review", "", "tail\\"])
    expect(await Effect.runPromise(CommandLine.lex("   "))).toEqual([])
    expect(await Effect.runPromise(CommandLine.lex("  review  "))).toEqual(["review"])
  })

  it("enforces command, token, and argv resource bounds", async () => {
    expect(await Effect.runPromise(CommandLine.lex("x".repeat(CommandLine.maximumTokenLength)))).toHaveLength(1)
    for (
      const command of [
        "x".repeat(CommandLine.maximumTokenLength + 1),
        `${"x".repeat(CommandLine.maximumTokenLength + 1)} `,
        "x".repeat(CommandLine.maximumCommandBytes + 1),
        "\ud800"
      ]
    ) {
      const exit = await Effect.runPromise(Effect.exit(CommandLine.lex(command)))
      expect(exit._tag).toBe("Failure")
    }

    const exact = Array.from({ length: CommandLine.maximumCommandTokens }, () => "x").join(" ")
    expect(await Effect.runPromise(CommandLine.lex(exact))).toHaveLength(CommandLine.maximumCommandTokens)
    const tooMany = `${exact} x`
    const excess = await Effect.runPromise(Effect.exit(CommandLine.lex(tooMany)))
    expect(excess._tag).toBe("Failure")

    const hostile = new Proxy(["--safe=x"], {
      ownKeys: () => {
        throw new Error("trap")
      }
    })
    expect((await Effect.runPromise(Effect.exit(CommandLine.parseFlags(hostile))))._tag).toBe("Failure")
  })

  it("classifies output schema failures as encoding failures", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(SchemaBridge.encodeOutput(Schema.Number, "not-a-number"))
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure) && failure.value.code).toBe("encode_failed")
    }
  })
})

describe("Command.call decoded boundary", () => {
  afterEach(() => vi.restoreAllMocks())

  const surfaceFor = async (input: Schema.Top, output: Schema.Top) => {
    const flow = Flow.make({ name: "scalar", input, output })
    vi.spyOn(Route, "load").mockReturnValue(Effect.succeed(flow))
    return Effect.runPromise(Command.make([makeRoute("scalar")]))
  }

  it("returns decoded output from call and encoded output from execute", async () => {
    const surface = await surfaceFor(Schema.Number, Schema.NumberFromString)
    const invoker = FlowInvoker.layerNoop({ invoke: () => Effect.succeed(42) })
    expect(await Effect.runPromise(surface.call("scalar", 1).pipe(Effect.provide(invoker)))).toBe(42)
    expect(await Effect.runPromise(surface.execute("scalar 1").pipe(Effect.provide(invoker)))).toBe("42")
  })

  it("accepts decoded transforming input in call and encoded input in execute", async () => {
    const surface = await surfaceFor(Schema.NumberFromString, Schema.Number)
    const invoke = vi.fn(({ input }: FlowInvoker.Invocation) => Effect.succeed(input))
    const invoker = FlowInvoker.layerNoop({ invoke })
    expect(await Effect.runPromise(surface.call("scalar", 42).pipe(Effect.provide(invoker)))).toBe(42)
    expect(await Effect.runPromise(surface.execute("scalar 42").pipe(Effect.provide(invoker)))).toBe(42)
    expect(invoke.mock.calls.map(([invocation]) => invocation.input)).toEqual([42, 42])
    const exit = await Effect.runPromise(Effect.exit(surface.call("scalar", "42").pipe(Effect.provide(invoker))))
    expect(exit._tag).toBe("Failure")
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it("refuses scalar tokens that execute would otherwise drop", async () => {
    const surface = await surfaceFor(Schema.Number, Schema.NumberFromString)
    const invoke = vi.fn(() => Effect.succeed(42))
    const invoker = FlowInvoker.layerNoop({ invoke })
    for (const command of ["scalar 1 --typo x", "scalar 1 2", "scalar 1 --input 2", "scalar --input 1 --typo x"]) {
      const exit = await Effect.runPromise(Effect.exit(surface.execute(command).pipe(Effect.provide(invoker))))
      expect(exit._tag, command).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
        expect(error, command).toMatchObject({ code: "decode_failed" })
      }
    }
    expect(invoke).not.toHaveBeenCalled()
    expect(await Effect.runPromise(surface.execute("scalar --input 1").pipe(Effect.provide(invoker)))).toBe("42")
  })

  it("preserves native decoded values on both sides of call", async () => {
    const surface = await surfaceFor(Schema.DateFromString, Schema.DateFromString)
    const date = new Date("2026-01-01T00:00:00.000Z")
    const invoker = FlowInvoker.layerNoop({ invoke: ({ input }) => Effect.succeed(input) })
    const output = await Effect.runPromise(surface.call("scalar", date).pipe(Effect.provide(invoker)))
    expect(output).toBeInstanceOf(Date)
    expect(output).toEqual(date)
  })

  it("rejects invalid decoded output with a sanitized typed error", async () => {
    const surface = await surfaceFor(Schema.Number, Schema.NumberFromString)
    const exit = await Effect.runPromise(Effect.exit(
      surface.call("scalar", 1).pipe(
        Effect.provide(FlowInvoker.layerNoop({ invoke: () => Effect.succeed("TOP-SECRET") }))
      )
    ))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
      expect(error).toMatchObject({ code: "decode_failed", method: "Command.call" })
      expect(JSON.stringify(error)).not.toContain("TOP-SECRET")
    }
  })
})
