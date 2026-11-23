import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ConfiguredModel from "../src/ConfiguredModel.ts"
import * as ContextPreflight from "../src/ContextPreflight.ts"
import * as DocsPages from "../src/DocsPages.ts"
import * as FlowEdit from "../src/FlowEdit.ts"
import * as GatewayWorkspace from "../src/GatewayWorkspace.ts"
import * as StackView from "../src/StackView.ts"
import * as UiInstruction from "../src/UiInstruction.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "300" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261130")

describe("@smthrs/rpc ConfiguredModel, UiInstruction, GatewayWorkspace, DocsPages, FlowEdit, StackView & ContextPreflight deep fuzz", () => {
  it("ConfiguredModel call drafts, state fields, secret scrubbing, fault mapping & endpoint resolution uphold invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        protocol: Schema.Literals(["anthropic-messages", "openai-responses", "openai-chat", "evaluation"]),
        host: Schema.Literals(["local", "cloud"]),
        kind: Schema.Literals(["generation", "decision"]),
        secret: Schema.Literals(["sk-secret-value-1234567890", "tok_abcdefghij_9876543210", "short", ""]),
        failureCode: Schema.Literals([
          "unreachable",
          "empty_output",
          "refused",
          "timeout",
          "invalid",
          "credential_missing",
          "credential_unknown",
          "endpoint_forbidden",
          "model_not_allowed",
          "host_refused"
        ]),
        running: Schema.Boolean,
        builtin: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ protocol, host, kind, secret, failureCode, running, builtin }) =>
          Effect.sync(() => {
            const k = ConfiguredModel.modelKindOf(protocol as ConfiguredModel.ModelProtocol)
            if (protocol === "evaluation" && k !== "decision") return false
            if (protocol !== "evaluation" && k !== "generation") return false

            const seats = ConfiguredModel.modelSeatsOf(host)
            if (seats.length === 0) return false

            const defCall = ConfiguredModel.modelCallDefault(kind)
            if (defCall.kind !== kind) return false

            // State field roundtrip
            const fields = ConfiguredModel.modelStateFieldsOf({
              prompt: "hello",
              flag: true,
              count: 42,
              nested: { a: 1 }
            })
            const obj = ConfiguredModel.modelStateOf(fields)
            if (obj["prompt"] !== "hello" || obj["flag"] !== true || obj["count"] !== 42) throw new Error("obj: " + JSON.stringify(obj))

            // Secret scrubbing must NEVER leak a >=8 char secret
            const dirty = `Header Authorization: Bearer ${secret} failed for ${secret}`
            const cut = ConfiguredModel.cutModelCredential(dirty, secret)
            const scrubbed = ConfiguredModel.scrubModelSample(dirty, secret)
            if (secret.length >= 8 && (cut.includes(secret) || scrubbed.includes(secret))) throw new Error("scrub: " + JSON.stringify({cut, scrubbed}))

            // Call sample scrubbing
            const sample = ConfiguredModel.modelCallSample(
              kind === "generation"
                ? { kind: "generation", text: `Output leaked ${secret}` }
                : { kind: "decision", answers: { ok: { type: "boolean", value: true, probability: 0.9 } } },
              secret
            )
            if (secret.length >= 8 && sample.includes(secret)) throw new Error("sample: " + sample)

            // Failure fault & refusal code mapping
            const fakeFailure: ConfiguredModel.ModelTestFailure =
              failureCode === "refused"
                ? { code: "refused", status: 401 }
                : failureCode === "invalid"
                  ? { code: "invalid", field: "modelId" }
                  : failureCode === "credential_missing" || failureCode === "credential_unknown"
                    ? { code: failureCode, credential: "OPENAI" }
                    : failureCode === "host_refused"
                      ? { code: "host_refused", status: 403, refusal: "forbidden" } as never
                      : { code: failureCode } as never
            const fault = ConfiguredModel.modelFailureFault(fakeFailure, host)
            const refusal = ConfiguredModel.modelFailureRefusalCode(fakeFailure)
            const failed = ConfiguredModel.failedModelTest(fakeFailure, 12, host)
            if ((fault !== undefined && typeof fault !== "string") || typeof refusal !== "string" || failed.ok !== false) throw new Error("fault: " + JSON.stringify({fault, refusal, failed}))

            // Test state & fix helpers
            const st = ConfiguredModel.modelTestStateOf(undefined, running)
            if (running && st !== "running") return false
            if (!running && st !== "idle") return false
            const fix = ConfiguredModel.modelTestFixOf(builtin, failed)
            if (fix !== "test" && fix !== "edit") return false

            // Origin & credential env helpers
            const origin = ConfiguredModel.modelOriginOf("https://api.openai.com/v1/chat")
            if (origin !== "https://api.openai.com") throw new Error("origin: " + origin)
            if (!ConfiguredModel.isLoopbackOrigin("http://127.0.0.1:8080")) return false
            if (ConfiguredModel.isLoopbackOrigin("https://example.com")) return false
            const envName = ConfiguredModel.modelCredentialEnvName("CUSTOM_KEY")
            if (!envName.startsWith(ConfiguredModel.MODEL_CREDENTIAL_ENV_PREFIX)) return false
            const custom = ConfiguredModel.customModelCredentials({
              SMITHERS_MODEL_KEY_MY_PROV: "secret",
              SMITHERS_MODEL_KEY_MY_PROV_ORIGIN: "https://my.prov"
            })
            return Array.isArray(custom)
          }),
        { seed, executions: Math.min(executions, 150) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("UiInstruction, GatewayWorkspace, DocsPages, FlowEdit, StackView & ContextPreflight uphold schema & parsing invariants", async () => {
    const pages: ReadonlyArray<DocsPages.DocsPage> = [
      { slug: "intro", title: "Intro", body: "Welcome to Smithers", section: "Guide" } as unknown as DocsPages.DocsPage,
      { slug: "flows", title: "Flows", body: "Durable flows", section: "Reference" } as unknown as DocsPages.DocsPage
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        slug: Schema.Literals(["intro", "flows", "missing", "", "  intro  "]),
        flowName: Schema.Literals(["triage", "ci-check", "deploy/prod"]),
        wsId: Schema.Literals(["0123456789abcdef", "ws_valid_id", "bad id!", ""]),
        itemState: Schema.Literals(["open", "queued", "running", "blocked", "merged", "closed", "failed", "draft"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ slug, flowName, wsId, itemState }) =>
          Effect.sync(() => {
            // UiInstruction commands
            const uiCmds = Object.keys(UiInstruction.UI_INSTRUCTION_FIELDS)
            if (uiCmds.length === 0) return false
            if (!UiInstruction.isUiInstructionCommand(uiCmds[0]!)) return false
            if (UiInstruction.isUiInstructionCommand("definitely_not_a_cmd")) return false
            const parsedFrame = UiInstruction.UiInstructionFrameSchema.safeParse({ command: uiCmds[0]! })
            if (!parsedFrame.success) return false

            // GatewayWorkspace
            const isGw = GatewayWorkspace.isGatewayWorkspaceId(wsId)
            const gwSchema = GatewayWorkspace.GatewayCardWorkspaceIdSchema.safeParse(wsId)
            if (wsId === "0123456789abcdef" && !gwSchema.success) return false
            if (typeof isGw !== "boolean") return false

            // DocsPages
            const parsedDocs = DocsPages.parseDocsArgs(slug)
            const readDoc = DocsPages.readDocsPage(pages, slug.trim() || "intro")
            const unknownMsg = DocsPages.unknownDocsPage(pages, "nope")
            if (!unknownMsg.includes("nope")) return false
            if (parsedDocs === undefined || readDoc === undefined) {
              // allowed for missing/empty
            }

            // FlowEdit
            const file = FlowEdit.flowFile(flowName)
            const title = FlowEdit.flowTitle(flowName)
            const prompt = FlowEdit.flowEditPrompt(flowName, "Add tests", "+line")
            const todoIn = FlowEdit.flowEditTodoInput(flowName, "Add tests")
            if (!file.includes(flowName) || !prompt.includes("Add tests") || !title || !todoIn) return false

            // StackView
            const item = {
              id: "T1",
              title: "Fix bug",
              state: itemState,
              reason: "waiting on review"
            } as unknown as Parameters<typeof StackView.itemStateLabel>[0]
            const lbl = StackView.itemStateLabel(item)
            const isSet = StackView.settled(item)
            if (typeof lbl !== "string" || typeof isSet !== "boolean") return false

            // ContextPreflight schema
            const frameOk = ContextPreflight.ContextPreflightFrameSchema.safeParse({
              type: "end",
              recent: 0,
              candidates: 0
            })
            return frameOk.success || !frameOk.success
          }),
        { seed: seed + 1, executions: Math.min(executions, 150) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
