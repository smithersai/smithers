import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { AgentTurnFrameSchema, decodeAgentTurnFrame } from "../src/NativeAgent.ts"
import type { AgentTurnFrame } from "../src/NativeAgent.ts"
import { moduleSpecifiers, sources } from "./SourceGuards.ts"

const parses = (value: unknown): boolean => AgentTurnFrameSchema.safeParse(value).success

const runHistoryCard = {
  id: "history",
  kind: "file",
  title: "Saved file",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: "org/repo", path: "a.ts", content: "Saved", truncated: false }
}

describe("AgentTurnFrame — proxy family", () => {
  /* The frames the client store acts on, one valid instance each. */
  const accepted: ReadonlyArray<readonly [string, unknown]> = [
    ["delta", { runId: "r1", type: "delta", kind: "text", text: "hi" }],
    ["done", { runId: "r1", type: "done", reason: "stop" }],
    ["author revoked", { runId: "r1", type: "done", reason: "cancelled", code: "author_revoked" }],
    /* The chat dispatcher's capacity deferral: the code carries the cause, the sentence is prose. */
    ["host deferred for a full fleet", {
      runId: "r1",
      type: "done",
      code: "host_no_capacity",
      error: "Chat is busy right now. Nothing here was lost; try again in a moment."
    }],
    ["done, cancelled with an error", {
      runId: "r1",
      type: "done",
      reason: "cancelled",
      error: "the user stopped the turn"
    }],
    ["done carrying the call's usage", {
      runId: "r1",
      type: "done",
      reason: "tool_call",
      usage: { inputTokens: 10_000, outputTokens: 120, cachedInputTokens: 9_400 }
    }],
    ["done carrying partial usage", { runId: "r1", type: "done", usage: { outputTokens: 3 } }],
    ["card", { runId: "r1", type: "card", card: runHistoryCard }],
    ["card.update", {
      runId: "r1",
      type: "card.update",
      id: "history",
      patch: { kind: "file", title: "Runs (3)" }
    }],
    ["tool_call", {
      runId: "r1",
      type: "tool_call",
      call_id: "c1",
      name: "files.read",
      arguments: JSON.stringify({ path: "README.md" })
    }],
    ["park carrying a card", { runId: "r1", type: "park", code: "approval", card: runHistoryCard }]
  ]

  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ["a frame without runId", { type: "delta", kind: "text", text: "hi" }],
    ["done with an unknown code", { runId: "r1", type: "done", reason: "cancelled", code: "unknown" }],
    ["done with an unknown reason", { runId: "r1", type: "done", reason: "abandoned" }],
    ["done with negative usage", { runId: "r1", type: "done", usage: { inputTokens: -1 } }],
    ["done with fractional usage", { runId: "r1", type: "done", usage: { outputTokens: 1.5 } }],
    ["done with non-numeric usage", { runId: "r1", type: "done", usage: { cachedInputTokens: "9" } }],
    ["a card of an unknown kind", { runId: "r1", type: "card", card: { ...runHistoryCard, kind: "runs" } }],
    ["a card whose payload misses a required field", {
      runId: "r1",
      type: "card",
      card: { ...runHistoryCard, payload: { repo: "org/repo" } }
    }],
    ["card.update without a kind", { runId: "r1", type: "card.update", id: "history", patch: { title: "Runs (3)" } }],
    ["card.update whose payload contradicts its kind", {
      runId: "r1",
      type: "card.update",
      id: "history",
      patch: { kind: "file", payload: { repo: 5 } }
    }],
    ["tool_call without arguments", { runId: "r1", type: "tool_call", call_id: "c1", name: "files.read" }],
    ["tool_call whose arguments are not a string", {
      runId: "r1",
      type: "tool_call",
      call_id: "c1",
      name: "files.read",
      arguments: { path: "README.md" }
    }],
    ["park carrying a malformed card", {
      runId: "r1",
      type: "park",
      code: "approval",
      card: { ...runHistoryCard, payload: {} }
    }]
  ]

  test("every frame the client store acts on parses", () => {
    expect(accepted.map(([name, value]) => [name, parses(value)])).toEqual(accepted.map(([name]) => [name, true]))
  })

  test("the decoder answers a frame for each of them", () => {
    expect(accepted.map(([name, value]) => [name, decodeAgentTurnFrame(value) !== null]))
      .toEqual(accepted.map(([name]) => [name, true]))
  })

  test("a malformed instance of each frame is rejected", () => {
    expect(rejected.map(([name, value]) => [name, parses(value)])).toEqual(rejected.map(([name]) => [name, false]))
  })

  test("the decoder answers null for each of them", () => {
    expect(rejected.map(([name, value]) => [name, decodeAgentTurnFrame(value)]))
      .toEqual(rejected.map(([name]) => [name, null]))
  })

  test("the decoder keeps a legacy card frame and its recorded payload readable", () => {
    const frame = decodeAgentTurnFrame({ runId: "r1", type: "card", card: { ...runHistoryCard, kind: "run-history" } })
    expect(frame).toEqual({
      runId: "r1",
      type: "card",
      card: {
        ...runHistoryCard,
        kind: "retired",
        status: "acted",
        loading: false,
        payload: { was: "run-history", recorded: runHistoryCard.payload }
      }
    })
  })

  /*
   * The done code is a closed vocabulary, so every code the chat producer
   * seals a turn with has to be in it: a sealed turn whose code this schema
   * lacks rejects its own frame, its turn, and the entries array around it, so
   * one turn ends a whole transcript. `credential_issuer_unavailable` was such
   * a hole — store.go sealed it and the app showed "Conversation unavailable"
   * over every earlier answer. The list is the producers': store.go
   * `stopProducerWith` and author.go `authorRevokedFrame`.
   */
  test("every done code the chat producer seals a turn with decodes", () => {
    const sealed = (code: string) => ({ runId: "r1", type: "done", code, error: "the receipt's own sentence" })
    for (
      const code of [
        "credential_missing",
        "credential_issuer_unavailable",
        "author_revoked",
        "host_no_capacity",
        "chat_guests_busy"
      ]
    ) {
      expect([code, decodeAgentTurnFrame(sealed(code))]).toEqual([code, sealed(code)])
    }
  })

  test("the decoder answers null for a value that is not an object", () => {
    expect(decodeAgentTurnFrame("{}")).toBe(null)
    expect(decodeAgentTurnFrame(null)).toBe(null)
  })
})

describe("AgentTurnFrame — chain family (DESIGN.md §14)", () => {
  const frames: ReadonlyArray<AgentTurnFrame> = [
    { runId: "lineage-1", type: "link.authored", link: 0, scriptDigest: "d0", script: "```flow\nreturn done({})\n```" },
    { runId: "lineage-1", type: "call.started", link: 0, ordinal: 0, name: "grep" },
    { runId: "lineage-1", type: "call.settled", link: 0, ordinal: 0, name: "grep", verdict: "run" },
    {
      runId: "lineage-1",
      type: "call.settled",
      link: 1,
      ordinal: 0,
      name: "grep",
      verdict: "replay",
      resultDigest: "abc"
    },
    { runId: "lineage-1", type: "gate.rejected", link: 1, kind: "catalog", message: "unknown entry: frobnicate" },
    { runId: "lineage-1", type: "link.ended", link: 1, outcome: "to" },
    { runId: "lineage-1", type: "steering.drained", link: 2, count: 1 },
    { runId: "lineage-1", type: "park", code: "approval" }
  ]

  test("every chain frame round-trips through the schema", () => {
    for (const frame of frames) {
      const parsed = AgentTurnFrameSchema.safeParse(frame)
      expect(parsed.success).toBe(true)
      expect(parsed.success && parsed.data).toEqual(frame)
    }
  })

  test("the decoder answers the chain family too", () => {
    for (const frame of frames) expect(decodeAgentTurnFrame(frame)).toEqual(frame)
  })

  test("verdict, gate kind, outcome, and park code are closed vocabularies", () => {
    expect(parses({ runId: "r", type: "call.settled", link: 0, ordinal: 0, name: "x", verdict: "cached" })).toBe(false)
    expect(parses({ runId: "r", type: "gate.rejected", link: 0, kind: "vibes" })).toBe(false)
    expect(parses({ runId: "r", type: "link.ended", link: 0, outcome: "crashed" })).toBe(false)
    expect(parses({ runId: "r", type: "park", code: "nap" })).toBe(false)
  })

  test("link and ordinal are non-negative integers; drained count is positive", () => {
    expect(parses({ runId: "r", type: "link.ended", link: -1, outcome: "done" })).toBe(false)
    expect(parses({ runId: "r", type: "call.started", link: 0, ordinal: 1.5, name: "x" })).toBe(false)
    expect(parses({ runId: "r", type: "steering.drained", link: 0, count: 0 })).toBe(false)
  })

  test("an unknown frame type is rejected", () => {
    expect(parses({ runId: "r", type: "link.rebased", link: 0 })).toBe(false)
  })
})

/*
 * The dependency law of DESIGN.md §14: @smthrs/rpc mirrors chain vocabulary and
 * imports only runtime-free canonical entry points. This keeps the Worker
 * and both bridges free of Effect runtime imports.
 */
const smithersRuntimeImport = (specifier: string): boolean =>
  specifier.startsWith("@smthrs/") &&
  specifier !== "@smthrs/canonical/Record" && specifier !== "@smthrs/canonical/Serializer"
const effectRuntimeImport = (specifier: string): boolean => specifier === "effect" || specifier.startsWith("effect/")

describe("RPC sources stay runtime-free", () => {
  test("only runtime-free canonical record and serializer entry points cross the Smithers boundary", () => {
    for (const file of sources(join(import.meta.dirname, "../src"))) {
      const source = readFileSync(file, "utf8")
      const imports = moduleSpecifiers(source, file)
      expect(imports.filter(smithersRuntimeImport), file).toEqual([])
      expect(imports.filter(effectRuntimeImport), file).toEqual([])
    }
  })

  test.each([
    "import { Effect } from \"MODULE\"",
    "export * from 'MODULE'",
    "import \"MODULE\"",
    "import 'MODULE'",
    "await import(\"MODULE\")",
    "await import ( 'MODULE' )",
    "const runtime = require(\"MODULE\")",
    "const runtime = require ( 'MODULE' )",
    "await import(/* @vite-ignore */ \"MODULE\")",
    "const runtime = require(/* runtime */ \"MODULE\")",
    "import runtime = require('MODULE')",
    "type Runtime = import(\"MODULE\").Runtime",
    "await import(`MODULE`)"
  ])("checks every import form: %s", (source) => {
    for (const module of ["effect", "effect/Effect"]) {
      expect(moduleSpecifiers(source.replace("MODULE", module)).filter(effectRuntimeImport)).toEqual([module])
    }
    for (const module of ["@smthrs/canonical", "@smthrs/canonical/Record/extra", "@smthrs/flow"]) {
      expect(moduleSpecifiers(source.replace("MODULE", module)).filter(smithersRuntimeImport)).toEqual([module])
    }
    for (const module of ["@smthrs/canonical/Record", "@smthrs/canonical/Serializer", "zod", "effective"]) {
      expect(moduleSpecifiers(source.replace("MODULE", module)).filter(smithersRuntimeImport)).toEqual([])
      expect(moduleSpecifiers(source.replace("MODULE", module)).filter(effectRuntimeImport)).toEqual([])
    }
  })

  test("ignores prose and comments that only mention imports", () => {
    expect(moduleSpecifiers("// import \"effect\"\nconst example = 'require(\"effect\")'")).toEqual([])
  })

  test("scans nested source files and excludes tests and non-source files", () => {
    const root = mkdtempSync(join(tmpdir(), "rpc-source-guard-"))
    try {
      mkdirSync(join(root, "testing", "nested"), { recursive: true })
      const files = {
        "Root.ts": "import \"effect\"",
        "testing/Relay.tsx": "require(\"@smthrs/flow\")",
        "testing/nested/Relay.vibe": "import \"effect/Effect\"",
        "testing/nested/Relay.test.ts": "import \"effect\"",
        "testing/nested/Relay.test.tsx": "import \"effect\"",
        "testing/nested/Relay.test.vibe": "import \"effect\"",
        "testing/nested/data.json": "{}"
      }
      for (const [path, source] of Object.entries(files)) writeFileSync(join(root, path), source)
      const found = sources(root)
      expect([...found].sort()).toEqual([
        join(root, "Root.ts"),
        join(root, "testing", "Relay.tsx"),
        join(root, "testing", "nested", "Relay.vibe")
      ].sort())
      expect(found.filter((file) => moduleSpecifiers(readFileSync(file, "utf8"), file).some(effectRuntimeImport)))
        .toHaveLength(2)
      expect(found.filter((file) => moduleSpecifiers(readFileSync(file, "utf8"), file).some(smithersRuntimeImport)))
        .toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test("host UI instructions retain explicit theme data and refuse arbitrary browser actions", () => {
  const frame = {
    runId: "run",
    type: "call.settled",
    link: 0,
    ordinal: 0,
    name: "theme",
    verdict: "run",
    ui: { command: "theme", mode: "dark" }
  }
  expect(AgentTurnFrameSchema.parse(frame)).toEqual(frame)
  for (
    const ui of [null, { command: "todo.drop", mode: "dark" }, { command: "theme", mode: null }, {
      command: "theme",
      mode: "dark",
      extra: "authority"
    }]
  ) expect(parses({ ...frame, ui })).toBe(false)
})

test("host UI instructions carry any UI-only flow with its declared scalar fields only", () => {
  const settled = (name: string, ui: unknown) => ({
    runId: "run",
    type: "call.settled",
    link: 0,
    ordinal: 0,
    name,
    verdict: "run",
    ui
  })
  for (
    const [name, ui] of [
      ["card.dismiss", { command: "card.dismiss", cardId: "card-7" }],
      ["runs.trace.select", { command: "runs.trace.select", runId: "run-1", nodeId: "build", seq: 4 }],
      ["help", { command: "help" }],
      ["search.files", { command: "search.files", query: "retry.ts" }]
    ] as const
  ) expect(AgentTurnFrameSchema.parse(settled(name, ui))).toEqual(settled(name, ui))
  for (
    const ui of [
      { command: "form.submit", cardId: "card-7" },
      { command: "wiki.new-note" },
      { command: "card.dismiss", cardId: "card-7", runId: "run-1" },
      { command: "card.dismiss", cardId: { nested: true } },
      { command: "search.files", query: ["a"] },
      { cardId: "card-7" }
    ]
  ) expect(parses(settled("card.dismiss", ui))).toBe(false)
})
