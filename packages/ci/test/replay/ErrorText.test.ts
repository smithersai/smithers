/**
 * Every error the replay can receive, as the program prints it: a failure a part raises (each code, each part), a
 * failure of the file system or of a process (each system error, a bad argument), Effect's own errors, a decoding
 * error, an error of Node, and the values a defect can hold. Each says what it is; none prints `[object Object]`.
 */
import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { reasonOf } from "../../src/cli/Stage.vibe"
import { errorText } from "../../src/contract/Command.vibe"
import { Failure } from "../../src/contract/Parts.vibe"

/** Every tag a system error of the file system or of a process can carry. */
const systemTags = [
  "AlreadyExists",
  "BadResource",
  "Busy",
  "InvalidData",
  "NotFound",
  "PermissionDenied",
  "TimedOut",
  "UnexpectedEof",
  "Unknown",
  "WouldBlock",
  "WriteZero"
] as const satisfies ReadonlyArray<PlatformError.SystemErrorTag>
// A tag Effect adds fails this line until the walk names it.
const everyTag: [Exclude<PlatformError.SystemErrorTag, typeof systemTags[number]>] extends [never] ? true : false = true

class Quiet extends Data.TaggedError("Quiet")<{ readonly path: string; readonly tries: number }> {}

/** The first error a failed Effect holds. */
const errorOf = <E>(effect: Effect.Effect<unknown, E>): unknown => {
  const exit = Effect.runSync(Effect.exit(effect))
  return exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
}

const nodeError = (): unknown => {
  try {
    return readFileSync("/nonexistent/smithers-ci-error-text")
  } catch (cause) {
    return cause
  }
}

/** Each error by name, with a word its text must hold. */
const every: ReadonlyArray<readonly [string, unknown, ReadonlyArray<string>]> = [
  ...Failure.fields.code.literals.flatMap((code) =>
    Failure.fields.part.literals.map((part) =>
      [`Failure ${code} ${part}`, { code, message: `the ${part} failed`, part }, [`the ${part} failed`, code]] as const
    )
  ),
  ...systemTags.map((tag) =>
    [
      `PlatformError ${tag}`,
      PlatformError.systemError({ _tag: tag, module: "FileSystem", method: "remove", pathOrDescriptor: "/tmp/x" }),
      [tag, "FileSystem", "remove", "/tmp/x"]
    ] as const
  ),
  [
    "PlatformError BadArgument",
    PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "no command" }),
    ["BadArgument", "ChildProcess", "spawn", "no command"]
  ],
  ["NoSuchElementError", new Cause.NoSuchElementError(), ["NoSuchElementError"]],
  ["NoSuchElementError with words", new Cause.NoSuchElementError("no commit"), ["no commit"]],
  ["TimeoutError", new Cause.TimeoutError(), ["TimeoutError"]],
  ["IllegalArgumentError", new Cause.IllegalArgumentError("jobs must be above 0"), ["jobs must be above 0"]],
  ["ExceededCapacityError", new Cause.ExceededCapacityError(), ["ExceededCapacityError"]],
  ["UnknownError", new Cause.UnknownError(new Error("deep")), ["UnknownError"]],
  [
    "SchemaError",
    errorOf(Schema.decodeUnknownEffect(Failure)({ code: "nope" })),
    ["SchemaError", "code"]
  ],
  ["a tagged error with no message", new Quiet({ path: "/tmp/deep", tries: 3 }), [
    "Quiet",
    "path: /tmp/deep",
    "tries: 3"
  ]],
  ["an error of Node", nodeError(), ["ENOENT", "/nonexistent/smithers-ci-error-text"]],
  ["a plain tagged value", { _tag: "Gone", paths: ["a", "b"], deep: { _tag: "Inner", at: 2 } }, [
    "Gone",
    "paths: [a, b]",
    "deep: Inner, at: 2"
  ]],
  ["a value with nothing to say", {}, ["an error with no message"]],
  ["an Error with no words", new Error(), ["an error with no message"]],
  ["a string", "a plain value", ["a plain value"]],
  ["undefined", undefined, ["undefined"]]
]

describe("errorText", () => {
  it("names every system error tag", () => {
    expect(everyTag).toBe(true)
  })

  it.each(every)("says what %s is, and never [object Object]", (_, error, words) => {
    const said = errorText(error)
    expect(said).not.toContain("[object Object]")
    expect(said.trim()).not.toBe("")
    for (const word of words) expect(said).toContain(word)
    expect(reasonOf(error)).not.toContain("[object Object]")
  })

  it("gives a field its message already holds once, and the middle of a longer word does not count", () => {
    expect(errorText({ code: "command-failed", message: "could not run in /tmp/smithers-ci-replay-x", part: "replay" }))
      .toBe("could not run in /tmp/smithers-ci-replay-x (code: command-failed, part: replay)")
    expect(errorText({ _tag: "NotFound", message: "NotFound: /tmp/x", path: "/tmp/x" })).toBe("NotFound: /tmp/x")
    // An error of a class other than Error names its class; one whose name was cleared says only its words.
    expect(errorText(new RangeError("too far"))).toBe("too far (RangeError)")
    expect(errorText(Object.assign(new Error("plain words"), { name: "" }))).toBe("plain words")
  })

  it("follows fields no deeper than three values, and leaves out what is not a value", () => {
    const deep = { _tag: "A", b: { _tag: "B", c: { _tag: "C", d: { _tag: "D", e: { _tag: "E" } } } }, f: () => 1 }
    expect(errorText(deep)).toBe("A, b: B, c: C, d: D")
    expect(errorText({ _tag: "Empty", list: [], none: null, flag: false, big: 2n, blank: "" })).toBe(
      "Empty, flag: false, big: 2"
    )
  })

  it("is the fixed phrase for a value that cannot be read", () => {
    const unreadable = Object.defineProperty({}, "message", {
      enumerable: true,
      get: () => {
        throw new Error("no words")
      }
    })
    expect(errorText(unreadable)).toBe("an error with no message")
  })

  it("bounds very large diagnostic fields without regex blowup", () => {
    expect(errorText({ message: "read failed", path: "x".repeat(400) })).toBe(
      "read failed (path: " + "x".repeat(300) + "…)"
    )
    expect(errorText({ message: "E-extra preE E2 [E]", code: "E" })).toBe("E-extra preE E2 [E]")
  })
})
