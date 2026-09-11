import { describe, expect, test } from "vitest"
import { z } from "zod"
import type { Card } from "../src/Cards.ts"
import {
  CardPatchSchema,
  CardSchema,
  GitHubRateLimitSchema,
  TargetDetailSchema,
  TargetsViewSchema
} from "../src/Cards.ts"
import { LSP_DIAGNOSTICS_CAP } from "../src/LocalLsp.ts"
import { AgentTurnFrameSchema } from "../src/NativeAgent.ts"

const base = { id: "card-r1", title: "Aomi", status: "active", createdAt: 0, ordinal: 0 }

/*
 * Lane citc (ADR 0002), completed by lane L3: the workspace card carries the
 * plue DTO. plue#446 landed, so `workspaceKind`, `head`, `ahead`, `behind`,
 * `startedAt`, `environment`, `persistence` and `sshHost` ARE part of the
 * contract — every one optional, so the payload a card persisted before that
 * lane carries parses and states none of them. The service-log contract
 * lands with it.
 */
describe("the workspace card", () => {
  const payload = {
    workspaceId: "ws-1",
    repo: "will/smithers",
    name: "review",
    targetBookmark: "main",
    status: "running",
    provisioningStage: null,
    bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },
    snapshots: [{ id: "snap-1", name: "before-upgrade", createdAt: "2026-09-01T10:00:00Z" }],
    sessions: [{ id: "sess-1", status: "running", createdAt: null }]
  }

  test("a card persisted before plue#446 carries the DTO plus the bookmark head, and defaults nothing", () => {
    const card = CardSchema.parse({ ...base, kind: "workspace", payload })
    if (card.kind !== "workspace") return
    expect(card.payload.status).toBe("running")
    expect(card.payload.bookmarkHead).toEqual({ changeId: "qupxosqw", commitId: "c0ffee1" })
    // An unstated field stays absent: the header renders nothing, never a guess.
    expect(Object.keys(card.payload).sort()).toEqual(Object.keys(payload).sort())
  })

  test("the post-plue#446 DTO round-trips: the sandbox kind, the workspace's own head, ahead/behind, uptime, the environment, persistence and the ssh host", () => {
    const richer = {
      ...payload,
      workspaceKind: "vm",
      head: { changeId: "ronvznsk", commitId: "deadbee" },
      ahead: 2,
      behind: 1,
      startedAt: "2026-09-05T08:00:00Z",
      environment: {
        source: ".smithers/environment.nix",
        revision: "4e87ac15",
        closureHash: "sha256-9f1c",
        image: "registry.jjhub.tech/env:4e87ac15"
      },
      persistence: "persistent",
      sshHost: "ws-1@ssh.jjhub.tech"
    }
    const card = CardSchema.parse({ ...base, kind: "workspace", payload: richer })
    if (card.kind !== "workspace") return
    expect(card.payload).toEqual(richer)
    expect(card.payload.ahead).toBe(2)
    expect(card.payload.behind).toBe(1)
  })

  test("a status outside plue's six is rejected", () => {
    expect(CardSchema.safeParse({ ...base, kind: "workspace", payload: { ...payload, status: "melting" } }).success)
      .toBe(false)
  })

  test("the bookmark head may be absent (an unread head is not a fact)", () => {
    const card = CardSchema.parse({ ...base, kind: "workspace", payload: { ...payload, bookmarkHead: null } })
    if (card.kind !== "workspace") return
    expect(card.payload.bookmarkHead).toBeNull()
  })
})

describe("the service-log card", () => {
  test("carries the service, its lines, and the follow state", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "service-log",
      payload: { workspaceId: "ws-1", repo: "will/smithers", service: "web", lines: ["listening"], follow: true }
    })
    if (card.kind !== "service-log") return
    expect(card.payload.follow).toBe(true)
    expect(card.payload.lines).toEqual(["listening"])
  })
})

/*
 * Code intelligence (apps/ui/docs/code-intel/PLAN.md §5): the file card's
 * anchor, what the language server published, the hover answer, and the
 * server state live in the payload, all optional so a card persisted before
 * the lane parses unchanged and states none of them.
 */
describe("the file card", () => {
  const payload = { repo: "smithers", path: "apps/ui/src/mainview/App.tsx", content: "export {}\n", truncated: false }
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
    if (card.kind !== "file") return
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
    if (card.kind !== "file") return
    expect(card.payload.line).toBe(317)
    expect(card.payload.column).toBe(62)
    expect(card.payload.diagnostics).toEqual([diagnostic])
    expect(card.payload.hover?.contents).toContain("value is Record")
    expect(card.payload.intel).toEqual({ state: "missing", note: "npm i -g typescript-language-server typescript" })
  })

  test("a hover the server had nothing for is null, which is not the same as never asked", () => {
    const card = CardSchema.parse({ ...base, kind: "file", payload: { ...payload, hover: null } })
    if (card.kind !== "file") return
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

/*
 * Custom agents (apps/ui/docs/workbench-lanes/custom-agents.md): the Agents card
 * carries every agent with the harness's live availability, the form card
 * carries its draft in the payload, and the subagent card accepts a custom
 * role id beside a built-in one.
 */
describe("the agent cards", () => {
  const row = {
    id: "reviewer",
    label: "Reviewer",
    purpose: "Reviews diffs.",
    harness: "codex",
    harnessName: "Codex",
    model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    builtin: false,
    available: true,
    reason: "",
    account: "will@example.com"
  }

  test("the agents card lists rows with availability; a bad id or a model with a space is refused", () => {
    const card = CardSchema.parse({ ...base, kind: "agents", payload: { native: true, agents: [row] } })
    if (card.kind !== "agents") return
    expect(card.payload.agents[0]?.available).toBe(true)
    expect(
      CardSchema.safeParse({ ...base, kind: "agents", payload: { native: true, agents: [{ ...row, id: "Bad Id" }] } })
        .success
    ).toBe(false)
    expect(
      CardSchema.safeParse({
        ...base,
        kind: "agents",
        payload: { native: true, agents: [{ ...row, model: { ...row.model, id: "gpt 5" } }] }
      })
        .success
    ).toBe(false)
  })

  test("the flow-form card holds the flow, who asked, the derived fields, the draft and what was given; a bad kind or provider is rejected", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "flow-form",
      payload: {
        flow: "agent.create",
        via: "agent",
        fields: [
          { name: "id", label: "Id", kind: "text", required: true },
          {
            name: "harness",
            label: "Harness",
            kind: "select",
            required: true,
            optionsFrom: "agent-harnesses",
            options: [
              { value: "codex", label: "Codex · OPENAI_API_KEY" },
              { value: "opencode", label: "OpenCode", disabled: true, reason: "no credential" }
            ]
          },
          { name: "model", label: "Model", kind: "text", required: true, optionsFrom: "harness-models", options: [] },
          { name: "purpose", label: "Purpose", kind: "text", required: false }
        ],
        draft: { id: "reviewer", harness: "codex" },
        given: { id: "reviewer", harness: "codex" }
      }
    })
    if (card.kind !== "flow-form") return
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

  test("the models card is what the harness printed, with its source", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "agent-models",
      payload: { harnessId: "opencode", displayName: "OpenCode", models: ["cerebras/gpt-oss-120b"], source: "list" }
    })
    if (card.kind !== "agent-models") return
    expect(card.payload.models).toEqual(["cerebras/gpt-oss-120b"])
  })

  test("the subagent card takes a custom role id and its purpose, and still parses without one", () => {
    const payload = {
      harnessId: "codex",
      displayName: "Reviewer · GPT-5.6 Terra",
      roleId: "reviewer",
      purpose: "Reviews diffs.",
      tabId: "pty-1",
      sessionId: "pty-1",
      cwd: "/tmp",
      phase: "running",
      exitCode: null
    }
    const card = CardSchema.parse({ ...base, kind: "agent", payload })
    if (card.kind !== "agent") return
    expect(card.payload.roleId).toBe("reviewer")
    expect(card.payload.purpose).toBe("Reviews diffs.")
    const { roleId: _roleId, purpose: _purpose, ...bare } = payload
    expect(CardSchema.safeParse({ ...base, kind: "agent", payload: bare }).success).toBe(true)
    expect(CardSchema.safeParse({ ...base, kind: "agent", payload: { ...payload, roleId: "Not An Id" } }).success).toBe(
      false
    )
  })
})

describe("persisted card upgrades", () => {
  const draft = { id: "reviewer", label: "Reviewer", purpose: "Review diffs", harness: "codex", model: "gpt-5.6-terra" }
  const legacy = {
    ...base,
    kind: "agent-form",
    payload: {
      mode: "create",
      draft,
      harnesses: [{ id: "codex", displayName: "Codex", status: "api-key", account: "" }],
      models: ["gpt-5.6-terra"],
      modelsSource: "suggestions",
      phase: "editing"
    }
  }

  test.each(["create", "edit"])("upgrades a historical %s draft, including embedded snapshots", (mode) => {
    const saved = { ...legacy, payload: { ...legacy.payload, mode } }
    const card = CardSchema.parse(JSON.parse(JSON.stringify(saved)))
    expect(card.id).toBe(legacy.id)
    expect(card.kind).toBe("flow-form")
    if (card.kind !== "flow-form") throw new Error("draft was not upgraded")
    expect(card.payload.flow).toBe(`agent.${mode}`)
    expect(card.payload.draft).toEqual(draft)
    expect(card.payload.via).toBe("user")
    expect(card.payload.fields.map((field) => field.name)).toEqual(
      mode === "create" ? ["id", "harness", "model", "purpose", "label"] : ["model", "purpose", "label"]
    )
    expect(card.payload.given).toEqual(mode === "edit" ? { id: draft.id } : {})
    expect(z.object({ cards: z.array(CardSchema) }).parse({ cards: [saved] }).cards).toEqual([card])
    expect(CardSchema.parse(card)).toEqual(card)
  })

  test("keeps settled forms settled and interrupted saves editable", () => {
    for (const phase of ["saved", "cancelled", "saving", "failed"]) {
      const card = CardSchema.parse({ ...legacy, payload: { ...legacy.payload, phase, error: "last refusal" } })
      expect(card.status).toBe(phase === "saved" || phase === "cancelled" ? "acted" : base.status)
      expect(card.payload).toMatchObject({ draft, error: "last refusal" })
    }
  })

  test("does not upgrade a malformed historical row", () => {
    expect(CardSchema.safeParse({ ...legacy, payload: { ...legacy.payload, draft: {} } }).success).toBe(false)
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

  test("metadata is optional but kind is required; nested stage payloads remain atomic", () => {
    expect(CardPatchSchema.parse({ kind: "file", title: "After" })).toEqual({ kind: "file", title: "After" })
    expect(CardPatchSchema.safeParse({ title: "After" }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ kind: "repo-onboarding", payload: { stage: "welcome" } }).success).toBe(false)
    expect(
      CardPatchSchema.safeParse({
        kind: "repo-onboarding",
        payload: { stage: "welcome", repo: "smithers", summary: null }
      }).success
    ).toBe(true)
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

describe("env card persistence", () => {
  test("redacts values on initial decoding, patches, and repeated reads", () => {
    const vars = [{ name: "DATABASE_URL", value: "postgres://user:password@host/db" }, { name: "PIN", value: "12" }]
    const card = CardSchema.parse({
      ...base,
      kind: "env",
      payload: { repo: "smithers", vars, setupScript: null, secretNames: ["TOKEN"] }
    })
    expect(card.payload).toMatchObject({ vars: [{ name: "DATABASE_URL", value: "pos…" }, { name: "PIN", value: "…" }] })
    expect(JSON.stringify(card)).not.toContain("password")
    expect(CardSchema.parse(card)).toEqual(card)
    expect(CardPatchSchema.parse({ kind: "env", payload: { vars } })).toMatchObject({
      payload: {
        vars: [
          { name: "DATABASE_URL", value: "pos…" },
          { name: "PIN", value: "…" }
        ]
      }
    })
  })
})

/*
 * The persistence contract, kind by kind. Cards.ts states that "everything in
 * a card payload is written to disk", and apps/ui's FrameSnapshotSchema reads
 * a whole transcript back through `cards: z.array(CardSchema)` — so a field
 * that stops parsing rejects a snapshot, not one card. Dozens of fields are
 * marked "optional so cards persisted before the lane parse", which is a
 * promise about payloads nobody can rewrite.
 *
 * Every kind therefore carries two fixtures: `minimal` is the payload with
 * only the fields the schema requires (what a card written before every later
 * lane holds) and `full` is the payload with every field the schema accepts.
 * Both must parse, both must come back unchanged, and a minimal payload must
 * gain nothing on the way through. Making an optional field required,
 * renaming a kind or tightening an enum breaks a fixture here instead of a
 * reader's transcript.
 */

/** A canonical non-nil gateway workspace id (GatewayWorkspace.ts). */
const gatewayWorkspaceId = "6f1b9c2e-6a4a-4c0e-9f52-2c1a7f0b39d1"
const rateLimit = { limit: 5000, remaining: 42, resetAt: "2026-09-05T10:00:00Z" }

type KindFixtures = {
  /** Only the fields the schema requires: what a card persisted before every later lane carries. */
  readonly minimal: Record<string, unknown>
  /** Every field the schema accepts, including the ones later lanes added. */
  readonly full: Record<string, unknown>
  /** What decoding must produce when it rewrites the payload (the env card redacts). */
  readonly decodedFull?: Record<string, unknown>
}

const FIXTURES: Record<Card["kind"], KindFixtures> = {
  plan: {
    minimal: { items: [] },
    full: { items: [{ id: "p1", title: "Read the route", status: "done" }] }
  },
  approval: {
    minimal: { capability: "network" },
    full: {
      capability: "network",
      detail: "POST https://api.github.com",
      runId: "run-1",
      requestId: "gate-1",
      approval: { _tag: "ApprovalTarget.Node", node: "call-3" },
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
  "grant-confirm": {
    minimal: { login: "ada", amountUsd: 25, phase: "confirm" },
    full: { login: "ada", amountUsd: 25, phase: "failed", grantId: "grant-1", error: "the grant call failed (500)" }
  },
  "request-queue": {
    minimal: { requests: [], approving: null },
    full: {
      requests: [{ login: "ada", note: "reviewing smithers", createdAt: "2026-09-05T09:00:00Z" }],
      approving: "ada",
      error: "the allowlist add failed (500)"
    }
  },
  "admin-health": {
    minimal: { services: [], queueDepth: null, charges: null, checkedAt: "2026-09-05T09:00:00Z" },
    full: {
      services: [{ name: "gateway", status: "ok", detail: "200 in 12 ms" }],
      queueDepth: 3,
      charges: { chargeCount: 2, lifetimeChargedUsd: "1.00" },
      checkedAt: "2026-09-05T09:00:00Z"
    }
  },
  connect: {
    minimal: { github: { connected: false, login: null }, nativeAvailable: false },
    full: { github: { connected: true, login: "will" }, nativeAvailable: true }
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
      error: "the fetch failed (503)"
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
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      runId: "run-1",
      workflow: "review",
      phase: "quiet",
      steps: ["read the diff"],
      result: "3 findings",
      error: "the executor exited 1",
      observationError: "the events projection refused (500)",
      lastSeq: 42,
      quietForMs: 600_000,
      input: { repo: "smithersai/smithers" },
      kind: "prototype",
      waiting: "approval",
      steeringPending: true,
      facet: "transcript",
      follow: true,
      transcriptRows: [{ sequence: 1, turn: 1, at: 1_757_000_000_000, kind: "message", text: "reading" }],
      events: [{ seq: 1, type: "call.started" }],
      selection: "span-3",
      cursorSeq: 41,
      filter: "failed",
      liveTail: false,
      traceView: "timeline",
      codingChangeId: "qupxosqw"
    }
  },
  "workflow-list": {
    minimal: { repo: "smithersai/smithers", workflows: [] },
    full: {
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      workflows: [{ key: "review", description: null }]
    }
  },
  "trigger-list": {
    minimal: { repo: "smithersai/smithers", triggers: [] },
    full: {
      repo: "smithersai/smithers",
      declared: [{ event: "push", flow: "ci", description: "run ci on every push" }],
      live: true,
      triggers: [{
        id: "trg-1",
        flowId: "ci",
        cron: "0 * * * *",
        timezone: "UTC",
        enabled: true,
        lastFiredAt: 1_757_000_000_000,
        nextFireAt: 1_757_003_600_000,
        activeRunId: "run-1"
      }],
      webhooks: [{ name: "github", flowId: "ci" }]
    }
  },
  factory: {
    minimal: {
      repo: "smithersai/smithers",
      wiki: { generated: null, notes: 0, librarian: null },
      infra: []
    },
    full: {
      repo: "smithersai/smithers",
      wiki: {
        generated: { pages: 24, sha: "4e87ac15", coverage: "82%", generatedAt: 1_757_000_000_000 },
        notes: 11,
        librarian: { answers: 90, misses: 4 }
      },
      infra: [{ path: ".smithers/FACTORY.ts", state: "unreadable", reason: "the mirror refused (404)" }]
    }
  },
  "run-list": {
    minimal: { repo: "smithersai/smithers", runs: [] },
    full: {
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      statuses: ["running", "completed"],
      status: "running",
      flow: "review",
      lineage: "lin-1",
      runs: [{
        runId: "run-1",
        flowId: "review",
        status: "running",
        waiting: "approval",
        createdAt: 1_757_000_000_000,
        turns: 3,
        calls: 12
      }]
    }
  },
  "approvals-inbox": {
    minimal: { repo: "smithersai/smithers", approvals: [] },
    full: {
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      approvals: [{
        runId: "run-1",
        requestId: "gate-1",
        title: "POST https://api.github.com",
        approval: { _tag: "ApprovalTarget.Node", node: "call-3" },
        requestedAt: 1_757_000_000_000,
        decision: "denied",
        decidedAt: 1_757_000_060_000,
        decisionError: "the gateway refused (503)",
        pending: true
      }]
    }
  },
  "workflow-repo": {
    minimal: { intent: "create", description: "a flow that lands the change", repos: [], chosen: null },
    full: {
      intent: "create",
      description: "a flow that lands the change",
      repos: ["smithersai/smithers", "will/plue"],
      chosen: "smithersai/smithers"
    }
  },
  "issue-list": {
    minimal: { repo: "smithersai/smithers", filter: "open", issues: [] },
    full: {
      repo: "smithersai/smithers",
      filter: "all",
      issues: [{
        number: 1634,
        title: "rc0 CI green",
        state: "closed",
        author: "will",
        comments: 4,
        updatedAt: "2026-09-05T09:00:00Z",
        source: "github",
        htmlUrl: "https://github.com/smithersai/smithers/issues/1634"
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
      state: "closed",
      author: "will",
      issueBody: "shard-3 wedges on sqlite",
      labels: ["ci", "flaky"],
      linear: { identifier: "ENG-482", url: "https://linear.app/smithers/issue/ENG-482" },
      comments: [{ author: null, commentBody: "reproduced", createdAt: "2026-09-05T09:00:00Z" }]
    }
  },
  "pr-list": {
    minimal: { repo: "smithersai/smithers", landings: [] },
    full: {
      repo: "smithersai/smithers",
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
      repo: "smithersai/smithers",
      number: 12,
      title: "Serve repository files",
      state: "queued",
      author: "will",
      prBody: "one bounded route",
      reviews: [{ author: "ada", type: "APPROVED", reviewBody: "ship it" }],
      checks: [{ context: "typecheck", state: "success" }]
    }
  },
  notifications: {
    minimal: { unread: 0, items: [] },
    full: {
      unread: 1,
      items: [{
        id: "n-1",
        title: "review requested",
        repo: "smithersai/smithers",
        reason: "review_requested",
        createdAt: "2026-09-05T09:00:00Z",
        read: false
      }]
    }
  },
  env: {
    minimal: { repo: "smithersai/smithers", vars: [], setupScript: null },
    full: {
      repo: "smithersai/smithers",
      vars: [{ name: "DATABASE_URL", value: "postgres://user:password@host/db" }, { name: "PIN", value: "12" }],
      setupScript: "pnpm install"
    },
    decodedFull: {
      repo: "smithersai/smithers",
      vars: [{ name: "DATABASE_URL", value: "pos…" }, { name: "PIN", value: "…" }],
      setupScript: "pnpm install"
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
        updatedAt: "2026-09-05T09:00:00Z"
      }]
    }
  },
  history: {
    minimal: {
      repo: "smithersai/smithers",
      defaultBookmark: null,
      mainCommits: null,
      mythical: { state: "absent" }
    },
    full: {
      repo: "smithersai/smithers",
      defaultBookmark: "main",
      mainCommits: 1200,
      mythical: {
        state: "present",
        head: "4e87ac15",
        mainHead: "67d55ba5",
        treeEqual: "equal",
        commitCount: 3,
        notes: "read",
        epics: [{
          sha: "4e87ac15",
          title: "One build system",
          merge: true,
          note: { tried: "BUILD.ts", evidence: "the drift lint", folded: "PACKAGE.ts", superseded: null },
          commits: [{ sha: "9910aa2b", title: "Delete the loader", note: null }]
        }]
      }
    }
  },
  account: {
    minimal: { login: "will", scopes: [], allowlisted: false, accessRequested: false, boxes: [] },
    full: {
      login: "will",
      scopes: [{ scope: "repo", plain: "read and write your repositories" }],
      allowlisted: true,
      accessRequested: true,
      boxes: [{ id: "ws-1", repoId: "smithersai/smithers", name: "review", status: "running" }]
    }
  },
  "repo-import": {
    minimal: { repo: "smithersai/smithers", jobId: null, phase: "starting", detail: null },
    full: {
      repo: "smithersai/smithers",
      jobId: "job-1",
      phase: "failed",
      detail: "provisioning the workspace",
      stage: "provisioning_workspace",
      counts: {
        refs: { done: 214, total: 214 },
        objects: { done: 90_000, total: 90_000 },
        issues: { done: 12, total: 40 }
      },
      error: "the import failed (500)",
      repository: { owner: "smithersai", name: "smithers" },
      workspaceId: "ws-1",
      rateLimit
    }
  },
  "connector-setup": {
    minimal: { connector: "github", repo: "smithersai/smithers", phase: "setup", steps: [] },
    full: {
      connector: "linear",
      repo: "smithersai/smithers",
      phase: "connected",
      steps: [{
        id: "authorize",
        label: "Authorize",
        state: "error",
        detail: "authorized as will",
        error: "authorization expired"
      }],
      setupKey: "setup-1",
      setupExpiresAt: "2026-09-05T09:05:00Z",
      actor: "will",
      teams: [{ id: "team-1", name: "Engineering", key: "ENG" }],
      teamId: "team-1",
      integration: {
        id: 7,
        teamKey: "ENG",
        teamName: "Engineering",
        active: true,
        lastSyncAt: "2026-09-05T09:00:00Z"
      },
      installationId: 4212,
      configured: true,
      installUrl: "https://github.com/apps/smithers/installations/new",
      rateLimit,
      error: "the connector refused (500)"
    }
  },
  "sync-ops": {
    minimal: { subject: "Mirror · smithersai/smithers", source: "github-mirror", runState: null, ops: [] },
    full: {
      subject: "Linear ENG ↔ smithersai/smithers",
      source: "linear",
      integrationId: "7",
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
        source: "linear",
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
  branches: {
    minimal: { repo: "smithersai/smithers", bookmarks: [] },
    full: { repo: "smithersai/smithers", bookmarks: [{ name: "main", head: "4e87ac15" }, { name: "wip", head: null }] }
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
      readAt: { changeId: "qupxosqw", commitId: "a03f5f1e", source: "working-copy" }
    }
  },
  file: {
    minimal: { repo: "smithersai/smithers", path: "README.md", content: "# hi\n", truncated: false },
    full: {
      repo: "smithersai/smithers",
      localRepoId: "repo-1",
      path: "README.md",
      content: "# hi\n",
      truncated: true,
      binary: false,
      address: "/smithersai/smithers/README.md",
      readAt: { changeId: "qupxosqw", commitId: "a03f5f1e", seq: 5, source: "head" },
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
        sections: [{ title: "The route", markdown: "one bounded read", diagram: null }],
        quiz: []
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
  workspace: {
    minimal: {
      workspaceId: "ws-1",
      repo: "will/smithers",
      name: "review",
      targetBookmark: null,
      status: "pending",
      provisioningStage: null,
      bookmarkHead: null,
      snapshots: [],
      sessions: []
    },
    full: {
      workspaceId: "ws-1",
      snapshot: true,
      repo: "will/smithers",
      name: "review",
      targetBookmark: "main",
      status: "failed",
      failureCode: "egress_proxy_unavailable",
      failureMessage: "the egress proxy is unavailable",
      provisioningStage: "provisioning_workspace",
      suspendedAt: "2026-09-05T08:00:00Z",
      bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },
      workspaceKind: "desktop",
      agentSessionId: "sess-1",
      head: { changeId: "ronvznsk", commitId: "deadbee" },
      ahead: 2,
      behind: 1,
      startedAt: "2026-09-05T08:00:00Z",
      environment: {
        source: ".smithers/environment.nix",
        revision: "4e87ac15",
        closureHash: "sha256-9f1c",
        image: "registry.jjhub.tech/env:4e87ac15"
      },
      persistence: "persistent",
      sshHost: "ws-1@ssh.jjhub.tech",
      snapshots: [{ id: "snap-1", name: "before-upgrade", createdAt: "2026-09-01T10:00:00Z" }],
      sessions: [{ id: "sess-1", status: "running", createdAt: null, kind: "lsp", language: "typescript" }],
      lspLanguages: ["typescript"],
      files: [{ name: "src", path: "src", type: "dir", size: null }],
      filesPath: "",
      services: [{ name: "web", state: "running", port: 8787, url: "http://localhost:8787" }],
      egress: [{
        occurredAt: "2026-09-05T09:00:00Z",
        host: "api.openai.com",
        method: "POST",
        path: "/v1/responses",
        status: 200,
        allowed: true,
        swappedSecretNames: ["OPENAI_API_KEY"]
      }],
      egressCursor: "cursor-1",
      desktop: { ready: true, streamUrl: "/vnc", session: { id: "vnc-1", expiresAt: "2026-09-05T09:05:00Z" } },
      desktopRefusal: { status: 503, message: "desktop not ready", code: "desktop_not_ready", retryAfterSeconds: 5 },
      terminalRefusal: { status: 503, message: "guest not ready", code: "guest_not_ready", retryAfterSeconds: 3 },
      facet: "desktop",
      terminalSessionId: "pty-1",
      error: "Resume refused (409)",
      egressProxyUnavailable: true
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
  "service-log": {
    minimal: { workspaceId: "ws-1", repo: "will/smithers", service: "web", lines: [], follow: false },
    full: { workspaceId: "ws-1", repo: "will/smithers", service: "web", lines: ["listening"], follow: true }
  },
  "theme-picker": {
    minimal: { selected: "ember" },
    full: { selected: "ember" }
  },
  targets: {
    minimal: { repoId: "repo-1", repoName: "smithers", status: "pending", targets: [], warnings: [] },
    full: {
      repoId: "repo-1",
      repoName: "smithers",
      status: "done",
      targets: [{
        id: "t-1",
        label: "//packages/rpc:test",
        target: "test",
        kinds: ["test"],
        package: "//packages/rpc",
        name: "test",
        workspace: ".",
        summary: "the rpc suite",
        featured: true
      }],
      warnings: ["one declaration failed to load"],
      highlighted: "//packages/rpc:test",
      view: {
        mode: "all",
        query: "rpc",
        kinds: ["test"],
        states: ["passed"],
        workspace: ".",
        selected: "//packages/rpc:test",
        expanded: ["//...:test"],
        picked: { "//...:test": ["//packages/rpc:test"] }
      },
      runs: [{
        runId: "run-1",
        repoId: "repo-1",
        label: "//packages/rpc:test",
        labels: ["//packages/rpc:test"],
        status: "done",
        startedAt: 1_757_000_000_000,
        endedAt: 1_757_000_004_900,
        exitCode: 0,
        summary: {
          total: 1,
          hit: 0,
          ran: 1,
          failed: 0,
          skipped: 0,
          durationMs: 4900,
          ok: true,
          criticalPath: ["//packages/rpc:test"]
        },
        journal: { state: "degraded", error: "one frame was lost" }
      }],
      details: {
        "//packages/rpc:test": {
          status: "done",
          node: {
            label: "//packages/rpc:test",
            package: "//packages/rpc",
            name: "test",
            rule: "Vitest",
            kinds: ["test"],
            private: false,
            plan: { mode: "execute", cacheable: true, key: "9f1c", argv: ["vitest", "run"] },
            source: { file: "packages/rpc/PACKAGE.ts", line: 12 }
          },
          deps: ["//packages/rpc:build"],
          rdeps: ["//:ci"],
          error: "the plan refused"
        }
      },
      starred: ["//packages/rpc:test"]
    }
  },
  "target-run": {
    minimal: {
      runId: "run-1",
      repoId: "repo-1",
      label: "//packages/rpc:test",
      status: "running",
      exitCode: null,
      output: ""
    },
    full: {
      runId: "run-1",
      repoId: "repo-1",
      label: "//packages/rpc:test",
      verb: "ci",
      pattern: "//packages/...",
      status: "done",
      exitCode: 0,
      output: "1 passed",
      startedAt: 1_757_000_000_000,
      endedAt: 1_757_000_004_900,
      nodes: [{
        label: "//packages/rpc:test",
        status: "ran",
        startedAt: 1_757_000_000_000,
        endedAt: 1_757_000_004_900,
        durationMs: 4900,
        key: "9f1c",
        reason: "the host bin is absent",
        exitCode: 0,
        rule: "Vitest"
      }],
      summary: {
        total: 1,
        hit: 0,
        ran: 1,
        failed: 0,
        skipped: 0,
        durationMs: 4900,
        ok: true,
        criticalPath: ["//packages/rpc:test"]
      },
      nodeOutput: { "//packages/rpc:test": "1 passed" }
    }
  },
  repo: {
    minimal: {
      repo: {
        id: "repo-1",
        path: "/Users/will/smithers",
        name: "smithers",
        git: null,
        warnings: [],
        smithers: {
          detected: false,
          workspaceFile: null,
          declarationFiles: [],
          reason: "no .smithers/WORKSPACE.ts",
          workspaces: []
        }
      }
    },
    full: {
      repo: {
        id: "repo-1",
        path: "/Users/will/smithers",
        name: "smithers",
        git: { branch: "main", remote: "origin" },
        jj: { changeId: "qupxosqw", commitId: "a03f5f1e", ahead: 2, bookmark: "main" },
        warnings: ["one declaration failed to load"],
        smithers: {
          detected: true,
          workspaceFile: ".smithers/WORKSPACE.ts",
          declarationFiles: ["packages/rpc/PACKAGE.ts"],
          reason: "",
          workspaces: [{ path: ".", title: "smithers" }]
        }
      }
    }
  },
  graph: {
    minimal: { repoId: "repo-1", repoName: "smithers", status: "pending" },
    full: {
      repoId: "repo-1",
      repoName: "smithers",
      status: "done",
      graph: {
        repoId: "repo-1",
        nodes: [{
          label: "//packages/rpc:test",
          package: "//packages/rpc",
          name: "test",
          rule: "Vitest",
          kinds: ["test"],
          private: false,
          plan: {
            mode: "execute",
            cacheable: true,
            key: "9f1c",
            refusal: "the host bin is absent",
            argv: ["vitest", "run"],
            sandbox: "seatbelt",
            outDirs: ["dist"],
            outFiles: ["dist/index.js"],
            inputs: ["src/**"]
          },
          source: { file: "packages/rpc/PACKAGE.ts", line: 12 }
        }],
        edges: [{ from: "//packages/rpc:test", to: "//packages/rpc:build", kind: "deps" }],
        warnings: [],
        generatedAt: "2026-09-05T09:00:00Z",
        digest: "sha256-9f1c",
        durationMs: 1
      },
      error: "graph load failed: exit 1",
      focus: "//packages/rpc:test",
      view: { query: "rpc", showPrivate: true },
      runId: "run-1",
      run: {
        nodes: [{ label: "//packages/rpc:test", status: "ran", durationMs: 4900 }],
        summary: {
          total: 1,
          hit: 0,
          ran: 1,
          failed: 0,
          skipped: 0,
          durationMs: 4900,
          ok: true,
          criticalPath: ["//packages/rpc:test"]
        }
      }
    }
  },
  "run-timeline": {
    minimal: { repoId: "repo-1", runId: "run-1", label: "//packages/rpc:test", status: "pending", nodes: [] },
    full: {
      repoId: "repo-1",
      runId: "run-1",
      label: "//packages/rpc:test",
      status: "done",
      nodes: [{ label: "//packages/rpc:test", status: "ran", durationMs: 4900 }],
      summary: {
        total: 1,
        hit: 0,
        ran: 1,
        failed: 0,
        skipped: 0,
        durationMs: 4900,
        ok: true,
        criticalPath: ["//packages/rpc:test"]
      },
      cursor: 1_757_000_002_000,
      extent: { start: 1_757_000_000_000, end: 1_757_000_004_900 },
      logs: { "//packages/rpc:test": "1 passed" },
      error: "the stream failed"
    }
  },
  "run-history": {
    minimal: { repoId: "repo-1", status: "pending", runs: [] },
    full: {
      repoId: "repo-1",
      status: "done",
      runs: [{
        runId: "run-1",
        repoId: "repo-1",
        label: "//packages/rpc:test",
        labels: ["//packages/rpc:test"],
        status: "failed",
        startedAt: 1_757_000_000_000,
        endedAt: 1_757_000_004_900,
        exitCode: 1,
        summary: {
          total: 1,
          hit: 0,
          ran: 1,
          failed: 1,
          skipped: 0,
          durationMs: 4900,
          ok: false,
          criticalPath: ["//packages/rpc:test"]
        },
        journal: { state: "degraded", error: "one frame was lost" }
      }],
      selected: "run-1",
      error: "the history read failed"
    }
  },
  affected: {
    minimal: { repoId: "repo-1", status: "pending" },
    full: {
      repoId: "repo-1",
      status: "done",
      result: {
        repoId: "repo-1",
        base: "origin/main",
        changedFiles: ["packages/rpc/src/Cards.ts"],
        affected: [{ label: "//packages/rpc:test", reason: "packages/rpc/src/Cards.ts" }],
        signal: "declared inputs",
        limits: ["the CLI does not expose every input"],
        durationMs: 12
      },
      error: "not a git repo"
    }
  },
  "ci-matrix": {
    minimal: { repoId: "repo-1", status: "pending" },
    full: {
      repoId: "repo-1",
      status: "done",
      result: {
        repoId: "repo-1",
        workflows: [{
          name: "ci",
          path: ".github/workflows/ci.yml",
          yaml: "name: ci\n",
          source: "scratch-render",
          jobs: [{ name: "test", targets: ["//packages/rpc:test"], matrix: { shard: ["1/4", "2/4"] } }]
        }],
        warnings: ["one workflow could not be rendered"],
        durationMs: 12
      },
      error: "the render failed"
    }
  },
  agent: {
    minimal: {
      harnessId: "codex",
      displayName: "Codex",
      tabId: "pty-1",
      sessionId: "pty-1",
      cwd: "/tmp",
      phase: "running",
      exitCode: null
    },
    full: {
      harnessId: "codex",
      displayName: "Reviewer · GPT-6 Astra",
      roleId: "reviewer",
      purpose: "Reviews diffs.",
      task: "review the rpc change",
      tabId: "pty-1",
      sessionId: "pty-1",
      cwd: "/tmp",
      phase: "exited",
      exitCode: 0
    }
  },
  explain: {
    minimal: { question: "what is a change?", answer: "", phase: "asking", answeredBy: "" },
    full: {
      question: "what is a change?",
      answer: "A document with revisions.",
      phase: "failed",
      answeredBy: "kimi-for-coding/k3",
      error: "the explainer refused (503)"
    }
  },
  agents: {
    minimal: { native: false, agents: [] },
    full: {
      native: true,
      agents: [{
        id: "reviewer",
        label: "Reviewer",
        purpose: "Reviews diffs.",
        harness: "codex",
        harnessName: "Codex",
        model: { provider: "openai", id: "gpt-6-astra", label: "GPT-6 Astra" },
        builtin: false,
        available: true,
        reason: "",
        account: "will@example.com"
      }],
      error: "the harness signals failed"
    }
  },
  "flow-form": {
    minimal: { flow: "agent.create", via: "user", fields: [], draft: {}, given: {} },
    full: {
      flow: "agent.create",
      via: "agent",
      fields: [{
        name: "harness",
        label: "Harness",
        kind: "select",
        required: true,
        placeholder: "codex",
        options: [{ value: "opencode", label: "OpenCode", disabled: true, reason: "no credential" }],
        optionsFrom: "agent-harnesses"
      }],
      draft: { id: "reviewer", retries: 2, verbose: true },
      given: { id: "reviewer" },
      submitting: true,
      error: "the submit refused (500)"
    }
  },
  "repo-onboarding": {
    minimal: { stage: "welcome", repo: "smithersai/smithers", summary: null },
    full: {
      stage: "maintain",
      repo: "smithersai/smithers",
      activity: {
        sentence: "12 commits, 3 landings and 4 issues in the last week",
        counts: { commits: 12, pullRequests: 3, issues: null },
        since: "2026-08-29T00:00:00Z"
      },
      reason: "the activity route is not deployed",
      flows: ["issues.list", "prs.list"]
    }
  },
  "repo-home": {
    minimal: {
      repo: "smithersai/smithers",
      path: ".smithers/home.json",
      blocks: [{ type: "flows" }],
      featuredFlows: null
    },
    full: {
      repo: "smithersai/smithers",
      path: ".smithers/home.json",
      blocks: [
        { type: "text", title: "Smithers", text: "A durable control plane for long-running coding agents." },
        { type: "links", title: "Docs", links: [{ label: "Docs", url: "https://smithers.sh/docs" }] },
        { type: "flows", title: "Flows" }
      ],
      featuredFlows: [{ id: "review", summary: "review the change" }, { id: "land", summary: null }],
      featuredReason: "the projection did not answer"
    }
  },
  "agent-models": {
    minimal: { harnessId: "opencode", displayName: "OpenCode", models: [], source: "suggestions" },
    full: {
      harnessId: "opencode",
      displayName: "OpenCode",
      models: ["cerebras/gpt-oss-120b"],
      source: "list",
      reason: "the list command is unavailable"
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
      }]
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
  "anonymous-ceiling": {
    minimal: { message: "too many turns from this address", retryAt: null },
    full: { message: "too many turns from this address", retryAt: "2026-09-05T10:00:00Z" }
  }
}

const kinds = CardSchema.options.map((option) => option.shape.kind.value)
const card = (kind: string, payload: unknown): unknown => ({ ...base, kind, payload })

/** The fields a kind's payload declares, or null when the payload is a union of stages rather than one object. */
const payloadFields = (kind: string): Record<string, z.ZodType> | null => {
  const payload = CardSchema.options.find((option) => option.shape.kind.value === kind)?.shape.payload
  return payload instanceof z.ZodObject ? payload.shape as Record<string, z.ZodType> : null
}

/** True when the schema accepts the field's absence — the "optional so older cards parse" promise. */
const optional = (schema: z.ZodType): boolean => schema.safeParse(undefined).success

/** repo-onboarding is the one union payload; its stages are covered one by one below. */
const objectKinds = kinds.filter((kind) => payloadFields(kind) !== null)

describe("every persisted card kind", () => {
  test("has fixtures: a kind added to the union without them is the gap this table closes", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...kinds].sort())
  })

  test("only repo-onboarding carries a union payload; a second one would escape the field audit below", () => {
    expect(kinds.filter((kind) => payloadFields(kind) === null)).toEqual(["repo-onboarding"])
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
    const { decodedFull, full, minimal } = FIXTURES[kind]

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
    expect(rich.payload).toEqual(decodedFull ?? full)

    /* Decoding is idempotent: a card read back off disk decodes to itself. */
    expect(CardSchema.parse(lean)).toEqual(lean)
    expect(CardSchema.parse(rich)).toEqual(rich)
  })

  test("a whole frame snapshot of one card per kind parses (apps/ui FrameSnapshotSchema)", () => {
    const snapshot = z.object({ cards: z.array(CardSchema) })
    const cards = kinds.map((kind, ordinal) => ({ ...base, kind, ordinal, payload: FIXTURES[kind].full }))
    expect(snapshot.parse({ cards }).cards).toHaveLength(kinds.length)
  })

  test("an unknown kind is refused, so a card from a newer build is quarantined rather than half-read", () => {
    expect(CardSchema.safeParse({ ...base, kind: "moons", payload: {} }).success).toBe(false)
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
    const view = FIXTURES.targets.full.view
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

/*
 * The repository welcome's other three stages: the payload is a
 * discriminated union, so each stage is its own required shape and a stage
 * change is an atomic replacement, never a partial inherit.
 */
describe("the repo-onboarding stages", () => {
  const stages = [
    { stage: "welcome", repo: "smithersai/smithers", summary: "a durable control plane" },
    {
      stage: "maintain",
      repo: "smithersai/smithers",
      activity: null,
      reason: "the activity route is not deployed",
      flows: []
    },
    { stage: "contribute", repo: "smithersai/smithers", guide: "CONTRIBUTING.md" },
    { stage: "explore", repo: "smithersai/smithers", guides: [{ path: "docs/README.md" }] }
  ]

  test.each(stages)("the $stage stage parses and round-trips", (payload) => {
    const parsed = CardSchema.parse(card("repo-onboarding", payload))
    expect(parsed.payload).toEqual(payload)
  })

  test("a stage outside the four, and a stage missing its own required field, are refused", () => {
    expect(CardSchema.safeParse(card("repo-onboarding", { stage: "abandon", repo: "o/r" })).success).toBe(false)
    expect(CardSchema.safeParse(card("repo-onboarding", { stage: "contribute", repo: "o/r" })).success).toBe(false)
  })
})
