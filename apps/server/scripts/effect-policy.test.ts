import { describe, expect, test } from "bun:test"
import { ALLOWED_FILES, BOUNDARY_MARKER, isProductionModule, scanSource, stripComments } from "./effect-policy"

describe("effect-policy scanSource", () => {
  test("flags each forbidden construct with its line", () => {
    const source = [
      "const a = async () => 1",
      "const b = await a()",
      "promise.then(() => 1)",
      "Effect.runPromise(effect)",
      "Effect.runFork(effect)",
      "runWeb(effect)",
      'import { platform } from "./EffectPlatform"'
    ].join("\n")
    const violations = scanSource("src/thing.ts", source)
    expect(violations.map((v) => [v.line, v.rule])).toEqual([
      [1, "async"],
      [2, "await"],
      [3, ".then("],
      [4, "Effect.runPromise"],
      [5, "Effect.runFork"],
      [6, "runWeb"],
      [7, "EffectPlatform"]
    ])
  })

  test("a clean Effect module passes", () => {
    expect(scanSource("src/thing.ts", "export const x = Effect.gen(function* () { return 1 })\n")).toEqual([])
  })

  test("prose in comments does not count", () => {
    const source = "// no async here, no await, nothing to .then( about\n/* Effect.runPromise is banned */\nconst x = 1\n"
    expect(scanSource("src/thing.ts", source)).toEqual([])
  })

  test("a native Durable Object fetch line marked as a boundary is exempt, and only that line", () => {
    const source = [
      "export class TurnCancelRegistry {",
      `  fetch(request: Request) { return runDurable(turnCancelRequest(request).pipe(Effect.provide(storageLayer(this.ctx.storage)))) } ${BOUNDARY_MARKER}`,
      "  other() { return Effect.runPromise(x) }",
      "}"
    ].join("\n")
    expect(scanSource("src/turns.ts", source).map((v) => v.line)).toEqual([3])
  })

  test("allowlisted boundary files are skipped entirely", () => {
    for (const file of ALLOWED_FILES) expect(scanSource(file, "const x = await y\n")).toEqual([])
  })

  test("tests, declaration files, and files outside src are not production modules", () => {
    expect(isProductionModule("src/thing.test.ts")).toBe(false)
    expect(isProductionModule("src/thing.d.ts")).toBe(false)
    expect(isProductionModule("scripts/deploy.ts")).toBe(false)
    expect(isProductionModule("src/thing.ts")).toBe(true)
    expect(scanSource("src/thing.test.ts", "await x\n")).toEqual([])
  })

  test("stripComments keeps line numbers across block comments", () => {
    const stripped = stripComments("a\n/* one\ntwo */\nawait b\n")
    expect(stripped.split("\n").length).toBe(5)
    expect(scanSource("src/thing.ts", "a\n/* one\ntwo */\nawait b\n").map((v) => v.line)).toEqual([4])
  })
})
