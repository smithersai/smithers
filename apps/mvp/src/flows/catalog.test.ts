// The agent's catalog, scoped to the run that asks (src/flows/catalog.ts, decision 0014 §2): reads only while a draft
// is written, a person's flow's own list while one runs, and the whole catalog otherwise. The scope of a run's own
// agent is proved end to end in src/features/flows-ui/flows.test.ts; these are the rules and the failure of the read.
import { Effect, Logger, References } from "effect"
import { describe, expect, test } from "vitest"
import { PROMPT_CATALOG } from "../features/flows-ui/callable"
import { AUTHOR_TOOLS } from "../features/flows-ui/contract"
import { catalogDescription, publicError, scopeFor, scopeOf } from "./catalog"

test("approval-bearing catalog entries tell the agent the call asks the person itself", () => {
  expect(catalogDescription("flow/save")).toContain("Do not call app/agent/ask separately")
  expect(catalogDescription("flow/save")).toContain("Save this draft as your flow?")
  expect(catalogDescription("repo/tree")).not.toContain("Approval:")
})

describe("publicError", () => {
  test("the agent reads a failure's kind and numeric command limit, without its message", () => {
    expect(publicError({ _tag: "@smthrs/mvp/sandbox/SandboxCommandTooLong", maxSeconds: 1800, message: "private" }))
      .toBe("SandboxCommandTooLong: at most 1800 seconds")
    expect(publicError({ _tag: "OtherLimit", maxSeconds: 60 })).toBe("OtherLimit: at most 60 seconds")
  })

  test.each([undefined, null, "1800", { seconds: 1800 }])("a failure without a numeric limit (%s) stays its kind", (maxSeconds) => {
    expect(publicError({ _tag: "@smthrs/mvp/sandbox/SandboxCallRefused", maxSeconds, message: "private" }))
      .toBe("SandboxCallRefused")
  })

  test.each([null, undefined, "private", 1800, {}, { maxSeconds: 1800 }])("an untagged failure (%s) stays failed", (failure) => {
    expect(publicError(failure)).toBe("failed")
  })

  test("a tagged failure without a limit stays its kind", () => {
    expect(publicError({ _tag: "@smthrs/mvp/sandbox/SandboxCallFailed", message: "private" })).toBe("SandboxCallFailed")
  })
})

describe("scopeOf", () => {
  test("a draft's agent reads; a person's flow's agent calls what it lists that a person's flow may call", () => {
    expect(scopeOf("flow/new", undefined)).toEqual(AUTHOR_TOOLS)
    expect(scopeOf("flow/run/prompt", ["app/theme/set", "flow/new", "run/cancel", "nothing/here"])).toEqual([
      "app/theme/set",
    ])
    expect(scopeOf("flow/run/prompt", undefined)).toEqual([])
    expect(scopeOf("chat/Answer", undefined)).toBe("all")
  })
})

describe("scopeFor", () => {
  const read = (payload: unknown) => () => Effect.succeed(payload)

  test("reads a person's flow's list from its pinned payload", async () => {
    expect(await Effect.runPromise(scopeFor("flow/run/prompt", "run-1", read({ allowed: ["app/theme/set"] }))))
      .toEqual(["app/theme/set"])
    expect(await Effect.runPromise(scopeFor("chat/Answer", "run-1", () => Effect.die("never read")))).toBe("all")
  })

  test("a payload without a list, or one that can't be read, leaves the agent nothing to call", async () => {
    expect(await Effect.runPromise(scopeFor("flow/run/prompt", "run-1", read({ name: "x" })))).toEqual([])
    const lines: Array<{ readonly message: unknown; readonly level: string; readonly annotations: unknown }> = []
    const logger = Logger.make(({ message, logLevel, fiber }) =>
      void lines.push({ message: (message as ReadonlyArray<unknown>)[0], level: logLevel, annotations: fiber.getRef(References.CurrentLogAnnotations) }))
    const store = Object.assign(new Error("private store detail"), { _tag: "RunStoreError" })
    expect(await Effect.runPromise(scopeFor("flow/run/prompt", "run-1", () => Effect.fail(store)).pipe(Effect.provide(Logger.layer([logger])))))
      .toEqual([])
    // The read that failed is logged once at Warn by its code, never its message.
    expect(lines).toEqual([
      { message: "flow.scope.read", level: "Warn", annotations: { feature: "flows", outcome: "unreadable", errorCode: "RunStoreError" } },
    ])
    expect(JSON.stringify(lines)).not.toContain("private store detail")
  })
})

describe("what a person's flow may call", () => {
  test("every one carries the description the drafting agent reads, and none is an authoring or run act", () => {
    expect(PROMPT_CATALOG.length).toBeGreaterThan(0)
    for (const entry of PROMPT_CATALOG) {
      expect([entry.name, entry.description.length > 0]).toEqual([entry.name, true])
      expect(entry.name).not.toMatch(/^(flow|run)\//)
    }
  })
})
