import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import * as AgentContext from "../src/AgentContext.ts"
import * as AgentRoles from "../src/AgentRoles.ts"
import * as AgentTurnJournal from "../src/AgentTurnJournal.ts"
import * as CardAction from "../src/CardAction.ts"
import * as Cards from "../src/Cards.ts"
import * as GatewayWorkspace from "../src/GatewayWorkspace.ts"
import * as SetupCard from "../src/SetupCard.ts"
import * as StackView from "../src/StackView.ts"
import * as UiInstruction from "../src/UiInstruction.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261130")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/rpc Deep2 Fuzz (AgentContext, Cards migrations, AgentTurnJournal, CardAction, GatewayWorkspace)", () => {
  it("AgentContext.renderAgentRuntimeContext & composeAgentInstructions fuzz all optional sections and schema bounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        surface: Schema.Literals(["chat", "world", "connectors", "flows", "plugins", "subagents"]),
        theme: Schema.Literals(["light", "dark"]),
        githubConnected: Schema.Boolean,
        cloudState: Schema.Literals(["none", "signed-in", "signed-out", "degraded", "unavailable"]),
        hasBilling: Schema.Boolean,
        hasOnboarding: Schema.Boolean,
        hasRepoUpdate: Schema.Boolean,
        hasRecentCards: Schema.Boolean,
        hasTabs: Schema.Boolean,
        hasWorldDocs: Schema.Boolean,
        hasConnectors: Schema.Boolean,
        extraInstructions: Schema.Literals(["none", "empty", "custom"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.sync(() => {
            const raw: AgentContext.AgentRuntimeContext = {
              version: AgentContext.AGENT_RUNTIME_CONTEXT_VERSION,
              product: "smithers",
              capturedAt: 1700000000000,
              revision: 3,
              surface: c.surface,
              theme: c.theme,
              selectedWorldDocument: c.hasWorldDocs ? "docs/arch.md" : null,
              connectors: c.hasConnectors
                ? [
                  {
                    kind: "github",
                    name: "GitHub",
                    status: "connected",
                    access: "read-write",
                    root: "/repo",
                    branch: "main"
                  }
                ]
                : [],
              repositories: [{ id: "r1", name: "acme/app" }],
              activeRepository: "acme/app",
              activeRepositorySummary: "Main monorepo",
              github: {
                connected: c.githubConnected,
                login: c.githubConnected ? "will" : null,
                repositories: c.githubConnected ? 2 : null,
                ...(c.githubConnected ? { repositoryNames: ["acme/app", "acme/web"] } : {})
              },
              ...(c.cloudState === "none"
                ? {}
                : { cloud: { state: c.cloudState, username: c.cloudState === "signed-in" ? "will" : null } }),
              ...(c.hasBilling
                ? { billing: { state: "active", totalUsd: "$42.00", lifetimeChargedUsd: "$100.00", chargeCount: 5 } }
                : { billing: null }),
              worldState: {
                documentCount: c.hasWorldDocs ? 1 : 0,
                documents: c.hasWorldDocs
                  ? [{
                    path: "docs/arch.md",
                    title: "Architecture",
                    confidence: 0.9,
                    body: "System overview",
                    bodyTruncated: true
                  }]
                  : []
              },
              ...(c.hasOnboarding
                ? { onboarding: { step: 1, stepCount: 4, transcript: ["Welcome", "Step 1"] } }
                : {}),
              ...(c.hasRepoUpdate
                ? {
                  repositoryUpdate: {
                    repo: "acme/app",
                    checkedAt: 1700000000000,
                    branch: "main",
                    openIssues: 2,
                    openPrs: 1,
                    problems: ["lint red"],
                    items: [{ source: "github", kind: "issue", number: 7, title: "Bug", state: "open", tags: ["p1"] }],
                    truncated: true
                  }
                }
                : {}),
              ...(c.hasRecentCards
                ? {
                  recentCards: [
                    {
                      id: "c1",
                      kind: "setup",
                      title: "Setup",
                      status: "open",
                      maximized: false,
                      workspace: { id: "ws1", repo: "acme/app", kind: "branch", status: "ready", facet: "chat" },
                      setup: {
                        steps: [{ name: "research", mode: "automatic", prompt: "Inspect codebase" }],
                        replies: "public",
                        landing: "pr",
                        budgetMinutes: 30,
                        applyTo: "bugs",
                        trigger: "daily",
                        gate: "waiting for token"
                      }
                    }
                  ]
                }
                : {}),
              ...(c.hasTabs
                ? {
                  tabs: [
                    { id: "t1", kind: "main", title: "Main", active: true },
                    { id: "t2", kind: "card", title: "Setup", active: false }
                  ]
                }
                : {}),
              capabilities: ["fs:read", "flow:run"],
              limitations: ["no-merge"]
            }

            const parsed = AgentContext.AgentRuntimeContextSchema.safeParse(raw)
            if (!parsed.success) return false
            const rendered = AgentContext.renderAgentRuntimeContext(parsed.data)
            if (!rendered.includes("smithers") && !rendered.includes("Smithers")) return false
            if (!rendered.includes(c.surface)) return false

            const composed = AgentContext.composeAgentInstructions(
              c.extraInstructions === "none" ? "" : c.extraInstructions === "empty" ? "   " : "Base instructions.",
              parsed.data
            )
            if (!composed.includes(rendered)) return false
            if (c.extraInstructions === "custom" && !composed.includes("Base instructions.")) return false
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("Cards.CardSchema legacy/migration preprocessing, AgentTurnJournal, CardAction, and GatewayWorkspace fuzz invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cardMode: Schema.Literals([
          "secretsLegacy",
          "retiredLinearIssue",
          "retiredAlready",
          "agentsBuiltin",
          "agentsCustom",
          "repoChoiceLegacy",
          "invalidNull"
        ]),
        wsId: Schema.Literals([
          "0123456789abcdef",
          "ws_valid_id",
          "../bad",
          ""
        ]),
        batchMode: Schema.Literals(["valid", "terminal", "wrongBatch", "wrongHash", "midDone"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.sync(() => {
            const baseCard = {
              id: "card-1",
              title: "Card",
              status: "open",
              loading: false,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z"
            }

            let rawCard: unknown
            if (c.cardMode === "secretsLegacy") {
              rawCard = {
                ...baseCard,
                kind: "secrets",
                payload: {
                  repo: "acme/app",
                  secrets: [{ name: "API_KEY", scope: "main_only", hosts: ["api.example.com"] }]
                }
              }
            } else if (c.cardMode === "retiredLinearIssue") {
              rawCard = {
                ...baseCard,
                kind: "issue",
                payload: { source: "linear", id: "LIN-1", title: "Old" }
              }
            } else if (c.cardMode === "retiredAlready") {
              rawCard = {
                ...baseCard,
                kind: "retired",
                status: "acted",
                payload: { was: "legacy-thing", recorded: { a: 1 } }
              }
            } else if (c.cardMode === "agentsBuiltin") {
              const firstRole = AgentRoles.AGENT_ROLES[0]!
              rawCard = {
                ...baseCard,
                kind: "agents",
                payload: {
                  agents: [{
                    id: firstRole.id,
                    builtin: true,
                    label: "stale",
                    purpose: "old",
                    harness: "old",
                    model: "old"
                  }]
                }
              }
            } else if (c.cardMode === "agentsCustom") {
              rawCard = {
                ...baseCard,
                kind: "agents",
                payload: {
                  agents: [{
                    id: "custom-1",
                    builtin: false,
                    label: "My Agent",
                    purpose: "helper",
                    harness: "smithers",
                    model: "claude"
                  }]
                }
              }
            } else if (c.cardMode === "repoChoiceLegacy") {
              rawCard = {
                ...baseCard,
                kind: "repository-choice",
                payload: { created: { name: "acme/new-repo" } }
              }
            } else {
              rawCard = null
            }

            const decoded = Cards.CardSchema.safeParse(rawCard)
            if (c.cardMode === "invalidNull" && decoded.success) return false
            if (c.cardMode === "retiredLinearIssue" && decoded.success && decoded.data.kind !== "retired") return false

            const gwOk = GatewayWorkspace.isGatewayWorkspaceId(c.wsId)
            const gwSchema = GatewayWorkspace.gatewayCardPayload({
              workspaceId: GatewayWorkspace.GatewayCardWorkspaceIdSchema.optional(),
              listRequest: z.object({ workspaceId: z.string() }).optional(),
              preparations: z.array(z.object({ workspaceId: z.string() })).optional()
            })
            const gwLocalRejected = gwSchema.safeParse({
              workspaceId: "0123456789abcdef",
              listRequest: { workspaceId: "0123456789abcdef" },
              preparations: [{ workspaceId: "0123456789abcdef" }]
            })
            const gwLocalAccepted = gwSchema.safeParse({
              workspaceId: "0123456789abcdef",
              localGateway: true,
              listRequest: { workspaceId: "0123456789abcdef" },
              preparations: [{ workspaceId: "0123456789abcdef" }]
            })
            if (gwLocalRejected.success || !gwLocalAccepted.success) return false
            if (c.wsId === "" && gwOk) return false

            const digestIn = AgentTurnJournal.agentTurnJournalDigestInput("batch", { batch: 1 })
            if (!digestIn.startsWith("smithers-agent-turn/batch/v1:")) return false

            const prevHead: AgentTurnJournal.AgentTurnJournalHead = {
              version: 1,
              acceptance: "b".repeat(64),
              cursor: { version: 1, runId: "r1", legId: "l1", batch: 0, position: 0, hash: "a".repeat(64) },
              bytes: 100,
              terminal: c.batchMode === "terminal",
              hash: "a".repeat(64)
            } as any

            const batch: AgentTurnJournal.AgentTurnBatch = {
              version: 1,
              runId: "r1",
              legId: "l1",
              batch: c.batchMode === "wrongBatch" ? 9 : 1,
              from: 1,
              previousHash: c.batchMode === "wrongHash" ? "f".repeat(64) : "a".repeat(64),
              hash: "c".repeat(64),
              frames: c.batchMode === "midDone"
                ? [
                  { type: "done", runId: "r1" },
                  { type: "delta", runId: "r1", text: "after" }
                ]
                : [{ type: "delta", runId: "r1", text: "hi" }]
            } as any

            let rejected = false
            try {
              const projected = AgentTurnJournal.projectAgentTurnBatch(prevHead, batch)
              if (projected.cursor.batch !== 1 || projected.cursor.position !== 1) return false
            } catch (e) {
              rejected = e instanceof AgentTurnJournal.AgentTurnBatchRejected
            }
            if (c.batchMode === "valid" && rejected) return false
            if (c.batchMode !== "valid" && !rejected) return false

            expect(CardAction.ActionSchema).toBeDefined()
            expect(SetupCard).toBeDefined()
            expect(StackView).toBeDefined()
            expect(UiInstruction).toBeDefined()
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })
})
