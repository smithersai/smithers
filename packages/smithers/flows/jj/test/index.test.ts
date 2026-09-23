/**
 * The package barrel plus the two layers that exist only as an answer: Bun's
 * reuse of the Node adapter, and the browser's no-module fallback. Neither has
 * behaviour of its own, so the assertions are that they are wired to the thing
 * they claim to be wired to and that they keep the stable identity strings.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { PlatformError } from "effect/PlatformError"
import * as BrowserJj from "../src/browser/BrowserJj.ts"
import * as BunJj from "../src/bun/BunJj.ts"
import * as Index from "../src/index.ts"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

describe("@smthrs/jj barrel", () => {
  it("re-exports the contract flat", () => {
    expect(Object.keys(Index).sort()).toEqual(
      [
        "Jj",
        "JjError",
        "JjErrorCause",
        "JjErrorCode",
        "causeMessageLimit",
        "isJjError",
        "jjError",
        "jjErrorCause",
        "layerNoop",
        "make",
        "makeNoop"
      ].sort()
    )
  })

  /**
   * The tag key is digested into step keys and the error `_tag` round-trips
   * through the journal, so renames here invalidate recorded runs.
   */
  it("pins the identity strings the step-key digest depends on", () => {
    expect(Jj.key).toBe("@smthrs/jj/Jj")
    expect(new Index.JjError({ code: "unknown", message: "x" })._tag).toBe("@smthrs/jj/JjError")
  })
})

describe("BunJj", () => {
  it("reuses the Node adapter rather than shipping a second implementation", () => {
    expect(BunJj.layer).toBe(NodeJj.layer)
    // Both layers, so a Bun host that contains what it spawns contains jj too.
    expect(BunJj.layerSpawner).toBe(NodeJj.layerSpawner)
  })
})

describe("BrowserJj", () => {
  it.effect("reports `not_installed` for every operation, naming the jj command", () =>
    Effect.gen(function*() {
      const jj = yield* (Effect.provide(Jj, BrowserJj.layerUnsupported))
      // The command is the one `BrowserJj.layer` reports for that operation,
      // so the journaled command does not depend on whether wasm was supplied.
      const calls: ReadonlyArray<
        readonly [string, Effect.Effect<unknown, Index.JjFailure | PlatformError>, string]
      > = [
        ["snapshot", jj.snapshot("msg"), "jj snapshot"],
        ["restore", jj.restore("abc"), "jj restore"],
        ["diff", jj.diff("a", "b"), "jj diff"],
        ["workspaceAdd", jj.workspaceAdd("lane", "/tmp/lane"), "jj workspace add"],
        ["workspaceForget", jj.workspaceForget("lane"), "jj workspace forget"],
        ["status", jj.status(), "jj status"],
        ["root", jj.root!("/tmp"), "jj root"],
        ["revert", jj.revert!("abc"), "jj revert"]
      ]

      for (const [method, effect, command] of calls) {
        expect(yield* (Effect.flip(effect))).toMatchObject({
          code: "not_installed",
          module: "BrowserJj",
          method,
          message: "jj is not available in the browser",
          command
        })
      }
    }))
})
