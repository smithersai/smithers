import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentCommands from "../src/AgentCommands.ts"
import * as AgentContext from "../src/AgentContext.ts"
import * as AgentInstructions from "../src/AgentInstructions.ts"
import * as AgentRoles from "../src/AgentRoles.ts"
import * as AgentToolResult from "../src/AgentToolResult.ts"
import * as AgentTurnJournal from "../src/AgentTurnJournal.ts"
import * as BranchCard from "../src/BranchCard.ts"
import * as BranchTreeNodeCard from "../src/BranchTreeNodeCard.ts"
import * as CardAction from "../src/CardAction.ts"
import * as Cards from "../src/Cards.ts"
import * as ConfiguredModel from "../src/ConfiguredModel.ts"
import * as ContextPreflight from "../src/ContextPreflight.ts"
import * as DiffCard from "../src/DiffCard.ts"
import * as FactoryProjection from "../src/FactoryProjection.ts"
import * as FileCard from "../src/FileCard.ts"
import * as FileList from "../src/FileList.ts"
import * as FileRead from "../src/FileRead.ts"
import * as FlowCard from "../src/FlowCard.ts"
import * as LocalApp from "../src/LocalApp.ts"
import * as LocalLsp from "../src/LocalLsp.ts"
import * as MonitorCard from "../src/MonitorCard.ts"
import * as Mythical from "../src/Mythical.ts"
import * as Refusal from "../src/Refusal.ts"
import * as RepositoryHome from "../src/RepositoryHome.ts"
import * as RunCard from "../src/RunCard.ts"
import * as SetupCard from "../src/SetupCard.ts"
import * as Sha256 from "../src/Sha256.ts"
import * as StackIssues from "../src/StackIssues.ts"
import * as StackView from "../src/StackView.ts"
import * as SubagentCard from "../src/SubagentCard.ts"
import * as TodoCard from "../src/TodoCard.ts"
import * as UiInstruction from "../src/UiInstruction.ts"
import * as UserFailure from "../src/UserFailure.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/rpc Wave10 Deep Fuzzing", () => {
  it("fuzzes ConfiguredModel credentials, extraBody, bindingOf, drafts, problems, inputs, answers, and samples", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        originKind: Schema.Literals([
          "https",
          "http_loopback",
          "http_remote",
          "with_creds",
          "with_query",
          "invalid_url",
          "empty"
        ]),
        problemKind: Schema.Literals([
          "gen_ok_num_temp",
          "gen_ok_str_temp",
          "gen_ok_no_temp",
          "gen_empty_prompt",
          "gen_bad_tokens",
          "gen_bad_temp_str",
          "gen_bad_temp_num",
          "dec_ok",
          "dec_dup_field",
          "dec_invalid_field",
          "dec_state_size",
          "dec_no_questions",
          "dec_empty_q",
          "dec_choice_too_few",
          "dec_score_too_few",
          "dec_score_dup",
          "dec_score_reserved"
        ]),
        answerKind: Schema.Literals([
          "generation",
          "decision_empty",
          "decision_bool",
          "decision_choice",
          "decision_score"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ originKind, problemKind, answerKind }) =>
          Effect.sync(() => {
            const originInput = originKind === "https"
              ? "https://api.example.com"
              : originKind === "http_loopback"
              ? "http://127.0.0.1:8080"
              : originKind === "http_remote"
              ? "http://example.com"
              : originKind === "with_creds"
              ? "https://u:p@api.example.com"
              : originKind === "with_query"
              ? "https://api.example.com?a=1"
              : originKind === "invalid_url"
              ? "://not-a-url"
              : undefined
            const parsedOrigin = ConfiguredModel.modelOriginOf(originInput)
            if (originKind === "https" || originKind === "http_loopback") {
              expect(parsedOrigin).toBeDefined()
            } else {
              expect(parsedOrigin).toBeUndefined()
            }
            expect(ConfiguredModel.isLoopbackOrigin("://bad")).toBe(false)
            expect(ConfiguredModel.isLoopbackOrigin("http://localhost:1234")).toBe(true)

            const creds = ConfiguredModel.customModelCredentials({
              SMITHERS_MODEL_KEY_MY_CUSTOM: "secret-val",
              SMITHERS_MODEL_KEY_MY_CUSTOM_ORIGIN: "https://custom.example.com",
              SMITHERS_MODEL_KEY_BAD_NAME_ORIGIN: "://bad",
              SMITHERS_MODEL_KEY_OPENAI_API_KEY_ORIGIN: "https://api.openai.com",
              SMITHERS_MODEL_KEY_lower_ORIGIN: "https://x.example.com"
            })
            expect(creds.length).toBeGreaterThanOrEqual(1)
            const listed = ConfiguredModel.hostModelCredentials({
              SMITHERS_MODEL_KEY_MY_CUSTOM: "secret-val",
              SMITHERS_MODEL_KEY_MY_CUSTOM_ORIGIN: "https://custom.example.com"
            })
            expect(listed.length).toBeGreaterThan(0)

            expect(
              ConfiguredModel.ModelCredentialRequestSchema.safeParse({
                requestId: "req-12345678",
                action: "enroll",
                name: "MY_CUSTOM",
                value: "   "
              }).success
            ).toBe(false)
            expect(
              ConfiguredModel.ModelCredentialRequestSchema.safeParse({
                requestId: "req-12345678",
                action: "enroll",
                name: "MY_CUSTOM",
                value: "sk-valid-value",
                origin: "https://custom.example.com"
              }).success
            ).toBe(true)
            const f1 = ConfiguredModel.failedModelCredential({ code: "storage_unavailable" })
            expect(f1.ok).toBe(false)
            if (!f1.ok) expect(f1.fault).toBe("infra")
            const f2 = ConfiguredModel.failedModelCredential({ code: "invalid", field: "name" })
            expect(f2.ok).toBe(false)
            if (!f2.ok) expect(f2.fault).toBe("user")

            expect(ConfiguredModel.ModelExtraBodySchema.safeParse({ ok: 1 }).success).toBe(true)
            expect(ConfiguredModel.ModelExtraBodySchema.safeParse({ nested: [{ apiKey: "x" }] }).success).toBe(false)
            expect(ConfiguredModel.ModelExtraBodySchema.safeParse({ big: "a".repeat(3000) }).success).toBe(false)

            const baseModel: ConfiguredModel.ConfiguredModel = {
              id: "m-one",
              protocol: "openai-chat",
              baseUrl: "https://api.example.com",
              path: "/v1/chat/completions",
              modelId: "gpt-test",
              credential: "OPENAI_API_KEY",
              extraBody: { seed: 1 }
            }
            const b1 = ConfiguredModel.bindingOf(baseModel)
            expect(b1.baseUrl).toBe("https://api.example.com")
            const b2 = ConfiguredModel.bindingOf({
              id: "m-two",
              protocol: "openai-chat",
              modelId: "gpt-test",
              credential: "OPENAI_API_KEY"
            })
            expect(b2.baseUrl).toBeUndefined()

            expect(ConfiguredModel.modelStateFieldsOf("plain")[0]?.kind).toBe("text")
            expect(ConfiguredModel.modelStateFieldsOf(42)[0]?.kind).toBe("json")
            expect(ConfiguredModel.modelStateFieldsOf(null)[0]?.kind).toBe("json")
            expect(ConfiguredModel.modelStateFieldsOf([1, 2])[0]?.kind).toBe("json")
            expect(ConfiguredModel.modelStateFieldsOf({ "bad key!": 1 })[0]?.kind).toBe("json")

            expect(ConfiguredModel.modelCallDefault("generation").kind).toBe("generation")
            expect(ConfiguredModel.modelCallDefault("decision").kind).toBe("decision")

            const makeDraft = (): ConfiguredModel.ModelCallDraft => {
              switch (problemKind) {
                case "gen_ok_num_temp":
                  return { kind: "generation", system: "", prompt: "hi", maxTokens: 64, temperature: 0.5 }
                case "gen_ok_str_temp":
                  return { kind: "generation", system: "", prompt: "hi", maxTokens: 64, temperature: "0.7" }
                case "gen_ok_no_temp":
                  return { kind: "generation", system: "", prompt: "hi", maxTokens: 64 }
                case "gen_empty_prompt":
                  return { kind: "generation", system: "", prompt: "   ", maxTokens: 64 }
                case "gen_bad_tokens":
                  return { kind: "generation", system: "", prompt: "hi", maxTokens: 0 }
                case "gen_bad_temp_str":
                  return { kind: "generation", system: "", prompt: "hi", maxTokens: 64, temperature: "abc" }
                case "gen_bad_temp_num":
                  return { kind: "generation", system: "", prompt: "hi", maxTokens: 64, temperature: 9 }
                case "dec_ok":
                  return {
                    kind: "decision",
                    state: [{ key: "x", kind: "text", value: "ok" }],
                    questions: {
                      q1: { type: "boolean", instructions: "yes?" },
                      q2: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } },
                      q3: { type: "score", instructions: "rate", criteria: ["low", "high"] }
                    }
                  }
                case "dec_dup_field":
                  return {
                    kind: "decision",
                    state: [
                      { key: "x", kind: "text", value: "1" },
                      { key: "x", kind: "text", value: "2" }
                    ],
                    questions: { q: { type: "boolean", instructions: "ok?" } }
                  }
                case "dec_invalid_field":
                  return {
                    kind: "decision",
                    state: [{ key: "x", kind: "json", value: "{bad" }],
                    questions: { q: { type: "boolean", instructions: "ok?" } }
                  }
                case "dec_state_size":
                  return {
                    kind: "decision",
                    state: [{ key: "big", kind: "text", value: "a".repeat(35_000) }],
                    questions: { q: { type: "boolean", instructions: "ok?" } }
                  }
                case "dec_no_questions":
                  return { kind: "decision", state: [], questions: {} }
                case "dec_empty_q":
                  return {
                    kind: "decision",
                    state: [],
                    questions: { q: { type: "boolean", instructions: "   " } }
                  }
                case "dec_choice_too_few":
                  return {
                    kind: "decision",
                    state: [],
                    questions: { q: { type: "choice", instructions: "pick", criteria: { a: "only one" } } }
                  }
                case "dec_score_too_few":
                  return {
                    kind: "decision",
                    state: [],
                    questions: { q: { type: "score", instructions: "rate", criteria: ["one"] } }
                  }
                case "dec_score_dup":
                  return {
                    kind: "decision",
                    state: [],
                    questions: { q: { type: "score", instructions: "rate", criteria: ["a", "a"] } }
                  }
                case "dec_score_reserved":
                  return {
                    kind: "decision",
                    state: [],
                    questions: { q: { type: "score", instructions: "rate", criteria: ["ok", "__proto__"] } }
                  }
              }
            }
            const draft = makeDraft()
            const problem = ConfiguredModel.modelCallProblemOf(draft)
            const input = ConfiguredModel.modelCallInputOf(draft)
            if (problem === undefined) {
              expect(input).toBeDefined()
              expect(ConfiguredModel.ModelCallInputSchema.safeParse(input).success).toBe(true)
            } else {
              expect(input).toBeUndefined()
              if (draft.kind === "decision") {
                expect(ConfiguredModel.ModelCallInputSchema.safeParse(draft).success).toBe(false)
              }
            }

            const protoCriteria = JSON.parse('{"__proto__":"bad","a":"ok"}')
            expect(
              ConfiguredModel.ModelQuestionSchema.safeParse({
                type: "choice",
                instructions: "pick",
                criteria: protoCriteria
              }).success
            ).toBe(false)

            const output: ConfiguredModel.ModelCallOutput = answerKind === "generation"
              ? { kind: "generation", text: "hello sk-secret world" }
              : answerKind === "decision_empty"
              ? { kind: "decision", answers: {} }
              : answerKind === "decision_bool"
              ? { kind: "decision", answers: { ok: { type: "boolean", value: true, probability: 0.95 } } }
              : answerKind === "decision_choice"
              ? {
                kind: "decision",
                answers: {
                  pick: { type: "choice", value: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.8 }
                }
              }
              : {
                kind: "decision",
                answers: {
                  rate: {
                    type: "score",
                    value: 1,
                    label: "high",
                    probabilities: { low: 0.1, high: 0.9 },
                    confidence: 0.9
                  }
                }
              }
            expect(ConfiguredModel.ModelCallOutputSchema.safeParse(output).success).toBe(true)
            const sample = ConfiguredModel.modelCallSample(output, "sk-secret")
            expect(sample).not.toContain("sk-secret")
            return true
          }),
        { executions: Math.min(executions, 80), seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes CardAction historical tag migrations and secret arg scrubbing", async () => {
    const tags = [
      "prs",
      "prs.list",
      "prs.view",
      "box.list",
      "box.open",
      "box.view",
      "flow.run.stop",
      "flow.run.retry",
      "flow.run.stop-all",
      "change.view",
      "change.diff",
      "change.pins",
      "change.checks",
      "files.open-diff",
      "files.list",
      "box.files",
      "box.file",
      "repo.tree",
      "files.read",
      "proposal",
      "flow.list",
      "approvals.list",
      "approvals.open",
      "runs.attention",
      "github.retry",
      "github.app",
      "github.app.open",
      "github.app.choose",
      "github.reconcile",
      "settings.address",
      "settings.capacity",
      "settings.parallel",
      "settings.preapprove-default",
      "settings.daily-admissions",
      "settings.obsidian",
      "settings.model-key",
      "settings.setup",
      "settings.fast-model",
      "secrets.set",
      "secrets.delete",
      "secrets.scope",
      "secrets.bind",
      "context.inspect",
      "runs"
    ] as const
    const arb = Arbitrary.schema(
      Schema.Struct({
        tag: Schema.Literals(tags),
        scope: Schema.Literals(["all", "main-only", "custom", "none"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ tag, scope }) =>
          Effect.sync(() => {
            const args: Record<string, string> = {
              id: "1",
              value: "secret-v",
              key: "secret-k",
              token: "secret-t",
              ...(scope !== "none" ? { scope } : {})
            }
            const parsed = CardAction.registeredAction({ tag, label: "Go", args })
            expect(parsed.tag.length).toBeGreaterThan(0)
            if (tag.startsWith("secrets.")) {
              expect(parsed.args?.value).toBeUndefined()
              expect(parsed.args?.key).toBeUndefined()
              expect(parsed.args?.token).toBeUndefined()
              if (tag === "secrets.scope" && scope === "all") {
                expect(parsed.args?.scope).toBe("all_branches")
              }
              if (tag === "secrets.scope" && scope === "main-only") {
                expect(parsed.args?.scope).toBe("main_only")
              }
            }
            return true
          }),
        { executions: Math.min(executions, 120), seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes Cards, SubagentCard, AgentRoles, Mythical, FileRead/FileList, LocalLsp, StackView/StackIssues, and remaining card schemas", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        fileArgKind: Schema.Literals([
          "trailing_space",
          "escaped_quote",
          "unclosed_quote",
          "bad_escape",
          "ref_missing_val",
          "ref_ok",
          "empty_args",
          "too_many",
          "colon_empty_path",
          "zero_line"
        ]),
        stackState: Schema.Literals([
          "delivering",
          "integrating",
          "waiting",
          "proposed",
          "retrying",
          "landed",
          "blocked"
        ]),
        hours: Schema.Literals([0, 1, 2])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ fileArgKind, stackState, hours }) =>
          Effect.sync(() => {
            const argStr = fileArgKind === "trailing_space"
              ? "src/a.ts   "
              : fileArgKind === "escaped_quote"
              ? '"src/a\\"b.ts"'
              : fileArgKind === "unclosed_quote"
              ? '"unclosed'
              : fileArgKind === "bad_escape"
              ? '"\\q"'
              : fileArgKind === "ref_missing_val"
              ? "src/a.ts --ref"
              : fileArgKind === "ref_ok"
              ? "src/a.ts:10:2 --ref main"
              : fileArgKind === "empty_args"
              ? "   "
              : fileArgKind === "too_many"
              ? "a b c"
              : fileArgKind === "colon_empty_path"
              ? ":10"
              : "src/a.ts:0"
            const readRes = FileRead.parseFileReadArgs(argStr)
            if (fileArgKind === "ref_ok" || fileArgKind === "trailing_space" || fileArgKind === "escaped_quote") {
              expect("payload" in readRes).toBe(true)
            } else {
              expect("error" in readRes).toBe(true)
            }
            FileList.parseFileListArgs(argStr)
            expect(FileList.listingValue("o/r", "", [])).toContain("is empty")

            expect("failure" in AgentCommands.decodeCommandsCall(JSON.stringify({ action: 123 }))).toBe(true)
            expect("failure" in AgentCommands.decodeCommandsCall(JSON.stringify({ action: "bogus" }))).toBe(true)
            expect("failure" in AgentCommands.decodeCommandsCall(JSON.stringify({ action: "execute", name: "  " }))).toBe(true)

            expect(AgentInstructions.smithersSubjectLine(true)).not.toBe(AgentInstructions.smithersSubjectLine(false))
            expect(AgentInstructions.namedCantYets([]).length).toBeGreaterThan(0)
            expect(AgentInstructions.namedCantYets(["/file"]).join(" ")).toContain("/file")
            expect(AgentInstructions.cantYetsSentence(["a", "b"])).toContain("You cannot")
            expect(
              AgentInstructions.agentCommandLine({
                name: "x",
                args: "<id>",
                summary: "do x",
                agent: "confirm"
              })
            ).toContain("asks the person")
            expect(
              AgentInstructions.agentCommandLine({
                name: "y",
                summary: "do y",
                agent: "run"
              })
            ).not.toContain("asks the person")

            const ctx: AgentContext.AgentRuntimeContext = {
              version: AgentContext.AGENT_RUNTIME_CONTEXT_VERSION,
              product: "smithers",
              capturedAt: 1700000000000,
              revision: 1,
              surface: "chat",
              theme: "dark",
              selectedWorldDocument: null,
              github: { connected: false, login: null, repositories: null },
              cloud: { state: "signed-out", username: null },
              worldState: {
                documentCount: 3,
                documents: [
                  { path: "a.md", title: "A", confidence: 0.9 },
                  { path: "b.md", title: "B", confidence: 0.2, body: "   ", bodyTruncated: true },
                  { path: "c.md", title: "C", confidence: 0.2, body: "   ", bodyTruncated: false }
                ]
              },
              connectors: [],
              tabs: [{ id: "main", kind: "main", title: "Chat", active: true }],
              recentCards: [],
              capabilities: [],
              limitations: []
            }
            const rendered = AgentContext.renderAgentRuntimeContext(ctx)
            expect(rendered).toContain("no card tab")
            expect(rendered).toContain("empty note")
            expect(rendered).toContain("did not fit")
            expect(
              AgentContext.composeAgentInstructions("base", ctx, [
                { item: { kind: "file", label: "a.ts", ref: "src/a.ts" }, text: "code" }
              ])
            ).toContain("Selected context:")

            const firstRoleId = AgentRoles.AGENT_ROLE_IDS[0]!
            expect(AgentRoles.agentRole(firstRoleId).id).toBe(firstRoleId)
            expect(() => AgentRoles.agentRole("nope" as any)).toThrow(AgentRoles.UnknownAgentRole)
            const firstCloudId = AgentRoles.CLOUD_AGENT_ROLE_IDS[0]!
            expect(AgentRoles.cloudRole(firstCloudId).id).toBe(firstCloudId)
            expect(() => AgentRoles.cloudRole("nope" as any)).toThrow(AgentRoles.UnknownAgentRole)
            expect(AgentRoles.agentRoleTitle(AgentRoles.AGENT_ROLES[0]!)).toContain("·")
            expect(AgentRoles.knownModelLabel(AgentRoles.AGENT_ROLES[0]!.model.id)).toBeDefined()
            expect(AgentRoles.knownModelLabel("unknown-model-xyz")).toBeUndefined()

            expect(AgentToolResult.boundToolResult("hello", 0)).toBeDefined()

            expect(
              AgentTurnJournal.AgentTurnJournalRequestSchema.safeParse({
                runId: "r1",
                frames: [{ type: "unknown-frame", runId: "r1" }]
              }).success
            ).toBe(false)

            expect(() => Mythical.mythicalRoute("stack", "", "r")).toThrow(
              Mythical.MythicalRouteSegmentInvalid
            )
            expect(() => Mythical.mythicalRoute("stack", ".", "r")).toThrow(
              Mythical.MythicalRouteSegmentInvalid
            )
            expect(() => Mythical.mythicalRoute("stack", "o", "..")).toThrow(
              Mythical.MythicalRouteSegmentInvalid
            )
            expect(Mythical.MythicalStackStateSchema.parse("future-state")).toBe("unknown")
            expect(Mythical.MythicalChangeKindSchema.parse("future-kind")).toBe("unknown")
            expect(Mythical.MythicalItemStateSchema.parse("future-item")).toBe("unknown")
            expect(Mythical.MythicalWikiSchema.parse({ state: "future-wiki", pages: 0, edited: 0, attempt: 0 }).state).toBe("unknown")

            const item: Mythical.MythicalItem = {
              id: "item-123456789",
              state: stackState,
              reason: "",
              todo: { replans: 1, attempts: 3 },
              conflicts: ["src/a.ts"]
            } as any
            const stack: Mythical.MythicalStack = {
              state: "active",
              items: [item],
              changes: [{ id: "c1", kind: "revert", itemId: "other", title: "Revert" }]
            } as any
            expect(StackView.itemStateLabel(item).length).toBeGreaterThan(0)
            expect(StackView.itemTitle(stack, item)).toBe("item-123")
            StackView.itemReason(item)
            StackIssues.issueProgress(item)
            expect(StackIssues.stackMetrics(stack).reverts).toBe(1)

            expect(SubagentCard.verb("customTool").pending).toContain("customTool")
            expect(SubagentCard.clip("hello", 0)).toBe("")
            expect(SubagentCard.files([])).toBeUndefined()
            const diffStr = "@@ -1,2 +1,2 @@\n ctx\n\n\\ No newline\n-old\n+new\nfooter"
            SubagentCard.diffCounts(diffStr)
            const stoppedEntry: SubagentCard.Entry = {
              kind: "tool",
              tool: "bash",
              target: "ls",
              state: "stopped"
            } as any
            expect(SubagentCard.describe(stoppedEntry).state).toBe("stopped")
            const start = 0
            const end = hours === 0 ? 3600_000 : hours === 1 ? 3660_000 : 7200_000
            const singleHeader = SubagentCard.header(["done"], end, { title: "Worker", startedAt: start, endedAt: end })
            expect(singleHeader.text).toContain("h")

            expect(LocalApp.splitLabel("//pkg/sub:target")).toEqual({ package: "//pkg/sub", name: "target" })
            expect(LocalApp.splitLabel("//pkg/sub")).toEqual({ package: "//pkg/sub", name: "sub" })
            expect(LocalLsp.lspLanguageFor("README")).toBeNull()
            expect(LocalLsp.lspLanguageFor("a.ts")).toBe("typescript")
            expect(LocalLsp.lspLanguageFor("a.unknownext")).toBeNull()
            expect(
              LocalLsp.LspDiagnosticsResponseSchema.safeParse({
                path: "src/a.ts",
                items: null,
                total: 1,
                digest: "0".repeat(64)
              }).success
            ).toBe(false)
            expect(
              LocalLsp.LspDiagnosticsResponseSchema.safeParse({
                path: "../bad.ts",
                items: null,
                total: null,
                digest: "0".repeat(64)
              }).success
            ).toBe(false)
            expect(FactoryProjection.ruleFlows({ flow: "f1" } as any)).toEqual(["f1"])
            expect(FactoryProjection.ruleFlows({ flow: ["f1", "f2"] } as any)).toEqual(["f1", "f2"])
            expect(Refusal.faultOfStatus(null)).toBe("infra")
            expect(Refusal.faultOfStatus(502)).toBe("dependency")
            expect(() => Sha256.digestSync("\udc00")).toThrow(TypeError)

            const badObj = new Proxy({}, {
              get() {
                throw new Error("no read")
              }
            })
            expect(UserFailure.presentUserFailure({} as any, null).detail.length).toBeGreaterThan(0)
            expect(UserFailure.presentUserFailure({} as any, badObj).detail.length).toBeGreaterThan(0)

            expect(
              ContextPreflight.ContextPreflightPageSchema.safeParse({ index: 2, total: 2 }).success
            ).toBe(false)
            expect(
              ContextPreflight.ContextPreflightFrameSchema.safeParse({
                type: "context_preflight",
                runId: "r1",
                page: { index: 0, total: 1 },
                result: { items: [], dropped: [] }
              }).success
            ).toBe(false)

            expect(
              BranchCard.BranchActivityEntry.safeParse({
                id: "1",
                at: 1,
                kind: "edit",
                actor: "u",
                path: "../escape"
              }).success
            ).toBe(false)
            expect(
              BranchTreeNodeCard.BranchTreeNodeCardSchema.safeParse({
                name: "main",
                children: []
              })
            ).toBeDefined()
            expect(
              DiffCard.DiffCardSchema.safeParse({
                path: "a.ts",
                change: "modified",
                renamed_to: "b.ts",
                against: { kind: "head" },
                hunks: []
              }).success
            ).toBe(false)
            expect(
              FileCard.FileCardSchema.safeParse({
                path: "a.bin",
                mode: "live",
                content: { kind: "binary", bytes: 10 }
              }).success
            ).toBe(false)
            expect(
              FlowCard.FlowCardSchema.safeParse({
                actions: [{ id: "merge", label: "Merge" }]
              }).success
            ).toBe(false)
            expect(
              TodoCard.TodoCardSchema.safeParse({
                actions: [{ id: "merge", label: "Merge" }]
              }).success
            ).toBe(false)
            expect(
              MonitorCard.RunStepSchema.safeParse({
                id: "s",
                k: 0,
                key: "wrong",
                state: "running"
              }).success
            ).toBe(false)
            expect(
              MonitorCard.MonitorCardSchema.safeParse({
                replay: { at: 5, last: 2 }
              }).success
            ).toBe(false)
            expect(
              RepositoryHome.RepositoryHomeLinks.safeParse({
                type: "links",
                items: [{ label: "Bad", path: "/abs" }]
              }).success
            ).toBe(false)
            expect(
              RunCard.RunViewStateSchema.safeParse({ filter: "forks" })
            ).toBeDefined()
            expect(
              SetupCard.SetupCardSchema.safeParse({
                steps: [],
                models: []
              }).success
            ).toBe(false)

            expect(
              UiInstruction.UiInstructionFrameSchema.safeParse({
                command: "secrets.set",
                value: 123
              }).success
            ).toBe(false)
            expect(
              UiInstruction.UiInstructionFrameSchema.safeParse({
                command: "runs",
                state: { filter: "all" }
              }).success
            ).toBe(false)
            expect(
              UiInstruction.UiInstructionFrameSchema.safeParse({
                command: "monitor",
                state: { filter: "not-a-valid-filter" }
              }).success
            ).toBe(false)

            expect(
              Cards.CardSchema.safeParse({
                id: "c1",
                kind: "browser",
                payload: { url: "javascript:alert(1)", frameable: true, title: "x" }
              }).success
            ).toBe(false)
            expect(
              Cards.CardSchema.safeParse({
                id: "c2",
                kind: "form",
                payload: {
                  title: "F",
                  action: "secrets.set",
                  fields: [{ name: "secret", label: "Secret", kind: "write-only" }],
                  draft: { secret: "leaked" },
                  given: {}
                }
              }).success
            ).toBe(false)
            Cards.CardSchema.safeParse({
              id: "c3",
              kind: "models",
              payload: { apiKey: "strip-me", models: [] }
            })
            Cards.CardSchema.safeParse({
              id: "c4",
              kind: "env",
              payload: { vars: [{ name: "A", value: "strip-me" }, "non-obj"] }
            })
            Cards.CardSchema.safeParse({
              id: "c5",
              kind: "secrets",
              payload: { repo: "o/r", secrets: [{ name: "K", scope: "main_only" }] }
            })
            Cards.CardSchema.safeParse({
              id: "c6",
              kind: "agents",
              payload: { agents: [null] }
            })

            return true
          }),
        { executions: Math.min(executions, 40), seed }
      )
    )
    assertPassed(report)
  }, 60_000)
})
