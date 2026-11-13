import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { z } from "zod"
import { AGENT_ROLES } from "../src/AgentRoles.ts"
import type { Card } from "../src/Cards.ts"
import {
  CardPatchSchema,
  CardSchema,
  FORM_OPTION_PROVIDERS,
  GitHubRateLimitSchema,
  LEGACY_CARD_KINDS,
  TargetDetailSchema,
  TargetsViewSchema
} from "../src/Cards.ts"
import { LSP_DIAGNOSTICS_CAP } from "../src/LocalLsp.ts"
import { AgentTurnFrameSchema } from "../src/NativeAgent.ts"
import { RepositoryHomeSchema } from "../src/RepositoryHome.ts"
import { fixtures as draftFixtures } from "./fixtures/Draft.ts"
import { legacyCards } from "./fixtures/LegacyCards.ts"
import { fixtures as todoFixtures } from "./fixtures/Todo.ts"

const builtIn = AGENT_ROLES[0]!
const builtInCardRow = {
  id: builtIn.id,
  label: builtIn.label,
  purpose: builtIn.purpose,
  harness: builtIn.harness,
  model: builtIn.model,
  builtin: true,
  harnessName: "Claude",
  available: true,
  reason: "",
  account: "will@example.com"
}

const base = { id: "card-r1", title: "Aomi", status: "active", createdAt: 0, ordinal: 0 }

describe("Browser typed refusal persistence", () => {
  const browser = {
    ...base,
    kind: "browser",
    status: "error",
    payload: {
      url: "https://example.com/",
      finalUrl: null,
      status: null,
      frameable: false,
      blockReason: null,
      error: "read refused"
    }
  }
  test("retains trusted refusal metadata through repeated JSON round trips", () => {
    const original = {
      ...browser,
      payload: {
        ...browser.payload,
        refusal: {
          status: 400,
          code: "request_invalid",
          fault: "user",
          origin: "local",
          message: "Invalid address",
          retryAfterSeconds: null
        }
      }
    }
    const decoded = CardSchema.parse(JSON.parse(JSON.stringify(original)))
    expect(decoded).toEqual(original)
    expect(CardSchema.parse(JSON.parse(JSON.stringify(decoded)))).toEqual(original)
  })
  test("preserves legacy string-only Browser errors without manufacturing metadata", () => {
    expect(CardSchema.parse(JSON.parse(JSON.stringify(browser)))).toEqual(browser)
  })
  test("rejects malformed persisted typed refusal fields", () => {
    for (
      const refusal of [
        { status: "400", message: "invalid" },
        { status: 400, message: 12 },
        { status: 400, message: "invalid", fault: "invented" },
        { status: 400, message: "invalid", origin: "invented" }
      ]
    ) expect(CardSchema.safeParse({ ...browser, payload: { ...browser.payload, refusal } }).success).toBe(false)
  })
})

/*
 * The search card's refusal is a RETYPED field, not a new one: it arrived as a
 * bare sentence and now carries the verdict that classified it. Retyping is
 * the one card change a stored row cannot replay, so the pin is here rather
 * than in prose — the two shapes must not both be accepted, or a sentence
 * whose fault nobody recorded would reach the failure presenter and be given
 * one it never had. The old shape is retired by the projector upgrade that
 * ships with it.
 */
describe("the search card's refusal carries its verdict, not a bare sentence", () => {
  const search = {
    ...base,
    kind: "search-results",
    payload: { query: "bounded", flow: "search.issues", items: [] }
  }
  const withRefusal = (refusal: unknown) => CardSchema.safeParse({ ...search, payload: { ...search.payload, refusal } })

  test("a classified refusal round trips with both fields", () => {
    const original = {
      ...search,
      payload: { ...search.payload, refusal: { sentence: "The tracker would not list.", fault: "dependency" } }
    }
    expect(CardSchema.parse(JSON.parse(JSON.stringify(original)))).toEqual(original)
  })

  test("a bare sentence, a missing fault and an invented fault are all refused", () => {
    for (
      const refusal of [
        "The tracker would not list.",
        { sentence: "The tracker would not list." },
        { sentence: "The tracker would not list.", fault: "invented" },
        { fault: "dependency" },
        { sentence: 12, fault: "dependency" }
      ]
    ) expect(withRefusal(refusal).success).toBe(false)
  })

  /*
   * A refusal takes the result count off the card. A sentence with nothing in
   * it would therefore remove "0 results" and put nothing where it stood —
   * the silence #3891 reported, reached through the field that fixed it. The
   * wire refuses it rather than leaving the card to guess a sentence.
   */
  test("a sentence with no words in it is refused, and surrounding whitespace is not part of it", () => {
    for (const sentence of ["", " ", "\n\t "]) expect(withRefusal({ sentence, fault: "user" }).success).toBe(false)
    const card = CardSchema.parse({
      ...search,
      payload: { ...search.payload, refusal: { sentence: "  The tracker would not list.\n", fault: "dependency" } }
    })
    expect(card.kind === "search-results" ? card.payload.refusal : undefined).toEqual({
      sentence: "The tracker would not list.",
      fault: "dependency"
    })
  })

  test("a card that refused nothing carries no refusal at all", () => {
    expect(CardSchema.parse(JSON.parse(JSON.stringify(search)))).toEqual(search)
  })
})

describe("persisted card decoding units", () => {
  test.each([
    { name: "null", value: null },
    { name: "missing row", value: undefined },
    { name: "boolean", value: false },
    { name: "number", value: 17 },
    { name: "string", value: "saved-card" },
    { name: "array", value: [] }
  ])("rejects a $name root instead of manufacturing a card", ({ value }) => {
    expect(CardSchema.safeParse(value).success).toBe(false)
  })

  const profiles: Extract<Extract<Card, { kind: "agents" }>["payload"], { native: boolean }>["agents"] = [
    {
      id: "checks/review",
      label: "checks/review",
      purpose: "Reviews the change.",
      model: { provider: "openai", id: "gpt-6-sol", label: "gpt-6-sol" },
      builtin: false,
      available: false,
      reason: "",
      account: ""
    },
    {
      id: "checks/verify",
      label: "checks/verify",
      purpose: "Verifies the change.",
      model: { provider: "openai", id: "gpt-6-sol", label: "gpt-6-sol" },
      builtin: false,
      available: true,
      reason: "",
      account: "maintainer"
    }
  ]

  test("configured profiles retain their facts and order", () => {
    const input = {
      ...base,
      kind: "agents",
      payload: { native: false, agents: profiles }
    }
    const before = structuredClone(input)
    const card = CardSchema.parse(input)
    expect(card.payload).toEqual({
      native: false,
      agents: [
        {
          id: "checks/review",
          label: "checks/review",
          purpose: "Reviews the change.",
          model: { provider: "openai", id: "gpt-6-sol", label: "gpt-6-sol" },
          builtin: false,
          available: false,
          reason: "",
          account: ""
        },
        {
          id: "checks/verify",
          label: "checks/verify",
          purpose: "Verifies the change.",
          model: { provider: "openai", id: "gpt-6-sol", label: "gpt-6-sol" },
          builtin: false,
          available: true,
          reason: "",
          account: "maintainer"
        }
      ]
    })
    expect(input).toEqual(before)
  })

  test("a malformed object agent entry is validated instead of silently dropping a configured profile", () => {
    const result = CardSchema.safeParse({
      ...base,
      kind: "agents",
      payload: { native: false, agents: [profiles[0], { id: "checks/incomplete" }] }
    })
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Incomplete configured profile was accepted")
    const issue = result.error.issues[0]!
    expect(issue).toMatchObject({ code: "invalid_union", path: ["payload"] })
    if (issue.code !== "invalid_union") throw new Error("Configured profile error did not preserve its payload branch")
    expect(issue.errors[0]!.map((entry) => entry.path)).toContainEqual(["agents", 1, "model"])
  })
})

test("a write-only form rejects values in either persisted input map", () => {
  const payload = {
    flow: "model.credential.enroll",
    via: "user",
    fields: [{ name: "value", label: "API key", kind: "write-only", required: true }],
    draft: {},
    given: {}
  }
  expect(CardSchema.safeParse({ ...base, kind: "flow-form", payload }).success).toBe(true)
  expect(
    CardSchema.safeParse({
      ...base,
      kind: "flow-form",
      payload: {
        ...payload,
        payloadField: "input",
        given: { input: { value: "nested-private-fixture" } }
      }
    }).success
  ).toBe(false)
  for (const map of ["draft", "given"]) {
    expect(
      CardSchema.safeParse({ ...base, kind: "flow-form", payload: { ...payload, [map]: { value: "private-fixture" } } })
        .success
    ).toBe(false)
  }
})

describe("held Review PR form request", () => {
  const payload = { flow: "workspace.new", via: "user", fields: [], draft: {}, given: {} }
  const request = { kind: "prs.triage", repo: "smithersai/smithers", number: 123, owner: "smithersai" }

  test("old persisted forms retain absence without manufacturing a pending request", () => {
    const old = { ...base, kind: "flow-form", payload }
    const parsed = CardSchema.parse(JSON.parse(JSON.stringify(old)))
    expect(parsed).toEqual(old)
    expect(Object.hasOwn(parsed.payload, "afterBox")).toBe(false)
  })

  test("valid identity and optional workspace/consumption states round-trip without rewriting", () => {
    for (
      const state of [{}, { workspaceId: "ws-review" }, { consumed: false }, { consumed: true }, {
        workspaceId: "ws-review",
        consumed: true
      }]
    ) {
      const original = { ...base, kind: "flow-form", payload: { ...payload, afterBox: { ...request, ...state } } }
      const parsed = CardSchema.parse(JSON.parse(JSON.stringify(original)))
      expect(parsed).toEqual(original)
      expect(CardSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(original)
      if (parsed.kind !== "flow-form") throw new Error("Form request changed card kind")
      expect(Object.keys(parsed.payload.afterBox!).sort()).toEqual(Object.keys(original.payload.afterBox).sort())
    }
  })

  test.each([
    { kind: "prs.open" },
    { number: 0 },
    { number: -1 },
    { number: 1.5 },
    { number: Infinity },
    { repo: 5 },
    { owner: null },
    { workspaceId: 7 },
    { consumed: "yes" }
  ])("rejects invalid request identity or state %j", (change) => {
    const original = { ...base, kind: "flow-form", payload: { ...payload, afterBox: { ...request, ...change } } }
    const before = structuredClone(original)
    expect(CardSchema.safeParse(original).success).toBe(false)
    expect(original).toEqual(before)
  })

  test.each(["kind", "repo", "number", "owner"])("requires declared request identity %s", (missing) => {
    const partial: Record<string, unknown> = { ...request }
    delete partial[missing]
    expect(CardSchema.safeParse({ ...base, kind: "flow-form", payload: { ...payload, afterBox: partial } }).success)
      .toBe(false)
  })
})

test("recorded workspace cards retain their title and retire their controls", () => {
  const card = CardSchema.parse({
    ...base,
    title: "Old branch",
    kind: "workspace",
    payload: { workspaceId: "ws-1", status: "running" }
  })
  expect(card).toMatchObject({ title: "Old branch", kind: "retired", payload: { was: "workspace" } })
  expect(CardSchema.options.map((option) => option.shape.kind.value)).not.toContain("workspace")
})

describe("the service-log card", () => {
  test("retires stored service logs while preserving their recorded content", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "service-log",
      payload: { workspaceId: "ws-1", repo: "will/smithers", service: "web", lines: ["listening"], follow: true }
    })
    expect(card).toEqual({
      ...base,
      kind: "retired",
      status: "acted",
      loading: false,
      payload: {
        was: "service-log",
        recorded: { workspaceId: "ws-1", repo: "will/smithers", service: "web", lines: ["listening"], follow: true }
      }
    })
  })
})

/*
 * Code intelligence: the file card's
 * anchor, what the language server published, the hover answer, and the
 * server state live in the payload, all optional so a card persisted before
 * the lane parses unchanged and states none of them.
 */
describe("the file card", () => {
  const payload = { repo: "smithers", path: "apps/mvp/src/App.tsx", content: "export {}\n", truncated: false }
  const diagnostic = {
    line: 317,
    character: 62,
    endLine: 317,
    endCharacter: 68,
    severity: "error" as const,
    message: "Property 'lenght' does not exist on type 'string'.",
    source: "ts",
    code: "2551"
  }
  const parses = (extra: Record<string, unknown>): boolean =>
    CardSchema.safeParse({ ...base, kind: "file", payload: { ...payload, ...extra } }).success

  test("a card persisted before code intelligence parses and states no anchor, diagnostics, hover, or server", () => {
    const card = CardSchema.parse({ ...base, kind: "file", payload })
    if (card.kind !== "file") throw new Error("Expected a file card")
    expect(card.payload.line).toBeUndefined()
    expect(card.payload.column).toBeUndefined()
    expect(card.payload.diagnostics).toBeUndefined()
    expect(card.payload.hover).toBeUndefined()
    expect(card.payload.intel).toBeUndefined()
  })

  test("carries the anchor, what the server published, the hover answer, and the server state", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "file",
      payload: {
        ...payload,
        line: 317,
        column: 62,
        diagnostics: [diagnostic],
        hover: {
          line: 63,
          character: 7,
          contents: "const isRecord: (value: unknown) => value is Record<string, unknown>"
        },
        intel: { state: "missing", note: "npm i -g typescript-language-server typescript" }
      }
    })
    if (card.kind !== "file") throw new Error("Expected a file card")
    expect(card.payload.line).toBe(317)
    expect(card.payload.column).toBe(62)
    expect(card.payload.diagnostics).toEqual([diagnostic])
    expect(card.payload.hover?.contents).toContain("value is Record")
    expect(card.payload.intel).toEqual({ state: "missing", note: "npm i -g typescript-language-server typescript" })
  })

  test("a hover the server had nothing for is null, which is not the same as never asked", () => {
    const card = CardSchema.parse({ ...base, kind: "file", payload: { ...payload, hover: null } })
    if (card.kind !== "file") throw new Error("Expected a file card")
    expect(card.payload.hover).toBeNull()
  })

  test("refuses a 0-based anchor, a severity outside the four, a state outside the four, and more diagnostics than the host cap", () => {
    expect(parses({ line: 0 })).toBe(false)
    expect(parses({ column: 0 })).toBe(false)
    expect(parses({ diagnostics: [{ ...diagnostic, severity: "fatal" }] })).toBe(false)
    expect(parses({ diagnostics: Array.from({ length: LSP_DIAGNOSTICS_CAP }, () => diagnostic) })).toBe(true)
    expect(parses({ diagnostics: Array.from({ length: LSP_DIAGNOSTICS_CAP + 1 }, () => diagnostic) })).toBe(false)
    expect(parses({ intel: { state: "installing" } })).toBe(false)
  })
})

describe("the agent cards", () => {
  const row = builtInCardRow

  test("the agents card retains availability, resets edited built-in facts to the table, and keeps configured profiles as read", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "agents",
      payload: {
        native: true,
        agents: [
          { ...row, model: { provider: "openai", id: "gpt 5", label: "Edited" }, label: "Edited" },
          { ...row, id: "custom-reviewer", builtin: false, kind: "specialist" }
        ]
      }
    })
    // A built-in reads its facts from the table; a configured profile (smithers-ui-DESIGN.md §3.3) keeps its own.
    expect(card.payload).toEqual({
      native: true,
      agents: [row, { ...row, id: "custom-reviewer", builtin: false, kind: "specialist" }]
    })
  })

  test("a repository agent flow is a row with no harness and its flow id, path segments included", () => {
    const reviewer = {
      id: "checks/review",
      label: "checks/review",
      purpose: "Reviews the change.",
      model: { provider: "openai", id: "gpt-6-sol", label: "gpt-6-sol" },
      builtin: false,
      available: false,
      reason: "",
      account: ""
    }
    const card = CardSchema.parse({ ...base, kind: "agents", payload: { native: false, agents: [reviewer] } })
    expect(card.payload).toEqual({ native: false, agents: [reviewer] })
    // A model id that reads as a flag is still refused on every row.
    expect(
      CardSchema.safeParse({
        ...base,
        kind: "agents",
        payload: { native: false, agents: [{ ...reviewer, model: { ...reviewer.model, id: "-m x" } }] }
      }).success
    ).toBe(false)
  })

  test("the flow-form card holds the flow, who asked, the derived fields, the draft and what was given; a bad kind or provider is rejected", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "flow-form",
      payload: {
        flow: "tab.harness",
        via: "agent",
        fields: [
          { name: "id", label: "Id", kind: "text", required: true },
          {
            name: "harness",
            label: "Harness",
            kind: "select",
            required: true,
            optionsFrom: "cloud-repos",
            options: [
              { value: "codex", label: "Codex · OPENAI_API_KEY" },
              { value: "opencode", label: "OpenCode", disabled: true, reason: "no credential" }
            ]
          },
          { name: "model", label: "Model", kind: "text", required: true, options: [] },
          { name: "purpose", label: "Purpose", kind: "text", required: false }
        ],
        draft: { id: "implement", harness: "codex" },
        given: { id: "implement", harness: "codex" }
      }
    })
    if (card.kind !== "flow-form") throw new Error("Expected a flow form card")
    expect(card.payload.fields[1]?.options?.[1]).toEqual({
      value: "opencode",
      label: "OpenCode",
      disabled: true,
      reason: "no credential"
    })
    expect(card.payload.draft.harness).toBe("codex")
    const payload = card.payload
    expect(
      CardSchema.safeParse({
        ...base,
        kind: "flow-form",
        payload: { ...payload, fields: [{ name: "x", label: "X", kind: "date", required: true }] }
      }).success
    ).toBe(false)
    expect(
      CardSchema.safeParse({
        ...base,
        kind: "flow-form",
        payload: {
          ...payload,
          fields: [{ name: "x", label: "X", kind: "select", required: true, optionsFrom: "moons" }]
        }
      }).success
    ).toBe(false)
    expect(CardSchema.safeParse({ ...base, kind: "flow-form", payload: { ...payload, via: "system" } }).success).toBe(
      false
    )
  })
})

describe("the models card", () => {
  test.each(["models", "model-call", "agent-models"])(
    "saved %s retains recorded content without restoring executable requests",
    (kind) => {
      const decoded = CardSchema.parse({
        ...base,
        kind,
        body: "Private",
        payload: { apiKey: "sk-live", request: { prompt: "Private" } }
      })
      expect(decoded).toEqual({
        ...base,
        kind: "retired",
        body: "Private",
        status: "acted",
        loading: false,
        payload: { was: kind, recorded: { request: { prompt: "Private" } } }
      })
      expect(JSON.stringify(decoded)).not.toContain("sk-live")
      expect(CardSchema.parse(decoded)).toEqual(decoded)
      expect(CardPatchSchema.safeParse({ kind, payload: { apiKey: "sk-live" } }).success).toBe(false)
    }
  )

  test("a model form draws its selects from models, credentials and seats, and model.save is not a retired flow", () => {
    expect(FORM_OPTION_PROVIDERS).toEqual(expect.arrayContaining(["models", "credentials", "seats"]))
    const form = CardSchema.parse({
      ...base,
      kind: "flow-form",
      payload: {
        flow: "model.save",
        via: "user",
        fields: [
          { name: "credential", label: "Credential", kind: "select", required: true, optionsFrom: "credentials" },
          { name: "seat", label: "Seat", kind: "select", required: true, optionsFrom: "seats" },
          { name: "recordId", label: "Model", kind: "select", required: true, optionsFrom: "models" }
        ],
        draft: {},
        given: {}
      }
    })
    expect(form.kind).toBe("flow-form")
  })
})

describe("card patch validation", () => {
  test("the native card.update frame requires the same kind validation", () => {
    expect(
      AgentTurnFrameSchema.safeParse({
        runId: "run-1",
        type: "card.update",
        id: base.id,
        patch: { kind: "file", payload: { line: 0 } }
      }).success
    ).toBe(false)
    expect(
      AgentTurnFrameSchema.safeParse({
        runId: "run-1",
        type: "card.update",
        id: base.id,
        patch: { kind: "file", payload: { line: 1 } }
      }).success
    ).toBe(true)
  })

  test("metadata is optional but kind is required", () => {
    expect(CardPatchSchema.parse({ kind: "file", title: "After" })).toEqual({ kind: "file", title: "After" })
    expect(CardPatchSchema.safeParse({ title: "After" }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ kind: "agent", payload: { roleId: "Bad Id" } }).success).toBe(false)
  })

  const diagnostic = { line: 1, character: 1, endLine: 1, endCharacter: 2, severity: "error", message: "bad" }
  test("refuses file diagnostics above the cap on card.update", () => {
    expect(
      CardPatchSchema.safeParse({
        kind: "file",
        payload: {
          diagnostics: Array.from({ length: LSP_DIAGNOSTICS_CAP + 1 }, () => diagnostic)
        }
      }).success
    ).toBe(false)
  })
  test("accepts partial file payloads at the cap and rejects invalid anchors and missing kinds", () => {
    expect(CardPatchSchema.parse({
      kind: "file",
      payload: {
        diagnostics: Array.from({ length: LSP_DIAGNOSTICS_CAP }, () => diagnostic)
      }
    })).toMatchObject({ kind: "file" })
    expect(CardPatchSchema.safeParse({ kind: "file", payload: { line: 0 } }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ payload: { line: 1 } }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ kind: "file", payload: { intel: { state: "installing" } } }).success).toBe(false)
  })
})

describe("card patches never invent defaults", () => {
  test("an empty payload patch stays empty for every current card kind", () => {
    const currentPayloads = CardSchema.options
    expect(currentPayloads.some((option) => option.shape.kind.value === "agents")).toBe(true)
    for (const option of currentPayloads) {
      const kind = option.shape.kind.value
      const patch = CardPatchSchema.parse({ kind, payload: {} })
      expect({ kind, payload: patch.payload }).toEqual({ kind, payload: {} })
    }
  })
})

describe("legacy environment persistence", () => {
  test("retains recorded content without restoring controls", () => {
    const row = {
      ...base,
      kind: "env",
      payload: {
        repo: "smithers",
        vars: [{ name: "DATABASE_URL", value: "postgres://user:password@host/db" }],
        setupScript: "pnpm install"
      }
    }
    const decoded = CardSchema.parse(row)
    expect(decoded.kind).toBe("retired")
    expect(decoded.title).toBe(row.title)
    expect(decoded.payload).toEqual({ was: "env", recorded: { ...row.payload, vars: [{ name: "DATABASE_URL" }] } })
    expect(JSON.stringify(decoded)).not.toContain("password")
    expect(CardSchema.parse(decoded)).toEqual(decoded)
  })
})

describe("the run trace card's graph view", () => {
  const trace = (payload: Record<string, unknown>) =>
    CardSchema.safeParse({
      ...base,
      kind: "run-trace",
      payload: {
        repo: "smithersai/smithers",
        runId: "run-1",
        workflow: "review",
        phase: "running",
        steps: [],
        result: null,
        lastSeq: 0,
        ...payload
      }
    })

  test("a row persisted before the graph view still parses, and gains nothing", () => {
    const before = trace({ traceView: "timeline", filter: "failed" })
    expect(before.success).toBe(true)
    expect(Object.keys(before.data?.payload ?? {})).not.toContain("plan")
    expect(Object.keys(before.data?.payload ?? {})).not.toContain("graph")
  })

  test("the plan a launch snapshotted and the camera flag round-trip", () => {
    const node = {
      id: "root.flow.then.map.all.steady",
      kind: "step",
      key: "key1_1d19f029117886d2",
      dependsOn: ["root.flow.andThen"],
      tier: "sealed",
      action: "gateway/graph/Steady",
      status: "run"
    }
    const parsed = trace({
      traceView: "graph",
      plan: { planId: "plan-1", digest: "d1", nodes: [node] },
      graph: { follow: true, execution: "c7eac2d2" }
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.payload).toMatchObject({
      traceView: "graph",
      plan: { planId: "plan-1", digest: "d1", nodes: [node] },
      graph: { follow: true, execution: "c7eac2d2" }
    })
    // The plan carries the node's address, its key, its edges, its tier and
    // what it dispatches. A node's key MATERIAL is tens of kilobytes of JSON
    // schema and a card payload is written to disk, so a caller that hands the
    // whole plan node over persists the drawn part and nothing else.
    const whole = trace({
      plan: { planId: "plan-1", digest: "d1", nodes: [{ ...node, material: { kind: "sealed", body: {} } }] }
    })
    expect((whole.data?.payload as { plan: { nodes: ReadonlyArray<unknown> } }).plan.nodes).toEqual([node])
    expect(trace({ traceView: "canvas" }).success).toBe(false)
    expect(trace({ plan: { planId: "plan-1", nodes: [] } }).success).toBe(false)
  })
})

/*
 * The persistence contract, kind by kind. Cards.ts states that "everything in
 * a card payload is written to disk", and the old app's FrameSnapshotSchema read
 * a whole transcript back through `cards: z.array(CardSchema)` — so a field
 * that stops parsing rejects a snapshot, not one card. Dozens of fields are
 * marked "optional so cards persisted before the lane parse", which is a
 * promise about payloads nobody can rewrite.
 *
 * Every current kind therefore carries two fixtures: `minimal` is the payload with
 * only the fields the schema requires (what a card written before every later
 * lane holds) and `full` is the payload with every field the schema accepts.
 * Both must parse, both must come back unchanged, and a minimal payload must
 * gain nothing on the way through. Making an optional field required,
 * renaming a kind or tightening an enum breaks a fixture here instead of a
 * reader's transcript. Legacy kinds have one opaque stored payload each in
 * fixtures/LegacyCards.ts; no live schema is claimed for their contents.
 */

/** A canonical non-nil gateway workspace id (GatewayWorkspace.ts). */
const gatewayWorkspaceId = "6f1b9c2e-6a4a-4c0e-9f52-2c1a7f0b39d1"
const rateLimit = { limit: 5000, remaining: 42, resetAt: "2026-09-05T10:00:00Z" }

/*
 * A complete StatusRollup (Health.ts): the observation a health host attaches
 * to a run or a session. It is optional wherever it appears, so it belongs in
 * `full` only, stated whole (`reason` and `provenance` included) because the
 * field audit reads top-level keys and would miss a nested field left out.
 */
const statusRollup = (subjectId: string, state: string, activity: string) => ({
  subjectId,
  state,
  activity,
  health: "healthy",
  attention: "none",
  freshness: "fresh",
  reason: "ok",
  provenance: {
    checkerId: "checker-1",
    monitorId: "monitor-1",
    observedAt: 1_757_000_000_000,
    expiresAt: 1_757_000_030_000,
    evidenceSeq: 7,
    incarnation: "inc-1",
    version: 1
  },
  updatedAt: 1_757_000_000_000
})

type KindFixtures = {
  /** Only the fields the schema requires: what a card persisted before every later lane carries. */
  readonly minimal: Record<string, unknown>
  /** Every field the schema accepts, including the ones later lanes added. */
  readonly full: Record<string, unknown>
}

const FIXTURES: Record<Card["kind"], KindFixtures> = {
  todo: {
    minimal: { n: 12, requests: [] },
    full: {
      n: 12,
      model: todoFixtures.failed.model,
      requests: [],
      observedConfirmations: [],
      answerDraft: "A late answer",
      answeredBy: "maya"
    }
  },
  /* Confirm (T-APP-04): the card names its subject; the card file reads the confirmation. */
  confirm: { minimal: { id: "act:act-1" }, full: { id: "merge:t-stripe" } },
  branch: { minimal: { id: "b-retry" }, full: { id: "b-retry", tab: "activity" } },
  terminal: { minimal: { id: "term-1" }, full: { id: "term-1" } },
  proposal: {
    minimal: { id: "lint" },
    full: {
      id: "lint",
      model: {
        id: "lint",
        title: "Run lint",
        evidence: ["3 of the last 5"],
        refs: [{ label: "T7", url: "https://github.com/smithers/canary/pull/41" }],
        state: "accepted",
        todo: { n: 12, title: "Run lint" }
      },
      load: { owner: "ben", state: "failed", error: "Not available" },
      request: { action: "accept", owner: "ben", state: "failed", error: "Not available" }
    }
  },
  run: {
    minimal: { id: "run-1" },
    full: {
      id: "run-1",
      view: { selected: "cell-legacy", tab: "journal", at: 3 },
      memberViews: { alice: { selected: "cell-alice", tab: "run", at: 2 } }
    }
  },
  flow: {
    minimal: { name: "todo" },
    full: {
      name: "todo",
      version: "v3",
      memberVersions: { will: "v3", ben: "v2" },
      proposal: { request: "request-1", diff: "diff-1" }
    }
  },
  setup: { minimal: {}, full: {} },
  settings: { minimal: {}, full: {} },
  members: { minimal: {}, full: {} },
  commands: { minimal: {}, full: {} },
  "hosted-change": {
    minimal: { repo: "maya/tinyhttp", sessionId: "session", request: "add slugify" },
    full: { repo: "maya/tinyhttp", sessionId: "session", request: "add slugify" }
  },
  "archives": { minimal: {}, full: { selected: "0b1c2d3e" } },
  draft: {
    minimal: { ...draftFixtures.append.model, idempotencyKey: "commit-1" },
    full: {
      ...draftFixtures.append.model,
      issue: draftFixtures.issue_fixes.model.issue,
      issueDigest: "4babb1e1dd0eee80b2bc65f0117d7ac639a2914627f7a0569119d42379ce3d37",
      seed: draftFixtures.seed.model.seed,
      source: { path: "TODO.md", owner: "ben", opened: true },
      committed: { n: 12, rev: 1 },
      optionsFailure: "Could not load placement",
      issuePreparation: {
        source: {
          author: "ben",
          number: 7,
          title: "Original issue",
          body: "Original body",
          url: "https://github.com/org/repo/issues/7",
          digest: "a".repeat(64),
          comments: [{ author: "alice", body: "Observed failure" }]
        },
        state: "failed",
        error: "Model unavailable"
      },
      imagePreparation: { name: "todo", repo: "org/repo", state: "requested" },
      idempotencyKey: "commit-1",
      request: { key: "commit-1", owner: "ben", operation: "create", state: "accepted", body: {}, n: 12 }
    }
  },
  "factory.home": {
    minimal: { repo: "org/repo", home: { kind: "none" }, flows: [] },
    full: {
      repo: "org/repo",
      home: {
        kind: "blocks",
        blocks: [
          { type: "prompt", placeholder: "Change it…" },
          { type: "markdown", path: "README.md", markdown: "# Hello" }
        ]
      },
      flows: [{ id: "review", summary: "Review", description: "Review code", featured: true }]
    }
  },
  "repo-update": {
    minimal: {
      repo: "org/repo",
      scope: "github:alice",
      checkedAt: 1,
      summary: "Up to date",
      openIssues: null,
      openPrs: null,
      problems: [],
      items: []
    },
    full: {
      repo: "org/repo",
      scope: "github:alice",
      checkedAt: 2,
      summary: "One issue update",
      branch: "main",
      openIssues: 1,
      openPrs: 0,
      problems: ["Notifications unavailable"],
      items: [{
        id: "notice-1",
        version: "v1",
        kind: "issue",
        number: 3,
        title: "Fix greeting",
        state: "open",
        tags: ["bug"],
        read: false
      }]
    }
  },
  "repository-choice": {
    minimal: {
      cutoff: "2026-08-10T00:00:00Z",
      partial: false,
      error: null,
      selected: null,
      created: null,
      repositories: []
    },
    full: {
      cutoff: "2026-08-10T00:00:00Z",
      partial: true,
      error: "GitHub answered 403 for one repository",
      selected: "smithersai/smithers",
      created: { fullName: "owner/smithers-playground" },
      repositories: [{
        fullName: "smithersai/smithers",
        count: 12,
        latest: "2026-09-05T09:00:00Z",
        coverage: "default-branch",
        error: null
      }]
    }
  },
  plan: {
    minimal: { items: [] },
    full: { items: [{ id: "p1", title: "Read the route", status: "done" }] }
  },
  approval: {
    minimal: { capability: "network" },
    full: {
      localGateway: true,
      capability: "network",
      detail: "POST https://api.github.com",
      runId: "run-1",
      requestId: "gate-1",
      approval: { _tag: "ApprovalTarget.Node", node: "call-3" },
      answerDraft: { question: "a".repeat(64), text: "The scheduler owns the budget." },
      question: {
        kind: "select",
        prompt: "Which environment?",
        name: "environment",
        options: ["staging", "production"],
        attempt: 1,
        maxAttempts: 3
      },
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      decision: "approved",
      decidedAt: 1_757_000_000_000,
      pending: true,
      error: "the gateway refused (503)",
      chain: true,
      background: false,
      flow: "review.land"
    }
  },
  "billing-plans": {
    minimal: { planKey: null, sandbox: null, plans: [], checkout: false },
    full: {
      planKey: "free",
      checkout: true,
      sandbox: {
        concurrentSandboxes: 1,
        concurrentInUse: 1,
        idleTimeoutSecs: 1800,
        hoursPerDay: 4,
        secondsUsedToday: 3600,
        dayResetsAt: "2026-09-16T00:00:00Z"
      },
      plans: [{
        key: "pro",
        display_name: "Pro",
        price_cents: 5000,
        interval: "monthly",
        checkout_available: true,
        limits: {
          concurrent_sandboxes: 3,
          idle_timeout_secs: 14400,
          hours_per_day: -1,
          private_repos: -1,
          storage_bytes: -1,
          ci_minutes: -1,
          agent_runs: -1,
          seats: 1
        }
      }],
      refusal: {
        status: 402,
        code: "plan_limit_exceeded",
        message: "Upgrade or suspend a sandbox.",
        plan_key: "free",
        limit_kind: "concurrent_sandboxes",
        upgrade_plan_key: "pro"
      }
    }
  },
  balance: {
    minimal: {
      totalUsd: "0.00",
      state: "empty",
      allowedToStartWork: false,
      lifetimeChargedUsd: "0.00",
      chargeCount: 0,
      introUsd: null
    },
    full: {
      totalUsd: "500.00",
      state: "ok",
      allowedToStartWork: true,
      lifetimeChargedUsd: "12.50",
      chargeCount: 3,
      introUsd: "500.00"
    }
  },
  status: {
    minimal: {},
    full: { progress: 0.5, note: "reading the route" }
  },
  world: {
    minimal: { documents: [] },
    full: {
      documents: [{
        id: "doc-1",
        path: "docs/adr/0003-change.md",
        title: "The change is the unit",
        confidence: 0.9,
        cloud: { repo: "smithersai/smithers", slug: "adr-0003", revision: 4 }
      }],
      selectedDocumentId: "doc-1",
      view: "document",
      index: { repo: "smithersai/smithers", page: 1, hasNext: false }
    }
  },
  browser: {
    minimal: { url: "https://smithers.sh", finalUrl: null, status: null, frameable: false, blockReason: null },
    full: {
      url: "https://smithers.sh",
      finalUrl: "https://smithers.sh/docs",
      status: 200,
      frameable: false,
      blockReason: "x-frame-options: deny",
      error: "the fetch failed (503)",
      refusal: {
        status: 503,
        message: "read unavailable",
        code: "upstream_unavailable",
        fault: "infra",
        origin: "local"
      }
    }
  },
  "run-trace": {
    minimal: {
      repo: "smithersai/smithers",
      runId: "run-1",
      workflow: "review",
      phase: "running",
      steps: [],
      result: null,
      lastSeq: 0
    },
    full: {
      localGateway: true,
      burndown: { filter: "failed", item: 3071 },
      signalRequest: { name: "resume", state: "failed", afterSeq: 41, error: "offline" },
      authoring: { requestId: "author-request-1", owner: "will", launchError: "offline" },
      statusRollup: statusRollup("run:run-1", "running", "working"),
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      runId: "run-1",
      workflow: "review",
      phase: "quiet",
      steps: ["read the diff"],
      result: "3 findings",
      error: "the executor exited 1",
      failure: { class: "dependency", tag: "@smthrs/flow/DependencyUnavailable" },
      observationError: "the events projection refused (500)",
      lastSeq: 42,
      deadlineAt: 1_790_000_900_000,
      quietForMs: 600_000,
      input: { repo: "smithersai/smithers" },
      kind: "prototype",
      waiting: "approval",
      steeringPending: true,
      facet: "transcript",
      facetRequest: {
        id: "facet-request-1",
        owner: "will",
        repo: "smithersai/smithers",
        runId: "run-1",
        workspaceId: gatewayWorkspaceId,
        facet: "transcript",
        state: "failed",
        follow: true,
        toggleFollow: true,
        error: "Transcript unavailable"
      },
      follow: true,
      transcriptRows: [{ sequence: 1, turn: 1, at: 1_757_000_000_000, kind: "message", text: "reading" }],
      transcriptAtRevision: 17,
      events: [{ seq: 1, type: "call.started" }],
      selection: "span-3",
      cursorSeq: 41,
      filter: "failed",
      liveTail: false,
      traceView: "graph",
      plan: {
        planId: "plan-1",
        digest: "8d6fcaa8b2922fa83791714f8e688b495e4dbd7aebf63e4e4114af660e3fbd98",
        nodes: [{
          id: "root.flow.then.map.all.steady",
          kind: "step",
          key: "key1_1d19f029117886d2",
          dependsOn: ["root.flow.andThen"],
          tier: "sealed",
          action: "gateway/graph/Steady",
          status: "run"
        }],
        graph: {
          edges: [{ from: "root.flow.andThen", to: "root.flow.then.map.all.steady", reason: "value" }],
          nodes: [{
            id: "root.flow.then.map.all.steady",
            declaredAt: { path: "flows/graph-fixture/flow.ts", line: 42 }
          }],
          sourceRevision: "a03f5f1ea03f5f1ea03f5f1ea03f5f1ea03f5f1e"
        }
      },
      graph: {
        follow: true,
        node: "root.flow.then.map.all.steady",
        tab: "events",
        codeError: {
          path: "flows/graph-fixture/flow.ts",
          message: "Path not found: flows/graph-fixture/flow.ts in smithersai/smithers"
        }
      },
      takeover: { terminalSessionId: "pty-1" },
      codingChangeId: "qupxosqw"
    }
  },
  "workflow-list": {
    minimal: { repo: "smithersai/smithers", workflows: [] },
    full: {
      localGateway: true,
      repo: "smithersai/smithers",
      catalogRequest: { id: "catalog-request", owner: "smithersai", state: "pending" },
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      workflows: [{
        key: "issue.repro",
        description: "Research an issue",
        prompt: "Read and reproduce the issue.",
        inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] }
      }],
      issueContext: { number: 3, title: "Fix greeting" },
      research: "Reproduced the missing-name case."
    }
  },
  "flow-plan": {
    minimal: { repo: "smithersai/smithers", flowId: "review", status: "pending" },
    full: {
      localGateway: true,
      previousPlan: { planId: "plan-0", digest: "b".repeat(64), nodes: [] },
      sourceReceipt: { runCardId: "author-run-1", receipt: "copy:1:event" },
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      flowId: "review",
      input: { pr: 4821 },
      inputSchema: { type: "object", properties: { pr: { type: "integer" } }, required: ["pr"] },
      planRequest: { id: "plan-request-1", owner: "will" },
      // A re-plan that was refused keeps the graph it last drew, so the card
      // states the refusal without blanking what the person was reading.
      status: "failed",
      error: "The workspace has no flow called review.",
      planId: "plan-1",
      digest: "d".repeat(64),
      nodes: [
        {
          id: "root.read",
          kind: "step",
          key: `key1_${"0".repeat(64)}`,
          dependsOn: [],
          tier: "sealed",
          action: "files/read",
          status: "run"
        },
        {
          id: "root.review",
          kind: "agent",
          key: `key1_${"1".repeat(64)}`,
          dependsOn: ["root.read"],
          tier: "compensable",
          status: "run"
        }
      ],
      graph: {
        edges: [{ from: "root.read", to: "root.review", reason: "value" }],
        nodes: [
          { id: "root.read", declaredAt: { path: ".smithers/flows/review/flow.ts", line: 12 } },
          { id: "root.review" }
        ],
        // The revision those sites were read at: what the Code tab reads AT.
        sourceRevision: "a03f5f1ea03f5f1ea03f5f1ea03f5f1ea03f5f1e"
      },
      // The re-key preview against a run that really did settle a node clean.
      against: "run-1",
      rekey: { rerun: 3, total: 11, etaMs: 24, wasMs: 1_182, cleanSettlements: 1 },
      view: {
        node: "root.read",
        tab: "declaration",
        codeError: {
          path: ".smithers/flows/review/flow.ts",
          message: "Path not found: .smithers/flows/review/flow.ts in smithersai/smithers"
        }
      }
    }
  },
  "trigger-list": {
    minimal: { repo: "smithersai/smithers", triggers: [] },
    full: {
      localGateway: true,
      repo: "smithersai/smithers",
      preparations: [{
        id: "prep-1",
        owner: "will",
        workspaceId: "0b5e8c1a-2f3d-4e6a-9b7c-1d2e3f4a5b6c",
        phase: "ready",
        draft: { flow: "ci", slug: "nightly", schedule: "0 * * * *", input: "{}", tokens: 1200, minutes: 3 },
        receipt: { text: "prepared", args: "--slug nightly" },
        error: ""
      }],
      pauseRequests: [{ id: "pause-1", slug: "nightly", owner: "will", phase: "completed" }],
      declared: [{ event: "push", flow: "ci", description: "run ci on every push" }],
      live: true,
      triggers: [{
        id: "trg-1",
        slug: "nightly",
        flowId: "ci",
        cron: "0 * * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: 1_757_003_600_000
      }]
    }
  },
  "run-list": {
    minimal: { repo: "smithersai/smithers", runs: [] },
    full: {
      localGateway: true,
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      listRequest: {
        id: "list-request",
        owner: "will",
        repo: "smithersai/smithers",
        workspaceId: gatewayWorkspaceId,
        status: "running",
        flow: "review",
        lineage: "lin-1",
        state: "failed"
      },
      statuses: ["running", "completed"],
      status: "running",
      flow: "review",
      lineage: "lin-1",
      approvals: [{ runId: "run-1", requestId: "gate-1", title: "POST https://api.github.com" }],
      observationError: "the runs projection refused (500)",
      observedAt: 1_757_000_000_000,
      runs: [{
        runId: "run-1",
        flowId: "review",
        status: "running",
        waiting: "approval",
        statusRollup: statusRollup("run:run-1", "running", "working"),
        createdAt: 1_757_000_000_000,
        turns: 3,
        calls: 12
      }]
    }
  },
  "approvals-inbox": {
    minimal: { repo: "smithersai/smithers", approvals: [] },
    full: {
      localGateway: true,
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      approvals: [{
        runId: "run-1",
        requestId: "gate-1",
        title: "POST https://api.github.com",
        approval: { _tag: "ApprovalTarget.Node", node: "call-3" },
        answerDraft: { question: "b".repeat(64), text: "Ship the canary first." },
        requestedAt: 1_757_000_000_000,
        decision: "denied",
        decidedAt: 1_757_000_060_000,
        decisionError: "the gateway refused (503)",
        pending: true
      }]
    }
  },
  "issue-list": {
    minimal: { repo: "smithersai/smithers", filter: "open", issues: [] },
    full: {
      repo: "smithersai/smithers",
      filter: "all",
      kind: "issue",
      view: "bugs",
      views: [{ id: "bugs", title: "Open bugs" }],
      // One page of a longer list: its counts are floors.
      partial: true,
      issues: [{
        number: 1634,
        title: "rc0 CI green",
        state: "fixed",
        author: "will",
        comments: 4,
        updatedAt: "2026-09-05T09:00:00Z",
        source: "github",
        htmlUrl: "https://github.com/smithersai/smithers/issues/1634",
        kind: "chat",
        task: {
          owner: {
            id: "assistant",
            name: "Assistant",
            iconUrl: "https://example.com/assistant.png",
            agentId: "assistant"
          },
          due: "2026-09-27",
          priority: 1,
          parent: { number: 1600, title: "CI" },
          fixedBy: {
            id: "assistant",
            name: "Assistant",
            iconUrl: "https://example.com/assistant.png",
            agentId: "assistant"
          },
          verifiedBy: {
            id: "assistant",
            name: "Assistant",
            iconUrl: "https://example.com/assistant.png",
            agentId: "assistant"
          }
        }
      }],
      github: {
        source: "synced",
        syncedAt: "2026-09-05T08:00:00Z",
        stale: true,
        syncError: "the mirror refused (500)",
        refusal: "not linked"
      }
    }
  },
  issue: {
    minimal: {
      repo: "smithersai/smithers",
      number: 1634,
      title: "rc0 CI green",
      state: "open",
      author: null,
      issueBody: "",
      labels: [],
      comments: []
    },
    full: {
      repo: "smithersai/smithers",
      number: 1634,
      title: "rc0 CI green",
      kind: "chat",
      visibility: "private",
      task: {
        owner: {
          id: "assistant",
          name: "Assistant",
          iconUrl: "https://example.com/assistant.png",
          agentId: "assistant"
        },
        due: "2026-09-27",
        priority: 0,
        parent: { number: 1600 },
        fixedBy: {
          id: "assistant",
          name: "Assistant",
          iconUrl: "https://example.com/assistant.png",
          agentId: "assistant"
        },
        verifiedBy: {
          id: "assistant",
          name: "Assistant",
          iconUrl: "https://example.com/assistant.png",
          agentId: "assistant"
        }
      },
      conversation: { branchId: "branch-main", owner: "will", creationKey: "conversation-1" },
      commentDraft: "Reply",
      pendingComments: [{ id: "request-1", text: "Hello", actor: "user", status: "requested" }],
      state: "verified",
      author: "will",
      issueBody: "shard-3 wedges on sqlite",
      issueDigest: "a".repeat(64),
      makeTodoAllowed: true,
      todoAuthorizationScope: "identity-and-roster-observation",
      source: "github",
      htmlUrl: "https://github.com/smithersai/smithers/issues/1634",
      labels: ["ci", "flaky"],
      comments: [{
        id: 31,
        author: null,
        persona: { username: "Reviewer", iconEmoji: ":robot_face:", iconUrl: "https://example.com/avatar.png" },
        commentBody: "reproduced",
        createdAt: "2026-09-05T09:00:00Z"
      }],
      lastComment: {
        commenter: "will",
        persona: "Reviewer",
        excerpt: "reproduced",
        origin: "slack",
        createdAt: "2026-09-05T09:00:00Z"
      },
      createdAt: "2026-09-04T08:00:00Z",
      assignees: [{ login: "ada", avatar: "https://avatars.githubusercontent.com/u/1" }],
      labelColors: { ci: "0e8a16", flaky: "d93f0b" },
      authorAvatar: "https://avatars.githubusercontent.com/u/2"
    }
  },
  "pr-list": {
    minimal: { repo: "smithersai/smithers", landings: [] },
    full: {
      repo: "smithersai/smithers",
      partial: true,
      landings: [{
        number: 12,
        title: "Serve repository files",
        state: "queued",
        author: "will",
        updatedAt: "2026-09-05T09:00:00Z"
      }]
    }
  },
  pr: {
    minimal: {
      repo: "smithersai/smithers",
      number: 12,
      title: "Serve repository files",
      state: "queued",
      author: null,
      prBody: "",
      reviews: [],
      checks: []
    },
    full: {
      sourceRepo: "smithersai/smithers",
      // The head this card was read at: the head a verdict typed against it
      // names (#4038).
      headCommit: "0d1dc5a1a4f0bd02a9e5ba9a1f86e7f1a3b4c5d6",
      tab: "files",
      repo: "smithersai/smithers",
      number: 12,
      title: "Serve repository files",
      state: "queued",
      author: "will",
      prBody: "one bounded route",
      reviews: [{ author: "ada", type: "APPROVED", reviewBody: "ship it" }],
      checks: [{ context: "typecheck", state: "success" }],
      readErrors: { commits: "Reading commits failed (500)", files: "Reading files failed (500)" },
      readLimits: { commits: "Showing 250 of 412 commits.", checks: "Showing 100 of 240 check runs." },
      // Signed out, a GitHub source's tab is not read and asks for sign-in.
      signInTabs: ["checks"],
      branch: "serve-files",
      baseBranch: "main",
      draft: false,
      createdAt: "2026-09-04T08:00:00Z",
      authorAvatar: "https://avatars.githubusercontent.com/u/2",
      labels: ["api"],
      labelColors: { api: "1d76db" },
      commits: [{
        changeId: "kkmpptxz",
        commitId: "a1b2c3d4",
        message: "Serve repository files",
        author: "will",
        timestamp: "2026-09-04T08:00:00Z"
      }],
      files: [{
        path: "src/files.ts",
        oldPath: "src/read.ts",
        status: "renamed",
        additions: 12,
        deletions: 3,
        patch: "@@ -1 +1 @@"
      }]
    }
  },
  stack: {
    minimal: { repo: "smithersai/smithers", failure: null },
    full: {
      repo: "smithersai/smithers",
      failure: {
        act: "todo",
        message: "Refused",
        args: "{\"title\":\"Fix the footer\",\"repo\":\"smithersai/smithers\"}"
      },
      bootstrap: { requestedAt: 1 },
      todos: [{ key: "0a1b2c3d", title: "Fix the footer", body: "", requestedAt: 1, item: "item-9" }, {
        key: "4e5f6a7b",
        title: "Add a link",
        body: "In the footer.",
        requestedAt: 2
      }],
      view: "metrics"
    }
  },
  secrets: {
    minimal: { repo: "smithersai/smithers", scope: "repository", secrets: [] },
    full: {
      repo: "smithersai/smithers",
      scope: "repository",
      secrets: [{
        name: "OPENAI_API_KEY",
        hosts: ["api.openai.com"],
        matchHeaders: ["authorization"],
        updatedAt: "2026-09-05T09:00:00Z",
        mainOnly: true,
        reconnect: true
      }]
    }
  },
  "sync-ops": {
    minimal: { subject: "Mirror · smithersai/smithers", source: "github-mirror", runState: null, ops: [] },
    full: {
      subject: "Mirror · smithersai/smithers",
      source: "github-mirror",
      repo: "smithersai/smithers",
      runId: "run-1",
      runState: "running",
      counts: { total: 40, done: 12, failed: 1 },
      mirrorStatus: "behind",
      behindRefs: 3,
      failedRefs: 1,
      trigger: "sync started",
      ops: [{
        id: "op-1",
        source: "github-mirror",
        target: "github",
        entity: "issue",
        entityId: "ENG-482",
        action: "upsert",
        status: "failed",
        error: "the wire refused (500)",
        retryable: true,
        at: "2026-09-05T09:00:00Z"
      }],
      opsNote: "the feed did not answer",
      window: "24h",
      expanded: true,
      hasOlder: true,
      opsCursor: "cursor-1",
      rateLimit,
      error: "the retry refused (500)"
    }
  },
  "file-list": {
    minimal: { repo: "smithersai/smithers", path: "packages/rpc", entries: [] },
    full: {
      repo: "smithersai/smithers",
      localRepoId: "repo-1",
      path: "packages/rpc",
      entries: [{ name: "src", kind: "dir" }, { name: "PACKAGE.ts", kind: "file" }],
      truncated: true,
      address: "/smithersai/smithers/packages/rpc",
      ref: "release/1.2",
      readAt: { changeId: "qupxosqw", commitId: "a03f5f1e", source: "working-copy" }
    }
  },
  file: {
    minimal: { repo: "smithersai/smithers", path: "README.md", content: "# hi\n", truncated: false },
    full: {
      file: {
        path: "README.md",
        branch: "b12",
        language: "markdown",
        digest: "digest-2",
        content: { kind: "text", text: "# current\n" },
        mode: "read_only",
        diagnostics: [],
        authors: [],
        editors: []
      },
      compare: true,
      comparison: { version: "versions-17", text: "# before\n" },
      workspaceId: gatewayWorkspaceId,
      repo: "smithersai/smithers",
      localRepoId: "repo-1",
      path: "README.md",
      content: "# hi\n",
      originalSize: 20000,
      truncated: true,
      binary: false,
      address: "/smithersai/smithers/README.md",
      readAt: { changeId: "qupxosqw", commitId: "a03f5f1e", seq: 5, source: "head" },
      ref: "a03f5f1ea03f5f1ea03f5f1ea03f5f1ea03f5f1e",
      line: 317,
      column: 62,
      digest: "sha256-9f1c",
      diagnostics: [{
        line: 317,
        character: 62,
        endLine: 317,
        endCharacter: 68,
        severity: "warning",
        message: "unused",
        source: "ts",
        code: "6133"
      }],
      diagnosticsTotal: 900,
      hover: { line: 63, character: 7, contents: "const isRecord", truncated: true },
      intel: { state: "ready", note: "typescript-language-server 4.3.3" }
    }
  },
  change: {
    minimal: {
      repo: "smithersai/smithers",
      changeId: "qupxosqw",
      description: "Serve repository files",
      commitId: null,
      currentSeq: null,
      revisionCount: null,
      revisions: [],
      authorName: null,
      timestamp: null,
      repos: [],
      diff: null,
      checks: null,
      findings: null,
      reviews: null,
      threads: null,
      conflicts: null,
      stack: null,
      changeset: null
    },
    full: {
      pullRequest: { number: 50, url: "https://github.com/acme/app/pull/50" },
      repo: "smithersai/smithers",
      changeId: "qupxosqw",
      description: "Serve repository files through one bounded route",
      commitId: "a03f5f1e",
      currentSeq: 5,
      revisionCount: 5,
      revisions: [{
        seq: 5,
        commitId: "a03f5f1e",
        parentCommitId: "9910aa2b",
        source: "agent",
        agentSessionId: "sess-1",
        workspaceSnapshotId: "snap-1",
        operationIds: ["op-1"],
        createdAt: "2026-09-05T09:00:00Z"
      }],
      authorName: "will",
      timestamp: "2026-09-05T09:00:00Z",
      repos: [{ repo: "smithersai/smithers", additions: 312, deletions: 41 }],
      diff: {
        from: "parent",
        to: "current",
        files: [{
          path: "src/a.ts",
          oldPath: "src/old.ts",
          changeType: "renamed",
          isBinary: false,
          additions: 3,
          deletions: 1,
          patch: "@@ -1 +1 @@",
          patchLines: 1,
          conflicted: true
        }],
        sinceReview: { reviewer: "will", seq: 4 }
      },
      checks: [{
        context: "typecheck",
        state: "success",
        targetsAffected: 12,
        targetsRan: 3,
        targetsCached: 9,
        durationMs: 4900,
        workspaceId: "ws-1"
      }],
      checksAt: 5,
      findings: [{
        id: 7,
        analyzer: "lint",
        source: "eslint",
        severity: "warn",
        path: "src/a.ts",
        line: 3,
        summary: "unused",
        suggestion: "delete it",
        raisedAtSeq: 3,
        commitId: "9910aa2b",
        state: "stale",
        feedback: "useful"
      }],
      analyzers: [{
        name: "lint",
        state: "failed",
        seq: 5,
        startedAt: "2026-09-05T09:00:00Z",
        finishedAt: "2026-09-05T09:01:00Z",
        pausedBy: null,
        pausedReason: null,
        failureReason: "exit 1"
      }],
      reviews: [{
        reviewer: "sess-2",
        reviewerLogin: "Reviewer · Astra",
        reviewerKind: "agent",
        verdict: "concerns",
        type: "request_changes",
        confidence: "high",
        summary: "the route is unbounded",
        commitId: "a03f5f1e",
        seq: 5,
        lastReviewedSeq: 4
      }],
      threads: [{
        id: 3,
        path: "src/a.ts",
        line: 12,
        currentLine: 14,
        body: "why bounded?",
        author: null,
        createdAt: "2026-09-05T09:00:00Z",
        state: "done",
        anchor: "moved",
        commitId: "a03f5f1e",
        resolvedInRevision: { commitId: "a03f5f1e", seq: 5 }
      }],
      reviewRequests: [{
        id: 9,
        reviewer: "will",
        agent: null,
        requestedBy: "ada",
        state: "requested",
        createdAt: "2026-09-05T09:00:00Z"
      }],
      conflicts: [{ path: "src/a.ts", state: "unresolved" }],
      stack: {
        landingNumber: 12,
        state: "open",
        position: 2,
        size: 3,
        changeIds: ["yyyrqlqw", "qupxosqw", "ronvznsk"],
        targetBookmark: "main",
        conflictStatus: "none",
        positionFrom: "server",
        landablePrefix: 1,
        blockedBy: [{
          kind: "owner",
          name: "will",
          repo: "smithersai/smithers",
          missing: "approval",
          count: 1,
          path: "src/a.ts",
          candidates: ["will", "ada"]
        }]
      },
      turn: {
        party: "author",
        actorId: "u-1",
        actorLogin: "will",
        since: "2026-09-05T09:00:00Z",
        reason: "changes requested"
      },
      owners: {
        touchedPaths: [{
          path: "src/a.ts",
          owners: ["will"],
          agentPolicy: "human-approve",
          satisfiedBy: { login: "will", seq: 5 }
        }],
        requiredApprovers: ["will"],
        suggestedReviewers: ["ada"],
        missingApprovals: [{ path: "src/b.ts", candidates: ["ada"] }]
      },
      landed: {
        at: "2026-09-05T09:02:00Z",
        by: "will",
        landingRequestNumber: 12,
        approvedBy: [{ login: "will", seq: 5 }]
      },
      walkthrough: {
        seq: 5,
        sections: [{ title: "The route", markdown: "one bounded read", diagram: null }]
      },
      changeset: {
        id: 7,
        organization: "smithersai",
        superproject: "smithersai/super",
        changeId: "qupxosqw",
        state: "landed",
        failureReason: null,
        targetBookmark: "main",
        members: [{
          repository: "smithersai/api",
          path: "api",
          changeId: "qupxosqw",
          commitId: "a03f5f1e",
          targetBookmark: "main",
          previousCommitId: null,
          landedCommitId: "a03f5f1e"
        }]
      },
      unread: {
        diff: "Reading the diff failed (500)",
        conflicts: "Reading conflicts failed (500)",
        checks: "Reading statuses failed (500)",
        findings: "Reading findings failed (500)",
        reviews: "Reading reviews failed (500)",
        threads: "Reading threads failed (500)",
        reviewRequests: "Reading review requests failed (500)",
        stack: "upstream down",
        changeset: "Reading the changeset failed (500)",
        walkthrough: "Reading the walkthrough failed (500)"
      },
      facet: "diff",
      error: "Land refused (409)"
    }
  },
  diff: {
    minimal: {
      repo: "smithersai/smithers",
      changeId: "qupxosqw",
      from: "parent",
      to: "current",
      pin: { changeId: "qupxosqw", seq: null, commitId: null },
      files: []
    },
    full: {
      branchDiffSource: "scratch/ben/try-retry",
      branchDiffEntry: "6ad2b1a9-1869-4d1a-b087-8ba32a09b102",
      branchDiffRequest: "diff-request-1",
      branchDiffPending: false,
      branchFiles: [{
        path: "retry.ts",
        branch: "b12",
        against: { kind: "item_base", rev: "candidate-11" },
        change: "modified",
        hunks: [{
          old_start: 1,
          new_start: 1,
          lines: [{ op: "-", text: "const n = 1" }, { op: "+", text: "const n = 2" }]
        }]
      }],
      repo: "smithersai/smithers",
      changeId: "qupxosqw",
      from: "4",
      to: "5",
      pin: { changeId: "qupxosqw", seq: 5, commitId: "a03f5f1e" },
      files: [{
        path: "src/a.ts",
        oldPath: "src/old.ts",
        changeType: "renamed",
        isBinary: false,
        additions: 3,
        deletions: 1,
        patch: "@@ -1 +1 @@",
        patchLines: 1,
        conflicted: true
      }],
      path: "src/a.ts",
      error: "Reading the diff failed (500)"
    }
  },
  "environment-images": {
    minimal: { repo: "smithersai/smithers", images: [] },
    full: {
      repo: "smithersai/smithers",
      images: [{
        id: "img-1",
        kind: "vm",
        source: ".smithers/environment.nix",
        sourceRevision: "4e87ac15",
        closureHash: "sha256-9f1c",
        image: "registry.jjhub.tech/env:4e87ac15",
        status: "built",
        platformBase: false,
        coldPull: true
      }]
    }
  },
  agents: {
    minimal: { native: false, agents: [] },
    full: {
      native: true,
      agents: [builtInCardRow],
      error: "the harness signals failed"
    }
  },
  "flow-form": {
    minimal: { flow: "tab.harness", via: "user", fields: [], draft: {}, given: {} },
    full: {
      flow: "tab.harness",
      via: "agent",
      fields: [{
        name: "harness",
        label: "Harness",
        kind: "select",
        required: true,
        placeholder: "codex",
        options: [{ value: "opencode", label: "OpenCode", disabled: true, reason: "no credential" }],
        optionsFrom: "cloud-repos"
      }],
      draft: { id: "implement", retries: 2, verbose: true },
      given: { id: "implement" },
      afterBox: {
        kind: "prs.triage",
        repo: "smithersai/smithers",
        number: 123,
        owner: "smithersai",
        workspaceId: "ws-review",
        consumed: true
      },
      submitting: true,
      submitLabel: "Run flow",
      payloadField: "input",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      error: "the submit refused (500)",
      errorKind: "run"
    }
  },
  "search-results": {
    minimal: { query: "bounded", flow: "search.wiki", items: [] },
    full: {
      query: "bounded",
      flow: "search.wiki",
      args: "--kind wiki",
      items: [{
        kind: "wiki",
        ref: "wiki/bounded-reads.md",
        title: "Bounded reads",
        subtitle: "Librarian",
        actions: [{ flow: "wiki.open", args: "wiki/bounded-reads.md", label: "Open", role: "open" }]
      }],
      refusal: {
        sentence: "The wiki index could not be read. Something Smithers reads from refused.",
        fault: "dependency"
      }
    }
  },
  "wiki-links": {
    minimal: { path: "wiki/bounded-reads.md", title: "Bounded reads", backlinks: [], linksOut: [], unresolved: [] },
    full: {
      path: "wiki/bounded-reads.md",
      title: "Bounded reads",
      backlinks: [{ path: "wiki/routes.md", title: "Routes" }],
      linksOut: [{ path: "wiki/caps.md", title: "Caps" }],
      unresolved: ["quarantine"]
    }
  },
  "wiki-graph": {
    minimal: { path: null, notes: [], links: [] },
    full: {
      path: "wiki/bounded-reads.md",
      notes: [{
        path: "wiki/bounded-reads.md",
        title: "Bounded reads",
        linksOut: ["wiki/caps.md"],
        backlinks: ["wiki/routes.md"],
        missing: false
      }],
      links: [{ source: "wiki/bounded-reads.md", target: "wiki/caps.md" }]
    }
  },
  /* A wiki page's history (#1922): the full row includes pinned content, a rename and deletion. */
  "wiki-history": {
    minimal: {
      repo: "smithersai/smithers",
      space: "public",
      pageId: 1,
      slug: "home",
      title: "Home",
      path: "Home.md",
      revisions: [],
      page: 1,
      hasNext: false
    },
    full: {
      content: { revision: 1, markdown: "# Saved revision" },
      repo: "smithersai/smithers",
      space: "private",
      pageId: 3,
      slug: "generated-3",
      title: "logo.png",
      path: "assets/logo.png",
      revisions: [
        {
          revision: 3,
          title: "logo.png",
          path: "assets/logo.png",
          author: "will",
          at: "2026-09-26T03:00:00Z",
          deleted: true,
          digest: "c".repeat(64)
        },
        {
          revision: 2,
          title: "logo.png",
          path: "assets/logo.png",
          author: "ada",
          at: "2026-09-26T02:00:00Z",
          deleted: false,
          digest: "b".repeat(64),
          attachment: { digest: "b".repeat(64), mediaType: "image/png", size: 68 }
        },
        {
          revision: 1,
          title: "logo.png",
          path: "Old/logo.png",
          author: "will",
          at: "2026-09-26T01:00:00Z",
          deleted: false,
          digest: "a".repeat(64),
          attachment: { digest: "a".repeat(64), mediaType: "image/png", size: 68 }
        }
      ],
      page: 1,
      hasNext: true
    }
  },
  "anonymous-ceiling": {
    minimal: { message: "too many turns from this address", retryAt: null },
    full: { message: "too many turns from this address", retryAt: "2026-09-05T10:00:00Z" }
  },
  "debug-api": { minimal: {}, full: {} },
  docs: {
    minimal: { page: "quickstart", markdown: "" },
    full: {
      page: "quickstart",
      markdown: "## Open a flow\n\nRead [Flows](flows.md).\n",
      summary: "Read",
      toc: [{ slug: "quickstart", title: "Quickstart" }],
      anchor: "open-a-flow",
      not_found: "missing"
    }
  },
  retired: { minimal: {}, full: { was: "explain", recorded: { text: "Saved explanation" } } }
}

test("repository home schema decodes every resolution and refuses unsafe paths", () => {
  expect(RepositoryHomeSchema.safeParse({ kind: "none" }).success).toBe(true)
  expect(RepositoryHomeSchema.safeParse({ kind: "readme", markdown: "# Hello" }).success).toBe(true)
  expect(RepositoryHomeSchema.safeParse(FIXTURES["factory.home"].full.home).success).toBe(true)
  for (
    const path of ["/etc/passwd", "../README.md", "a/../README.md", "https://example.com", "a\\b", "%2e%2e/secret"]
  ) {
    expect(
      RepositoryHomeSchema.safeParse({ kind: "blocks", blocks: [{ type: "markdown", path, markdown: "x" }] }).success
    ).toBe(false)
  }
  expect(
    RepositoryHomeSchema.safeParse({ kind: "blocks", blocks: [{ type: "ci-benchmark", measures: ["cold"] }] }).success
  ).toBe(false)
})

/* mvp.md §8: old Cut cards decode inertly; retained kinds keep their schema audits. */

const kinds = CardSchema.options.map((option) => option.shape.kind.value)
const card = (kind: string, payload: unknown): unknown => ({
  ...base,
  kind,
  payload,
  ...((kind === "draft" || kind === "confirm") ? { audience_member_id: "ben" } : {})
})

/** The fields a kind's payload declares, or null when the payload is a union of stages rather than one object. */
const payloadFields = (kind: string): Record<string, z.ZodType> | null => {
  const payload = CardSchema.options.find((option) => option.shape.kind.value === kind)?.shape.payload
  return payload instanceof z.ZodObject ? payload.shape as Record<string, z.ZodType> : null
}

/**
 * True when the schema accepts the field's absence and leaves it absent: the
 * "optional so older cards parse" promise. A field carrying a default also
 * accepts absence, but fills itself in, so the payload read back off disk
 * states it. It belongs in the minimal fixture, where the assertions below can
 * see exactly what a card written before that field now decodes to.
 */
const optional = (schema: z.ZodType): boolean => {
  const absent = schema.safeParse(undefined)
  return absent.success && absent.data === undefined
}

/** Union payloads have branch-specific compatibility checks below. */
const objectKinds = kinds.filter((kind) => payloadFields(kind) !== null)

describe("every persisted card kind", () => {
  test("has fixtures: a kind added to the union without them is the gap this table closes", () => {
    expect(Object.keys(FIXTURES).sort())
      .toEqual(
        [...kinds].sort()
      )
  })

  test("every union payload has an explicit branch audit below", () => {
    expect(kinds.filter((kind) => payloadFields(kind) === null)).toEqual(["agents"])
  })

  test.each(objectKinds)("%s: the fixtures name every field the payload declares, and no more", (kind) => {
    const fields = payloadFields(kind)!
    const { full, minimal } = FIXTURES[kind]
    /*
     * The full fixture is the whole contract, so adding a field to a payload
     * fails here until a fixture states it; the minimal fixture is exactly
     * the required set, so promoting an optional field to required fails
     * here too — which is the compatibility promise those fields carry.
     */
    expect(Object.keys(full).sort()).toEqual(Object.keys(fields).sort())
    expect(Object.keys(minimal).sort()).toEqual(
      Object.keys(fields).filter((field) => !optional(fields[field]!)).sort()
    )
  })

  test.each(kinds)("%s parses at its minimum and at its maximum, and neither is rewritten", (kind) => {
    const { full, minimal } = FIXTURES[kind]

    const lean = CardSchema.parse(card(kind, minimal))
    expect(lean.kind).toBe(kind)
    expect(lean.payload).toEqual(minimal)
    /*
     * Nothing is defaulted into a payload written before a later lane: an
     * unstated field stays absent, so the body renders nothing rather than a
     * guess, and re-persisting the card cannot invent history.
     */
    expect(Object.keys(lean.payload).sort()).toEqual(Object.keys(minimal).sort())

    const rich = CardSchema.parse(card(kind, full))
    expect(rich.payload).toEqual(full)

    /* Decoding is idempotent: a card read back off disk decodes to itself. */
    expect(CardSchema.parse(lean)).toEqual(lean)
    expect(CardSchema.parse(rich)).toEqual(rich)
  })

  test("a whole frame snapshot of one card per kind parses (the old app's FrameSnapshotSchema)", () => {
    const snapshot = z.object({ cards: z.array(CardSchema) })
    const cards = kinds.map((kind, ordinal) => ({
      ...(card(kind, FIXTURES[kind].full) as Record<string, unknown>),
      ordinal
    }))
    expect(snapshot.parse({ cards }).cards).toHaveLength(kinds.length)
  })

  test("an unknown kind fails decoding", () => {
    expect(CardSchema.safeParse({ ...base, kind: "moons", payload: {} }).success).toBe(false)
  })

  test("unknown cards remain readable inside agent frames", () => {
    const frame = AgentTurnFrameSchema.parse({
      runId: "old-run",
      type: "card",
      card: {
        ...base,
        kind: "explain",
        payload: legacyCards.find((fixture) => fixture.row.kind === "explain")!.row.payload
      }
    })
    expect(frame).toEqual({
      runId: "old-run",
      type: "card",
      card: {
        ...base,
        kind: "retired",
        loading: false,
        status: "acted",
        payload: {
          was: "explain",
          recorded: legacyCards.find((fixture) => fixture.row.kind === "explain")!.row.payload
        }
      }
    })
  })

  /*
   * The rows are one-element TUPLES, not bare values: a bare `undefined` row
   * leaves the single-parameter callback looking like a `done`-style one to
   * the runner, so both of these timed out after five seconds instead of
   * asserting anything — two rows of invalid-input coverage that had silently
   * stopped running. A tuple row is spread, so the parameter is the value.
   */
  test.each([[null], [undefined], [1], ["card"], [[]]])("a non-card value %j fails", (value) => {
    expect(CardSchema.safeParse(value).success).toBe(false)
  })

  test.each([[undefined], [null], [3], [{}], [[]]])("a non-string kind %j fails", (kind) => {
    expect(CardSchema.safeParse({ ...base, kind, payload: {} }).success).toBe(false)
  })

  test.each(kinds.filter((kind) => kind !== "retired"))("malformed current %s is never a tombstone", (kind) => {
    expect(CardSchema.safeParse({ ...base, kind, payload: null }).success).toBe(false)
  })

  test("a missing kind and a malformed existing tombstone fail", () => {
    expect(CardSchema.safeParse({ ...base, payload: {} }).success).toBe(false)
    expect(CardSchema.safeParse({ ...base, kind: "retired", payload: { was: 42 } }).success).toBe(false)
    expect(CardSchema.safeParse({ ...base, kind: "retired", payload: null }).success).toBe(false)
  })

  test.each([{}, { was: "explain" }])("existing tombstones preserve optional was: %j", (payload) => {
    const row = { ...base, kind: "retired", payload }
    const decoded = CardSchema.parse(row)
    expect(decoded).toEqual(row)
    expect(CardSchema.parse(decoded)).toEqual(decoded)
  })

  test.each(["", "Saved title"])("legacy kinds keep the stored title: %j", (title) => {
    const decoded = CardSchema.parse({
      ...base,
      kind: "explain",
      title,
      body: "Private",
      payload: { secret: "Private" }
    })
    expect(decoded).toEqual({
      ...base,
      title,
      kind: "retired",
      status: "acted",
      loading: false,
      body: "Private",
      payload: { was: "explain", recorded: { secret: "Private" } }
    })
    expect(CardSchema.parse(decoded)).toEqual(decoded)
  })

  test("deadline and cached report fields retain their declared types when present", () => {
    for (const deadlineAt of ["1790000900000", null]) {
      expect(CardSchema.safeParse(card("run-trace", { ...FIXTURES["run-trace"].full, deadlineAt })).success).toBe(false)
    }
  })

  test("PR read failures and repository import launch identity refuse invalid persisted values", () => {
    expect(CardSchema.safeParse(card("pr", { ...FIXTURES.pr.full, readErrors: { commits: 500 } })).success).toBe(false)
    // A GitHub source's checks are one read that can be refused, so the tab
    // carries its own reason beside commits and files.
    const refusedChecks = CardSchema.safeParse(
      card("pr", { ...FIXTURES.pr.full, readErrors: { checks: "Checks unavailable (Read failed (HTTP 502).)" } })
    )
    expect(refusedChecks.success).toBe(true)
    expect(
      refusedChecks.success && refusedChecks.data.kind === "pr"
        ? refusedChecks.data.payload.readErrors?.checks
        : undefined
    )
      .toBe("Checks unavailable (Read failed (HTTP 502).)")
    expect(CardSchema.safeParse(card("pr", { ...FIXTURES.pr.full, readErrors: { checks: 502 } })).success).toBe(false)

    // Rows that are real but not all of them: GitHub pages both list reads
    // and stops a pull request's commit list at 250, so `readLimits` is the
    // sentence beside the rows. Optional, a string, and never the files tab's
    // business (one diff read is whole or it is refused).
    const partial = CardSchema.safeParse(
      card("pr", { ...FIXTURES.pr.full, readLimits: { commits: "Showing 250 of 412 commits." } })
    )
    expect(partial.success).toBe(true)
    expect(partial.success && partial.data.kind === "pr" ? partial.data.payload.readLimits?.commits : undefined)
      .toBe("Showing 250 of 412 commits.")
    expect(CardSchema.safeParse(card("pr", { ...FIXTURES.pr.full, readLimits: { commits: 250 } })).success).toBe(false)
    expect(CardSchema.safeParse(card("pr", { ...FIXTURES.pr.full, readLimits: {} })).success).toBe(true)

    // The tabs that wait on sign-in are named by tab, and only these three.
    const signIn = CardSchema.safeParse(card("pr", { ...FIXTURES.pr.full, signInTabs: ["commits", "checks", "files"] }))
    expect(signIn.success && signIn.data.kind === "pr" ? signIn.data.payload.signInTabs : undefined)
      .toEqual(["commits", "checks", "files"])
    expect(CardSchema.safeParse(card("pr", { ...FIXTURES.pr.full, signInTabs: ["conversation"] })).success).toBe(false)
    expect(CardSchema.safeParse(card("pr", { ...FIXTURES.pr.full, signInTabs: "commits" })).success).toBe(false)

    // A list that is one page of more says so with one boolean, never a count of its own.
    for (const kind of ["issue-list", "pr-list"] as const) {
      const partial = CardSchema.safeParse(card(kind, FIXTURES[kind].full))
      expect(
        partial.success && (partial.data.kind === "issue-list" || partial.data.kind === "pr-list")
          ? partial.data.payload.partial
          : undefined
      ).toBe(true)
      expect(CardSchema.safeParse(card(kind, { ...FIXTURES[kind].full, partial: "30+" })).success).toBe(false)
      expect(CardSchema.safeParse(card(kind, { ...FIXTURES[kind].full, partial: 30 })).success).toBe(false)
    }
  })
})

describe("every card patch", () => {
  test.each(kinds)("%s takes an empty patch and its own full payload", (kind) => {
    expect(CardPatchSchema.parse({ kind })).toEqual({ kind })
    expect(CardPatchSchema.safeParse({ kind, payload: FIXTURES[kind].full }).success).toBe(true)
  })

  test.each(kinds)("%s refuses a negative ordinal, a foreign payload field, and a patch with no kind", (kind) => {
    expect(CardPatchSchema.safeParse({ kind, ordinal: -1 }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ kind, ordinal: 1.5 }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ kind, status: "melting" }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ payload: FIXTURES[kind].full }).success).toBe(false)
  })

  test("an unknown kind is refused", () => {
    expect(CardPatchSchema.safeParse({ kind: "moons" }).success).toBe(false)
  })
})

/*
 * The targets table's own state and the rate-limit line: read off a card
 * payload, so they carry the same persistence promise as the cards do.
 */
describe("the targets table's view and detail", () => {
  test("an empty view is the default view: every field is optional and none is defaulted in", () => {
    expect(TargetsViewSchema.parse({})).toEqual({})
  })

  test("a full view round-trips, and a mode or run state outside the enums is refused", () => {
    const view = {
      mode: "all",
      query: "rpc",
      kinds: ["test"],
      states: ["passed"],
      workspace: ".",
      selected: "//packages/rpc:test",
      expanded: ["//...:test"],
      picked: { "//...:test": ["//packages/rpc:test"] }
    }
    expect(TargetsViewSchema.parse(view)).toEqual(view)
    expect(TargetsViewSchema.safeParse({ mode: "starred" }).success).toBe(false)
    expect(TargetsViewSchema.safeParse({ states: ["flaky"] }).success).toBe(false)
    expect(TargetsViewSchema.safeParse({ picked: { "//...:test": "one" } }).success).toBe(false)
  })

  test("a detail states its status alone until the plan is read, and refuses a status outside the three", () => {
    expect(TargetDetailSchema.parse({ status: "pending" })).toEqual({ status: "pending" })
    expect(TargetDetailSchema.safeParse({ status: "running" }).success).toBe(false)
    expect(TargetDetailSchema.safeParse({}).success).toBe(false)
  })
})

describe("a GitHub call's rate limit", () => {
  test("carries the three wire facts, with a null reset when the wire names none", () => {
    expect(GitHubRateLimitSchema.parse(rateLimit)).toEqual(rateLimit)
    expect(GitHubRateLimitSchema.parse({ limit: 0, remaining: 0, resetAt: null }).resetAt).toBeNull()
  })

  test("refuses a negative or fractional count and an absent reset — an unread reset is null, never missing", () => {
    expect(GitHubRateLimitSchema.safeParse({ limit: -1, remaining: 0, resetAt: null }).success).toBe(false)
    expect(GitHubRateLimitSchema.safeParse({ limit: 5000, remaining: 1.5, resetAt: null }).success).toBe(false)
    expect(GitHubRateLimitSchema.safeParse({ limit: 5000, remaining: 42 }).success).toBe(false)
  })
})

describe("removed presentation compatibility", () => {
  // Pin the Cut contract independently of the schema and retirement registry.
  const cutKinds = [
    "admin-health",
    "agent",
    "commit",
    "commit-list",
    "connect",
    "grant-confirm",
    "notifications",
    "registration",
    "repository-setup"
  ] as const
  test("the cut manifest records exactly the removed card kinds", () => {
    const manifest = JSON.parse(readFileSync(new URL("../src/catalog/cuts.json", import.meta.url), "utf8")) as {
      rows: { disposition: string; cardKinds: string[] }[]
    }
    expect(manifest.rows.filter((row) => row.disposition === "cut").flatMap((row) => row.cardKinds).sort())
      .toEqual([...cutKinds].sort())
  })
  test.each(cutKinds)("Cut %s preserves stored identity and content as an inert record", (kind) => {
    expect(CardSchema.options.map((option) => option.shape.kind.value)).not.toContain(kind)
    expect(LEGACY_CARD_KINDS).toContain(kind)
    const row = legacyCards.find((fixture) => fixture.row.kind === kind)!.row
    expect(CardSchema.parse(row)).toEqual({
      id: row.id,
      ordinal: row.ordinal,
      createdAt: row.createdAt,
      title: row.title,
      kind: "retired",
      status: "acted",
      loading: false,
      ...("body" in row ? { body: row.body } : {}),
      payload: { was: kind, recorded: row.payload }
    })
  })
  const saved = (kind: string, payload: unknown) => ({
    ...base,
    title: `Saved ${kind}`,
    kind,
    payload,
    body: "Old content",
    loading: true
  })
  const retired = legacyCards
    .filter((fixture) => (LEGACY_CARD_KINDS as readonly string[]).includes(fixture.row.kind))
    .map((fixture) => saved(fixture.row.kind, fixture.row.payload))
  test.each(retired)("retires $kind without losing the card identity", (row) => {
    const result = CardSchema.parse(JSON.parse(JSON.stringify(row)))
    expect(result).toEqual({
      ...base,
      title: row.title,
      kind: "retired",
      status: "acted",
      payload: {
        was: row.kind,
        recorded: row.kind === "env"
          ? { ...row.payload as Record<string, unknown>, vars: [{ name: "DATABASE_URL" }, { name: "PIN" }] }
          : row.payload
      },
      body: row.body,
      loading: false
    })
    expect(result.body).toBe(row.body)
    expect(CardSchema.parse(result)).toEqual(result)
    expect(z.object({ cards: z.array(CardSchema) }).parse({ cards: [row] }).cards).toEqual([result])
    expect(CardPatchSchema.safeParse({ kind: row.kind, payload: row.payload }).success).toBe(false)
  })
  test("the old snapshot facet retires while its recorded snapshots survive", () => {
    const old = saved("workspace", {
      workspaceId: "ws-1",
      facet: "snapshots",
      snapshot: true,
      snapshots: [{ id: "old", name: "Old", createdAt: null }]
    })
    const result = CardSchema.parse(old)
    expect(result.kind).toBe("retired")
    expect(result.payload).toEqual({ was: "workspace", recorded: old.payload })
  })
})

test("a stored trigger card from the retired trigger store still decodes, without the fields nothing writes", () => {
  const row = {
    id: "trg-1",
    slug: "nightly",
    flowId: "ci",
    cron: "0 * * * *",
    enabled: true,
    nextFireAt: 1_757_003_600_000
  }
  const stored = {
    repo: "smithersai/smithers",
    live: true,
    triggers: [{
      ...row,
      lastFiredAt: 1_757_000_000_000,
      activeRunId: "run-1",
      nextFiresAt: [1_757_003_600_000],
      overlap: "skip",
      catchUp: "one",
      maxCatchUp: 3,
      pendingAt: 1_757_003_600_000,
      schedulerLastTickAt: 1_757_000_500_000,
      fires: [{ occurrenceAt: 1_757_000_000_000, outcome: "launched", runId: "run-1" }]
    }],
    webhooks: [{ name: "github", flowId: "ci" }]
  }
  const decoded = CardSchema.parse(card("trigger-list", stored)) as { payload: unknown }
  expect(decoded.payload).toEqual({ repo: "smithersai/smithers", live: true, triggers: [row] })
})

test("a saved local repository receipt drops its retired path", () => {
  const parsed = CardSchema.parse(card("repository-choice", {
    cutoff: "2026-08-10T00:00:00Z",
    partial: false,
    error: null,
    selected: "smithers-playground",
    created: { name: "smithers-playground", path: "/tmp/smithers-playground" },
    repositories: []
  }))
  expect(parsed.kind).toBe("repository-choice")
  expect(parsed.payload).toMatchObject({ created: { fullName: "smithers-playground" } })
  expect(parsed.payload).not.toHaveProperty("created.path")
})

test("saved provider sync settings disappear while native conversation history and sends remain", () => {
  const old = {
    ...base,
    kind: "issue",
    payload: {
      ...FIXTURES.issue.minimal,
      kind: "chat",
      comments: [{ author: "U001", commentBody: "historical", createdAt: null, origin: "slack" }],
      pendingComments: [{ id: "native-send", text: "reply", actor: "user", status: "requested" }],
      sync: {
        provider: "telegram",
        connectionId: "bot",
        scopeId: "123",
        conversationId: "-100",
        state: "outcome_unknown"
      }
    }
  }
  const migrated = CardSchema.parse(old)
  expect(migrated.kind).toBe("issue")
  expect(migrated.payload).not.toHaveProperty("sync")
  expect(migrated.payload).toMatchObject({
    comments: [{ origin: "slack", commentBody: "historical" }],
    pendingComments: [{ id: "native-send", status: "requested" }]
  })
  expect(CardSchema.parse(migrated)).toEqual(migrated)
})

describe("pinned historical storage", () => {
  test("covers the current union and every explicitly legacy name without overlap", () => {
    const current = CardSchema.options.map((option) => option.shape.kind.value)
    expect(current).toContain("retired")
    expect(current.filter((kind) => (LEGACY_CARD_KINDS as readonly string[]).includes(kind))).toEqual([])
    const pinned = legacyCards.map((fixture) => fixture.row.kind)
    for (const kind of [...current, ...LEGACY_CARD_KINDS]) expect(pinned).toContain(kind)
  })

  test.each(legacyCards)("stored $row.kind preserves its literal title, payload and decode outcome", (fixture) => {
    const decoded = CardSchema.parse(fixture.row)
    expect(decoded.kind).toBe(fixture.expectedKind)
    expect(decoded.title).toBe(fixture.expectedTitle)
    if (fixture.expectedKind === "retired") {
      expect(decoded.body).toBe("body" in fixture.row ? fixture.row.body : undefined)
      expect(decoded).not.toHaveProperty("retiredKind")
      expect(decoded.payload).toEqual(
        fixture.row.kind === "retired"
          ? fixture.row.payload
          : {
            was: fixture.expectedWas,
            recorded: fixture.row.kind === "env"
              ? { ...fixture.row.payload, vars: [{ name: "DATABASE_URL" }, { name: "PIN" }] }
              : fixture.row.payload
          }
      )
    } else {
      // Zod strips undeclared keys, so a schema that stops declaring a stored field would drop it here.
      expect(decoded.payload).toEqual(fixture.row.payload)
    }
    expect(CardSchema.parse(decoded)).toEqual(decoded)
  })

  test.each([
    { kind: "flow-form", payload: { flow: "wiki.ask", private: "PRIVATE" } },
    { kind: "issue", payload: { source: "linear", private: "PRIVATE" } },
    { kind: "issue-list", payload: { source: "linear", private: "PRIVATE" } },
    { kind: "issue-list", payload: { issues: [{ source: "linear", private: "PRIVATE" }] } }
  ])("payload-specific $kind retirement uses the same tombstone", ({ kind, payload }) => {
    const decoded = CardSchema.parse({ ...base, kind, title: "<img src=x onerror=alert(1)>", body: "PRIVATE", payload })
    expect(decoded).toEqual({
      ...base,
      kind: "retired",
      title: "<img src=x onerror=alert(1)>",
      status: "acted",
      loading: false,
      body: "PRIVATE",
      payload: { was: kind, recorded: payload }
    })
    expect(CardSchema.parse(decoded)).toEqual(decoded)
  })

  test("existing tombstones keep body while validating their payload fields", () => {
    const decoded = CardSchema.parse({
      ...base,
      kind: "retired",
      body: "PRIVATE",
      payload: { was: "explain", secret: "PRIVATE" }
    })
    expect(decoded).toEqual({ ...base, kind: "retired", body: "PRIVATE", payload: { was: "explain" } })
    expect(CardSchema.parse(decoded)).toEqual(decoded)
  })

  test("non-cloud agents and unretired forms retain validation", () => {
    expect(CardSchema.parse({ ...base, kind: "agents", payload: { native: true, agents: [] } }).kind).toBe("agents")
    expect(CardSchema.safeParse({ ...base, kind: "agents", payload: { native: true, agents: null } }).success).toBe(
      false
    )
    expect(CardSchema.safeParse({ ...base, kind: "flow-form", payload: { flow: "unknown.flow" } }).success).toBe(false)
    expect(CardSchema.safeParse({ ...base, kind: "issue", payload: { source: "github" } }).success).toBe(false)
  })
})

test("deferred billing, repository and trigger cards retain live decoding", () => {
  const base = { id: "retained", title: "Saved", status: "active", createdAt: 1, ordinal: 1 }
  for (
    const card of [
      { kind: "trigger-list", payload: { repo: "will/app", triggers: [] } },
      { kind: "anonymous-ceiling", payload: { message: "Saved", retryAt: null } },
      { kind: "billing-plans", payload: { planKey: null, sandbox: null, plans: [], checkout: false } },
      {
        kind: "balance",
        payload: {
          totalUsd: "0.00",
          state: "empty",
          allowedToStartWork: false,
          lifetimeChargedUsd: "0.00",
          chargeCount: 0,
          introUsd: null
        }
      }
    ]
  ) {
    expect(CardSchema.parse({ ...base, ...card }).kind).toBe(card.kind)
  }
})

test("persisted fork filters decode as all without dropping the old journal", () => {
  const original = card("run-trace", {
    ...FIXTURES["run-trace"].full,
    filter: "forks",
    events: [{ seq: 1, type: "fork", executionId: "historical" }]
  })
  const decoded = CardSchema.parse(original)
  expect(decoded.payload).toMatchObject({
    filter: "all",
    events: [{ seq: 1, type: "fork", executionId: "historical" }]
  })
  expect(CardSchema.parse(JSON.parse(JSON.stringify(decoded)))).toEqual(decoded)
})

// #3872: an active command's form must survive storage instead of becoming a tombstone.
test.each(["agent.edit", "flows"])("preserves the active /%s form", (flow) => {
  const form = {
    id: `form-${flow}`,
    kind: "flow-form",
    title: flow,
    status: "active",
    createdAt: 1,
    ordinal: 1,
    payload: { flow, via: "agent", fields: [], draft: {}, given: {} }
  }
  expect(CardSchema.parse(form)).toEqual(form)
})

test("hosted-change persists only its subject reference", () => {
  const card = {
    id: "hosted-change-session",
    kind: "hosted-change",
    title: "add slugify",
    status: "active",
    createdAt: 0,
    ordinal: 0,
    payload: { repo: "maya/tinyhttp", sessionId: "session", request: "add slugify" }
  }
  expect(CardSchema.parse(card)).toEqual(card)
  expect(CardSchema.safeParse({ ...card, payload: { repo: card.payload.repo } }).success).toBe(false)
  expect(CardSchema.parse({ ...card, payload: { ...card.payload, model: "invented", stages: [] } }).payload).toEqual(
    card.payload
  )
})

describe("local gateway card identity", () => {
  test.each(
    ["approval", "run-trace", "workflow-list", "flow-plan", "trigger-list", "run-list", "approvals-inbox"] as const
  )(
    "%s accepts a local hash only with an explicit local transport marker",
    (kind) => {
      const payload = structuredClone(FIXTURES[kind].full) as Record<string, unknown>
      if (kind === "trigger-list") {
        const preparations = payload.preparations as Array<Record<string, unknown>>
        preparations[0]!.workspaceId = "0123456789abcdef"
      } else payload.workspaceId = "0123456789abcdef"
      payload.localGateway = true
      expect(CardSchema.safeParse(card(kind, payload)).success).toBe(true)
      delete payload.localGateway
      expect(CardSchema.safeParse(card(kind, payload)).success).toBe(false)
    }
  )
})

describe("live Secrets models", () => {
  const row = { id: "secrets", kind: "secrets", title: "Secrets", status: "active", createdAt: 0, ordinal: 0 }

  test("a live model keeps its repository", () => {
    const card = CardSchema.parse({
      ...row,
      payload: { repo: "owner/repo", secrets: [{ name: "DEPLOY", scope: "all_branches", actions: [] }] }
    })
    if (card.kind !== "secrets") throw new Error("wrong kind")
    expect(card.payload).toEqual({
      repo: "owner/repo",
      scope: "repository",
      secrets: [{ name: "DEPLOY", mainOnly: false, hosts: [], matchHeaders: [], updatedAt: null }]
    })
  })

  test("a live-shaped model with an unknown scope is refused, not reinterpreted", () => {
    const payload = { repo: "owner/repo", secrets: [{ name: "DEPLOY", scope: "everywhere", actions: [] }] }
    expect(CardSchema.safeParse({ ...row, payload }).success).toBe(false)
  })
})
