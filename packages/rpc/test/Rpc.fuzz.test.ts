import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeCrypto from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  ConfiguredModel,
  DocsPages,
  FileList,
  FileRead,
  GatewayWorkspace,
  NativeFailureCodes,
  PlueFailureCodes,
  PromptQueue,
  Refusal,
  Sha256,
  StackIssues,
  StackView,
  SubagentCard,
  UiInstruction,
  UserFailure,
  WebUrl,
  WorkerControls,
  WorkerFailureCodes
} from "../src/index.ts"

const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/rpc comprehensive fuzz invariants", () => {
  it("WebUrl schemas NEVER accept dangerous schemes (javascript:/data:/file:) or open-redirect protocol-relative paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
        Schema.Literals([
          "javascript:alert(1)",
          "JAVASCRIPT:alert(1)",
          "data:text/html,<script>alert(1)</script>",
          "vbscript:msgbox(1)",
          "file:///etc/passwd",
          "//evil.example/path",
          "/\\evil.example",
          "/safe/path?a=1#frag",
          "https://smithers.sh/docs"
        ])
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (raw) =>
          Effect.sync(() => {
            const httpRes = WebUrl.HttpUrlSchema.safeParse(raw)
            if (httpRes.success && !/^https?:\/\//i.test(httpRes.data)) return false
            const relRes = WebUrl.RelativeUrlPathSchema.safeParse(raw)
            if (relRes.success) {
              if (!relRes.data.startsWith("/") || relRes.data.startsWith("//") || relRes.data.includes("\\")) {
                return false
              }
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Sha256.digestSync matches Node crypto on well-formed UTF-16 and rejects unpaired surrogates with TypeError", async () => {
    const arb = Arbitrary.schema(Schema.String.pipe(Schema.check(Schema.isMaxLength(256))))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (text) =>
          Effect.sync(() => {
            if (!isWellFormed(text)) {
              try {
                Sha256.digestSync(text)
                return false
              } catch (err) {
                return err instanceof TypeError
              }
            }
            const expected = NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex")
            return Sha256.digestSync(text) === expected
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Refusal, Worker/Plue/Native failure code registries, and UserFailure never leak raw error detail", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Literals([400, 401, 403, 404, 409, 429, 500, 502, 503]),
        message: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
        retryHeader: Schema.OptionFromUndefinedOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(32)))),
        wIdx: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: WorkerFailureCodes.WORKER_FAILURE_CODES.length - 1 }))
        ),
        pIdx: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: PlueFailureCodes.PLUE_FAILURE_CODES.length - 1 }))
        ),
        nIdx: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: NativeFailureCodes.NATIVE_ROUTE_CODES.length - 1 }))
        )
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ status, message, retryHeader, wIdx, pIdx, nIdx }) =>
          Effect.sync(() => {
            const wCode = WorkerFailureCodes.WORKER_FAILURE_CODES[wIdx]!
            if (WorkerFailureCodes.workerFailureCode(wCode) !== wCode) return false
            if (Refusal.refusalCode(wCode) !== wCode || !Refusal.isWorkerFailureCode(wCode)) return false
            if (Refusal.refusalEntry(wCode) === null) return false

            const pCode = PlueFailureCodes.PLUE_FAILURE_CODES[pIdx]!
            if (Refusal.plueFailureCode(pCode) !== pCode) return false
            if (PlueFailureCodes.PLUE_FAILURES[pCode] === undefined) return false

            const nRoute = NativeFailureCodes.NATIVE_ROUTE_CODES[nIdx]!
            const nWire = NativeFailureCodes.nativeWireCode(nRoute)
            if (NativeFailureCodes.nativeFailureCode(nWire) !== nWire) return false
            if (!Refusal.isNativeFailureCode(nWire)) return false
            if (NativeFailureCodes.nativeFailureEntry(nWire) === undefined) return false

            const r = Refusal.refusalOf({ body: { code: wCode }, status, message })
            const stored = Refusal.storedRefusal(r)
            const back = Refusal.refusalFromStored(stored)
            if (back.origin !== r.origin || back.message !== r.message || back.code !== r.code) return false
            if (Refusal.statedWords(r) !== r.message) return false
            if (typeof Refusal.mayAutoRetry(r) !== "boolean") return false

            const parsed = Refusal.retryAfterHeader({
              get: (
                name
              ) => (name.toLowerCase() === "retry-after" && retryHeader._tag === "Some" ? retryHeader.value : null)
            })
            if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) return false

            if (UserFailure.failureDetail(new Error(message)) !== "[REDACTED]") return false
            type KnownErr = { readonly _tag: "KnownFailure" }
            const registry: UserFailure.UserFailureRegistry<KnownErr> = {
              KnownFailure: {
                fault: "user",
                sentence: "Something went wrong.",
                actions: ["retry"]
              }
            }
            const presented = UserFailure.presentUserFailure(registry, { _tag: "KnownFailure", secret: message })
            if (presented.tag !== "KnownFailure" || presented.detail !== "[REDACTED]") return false
            let unknownSeen = false
            const fallback = UserFailure.presentUserFailure(registry, { _tag: "Other", cause: new Error(message) }, {
              onUnknown: () => {
                unknownSeen = true
              }
            })
            if (!unknownSeen || fallback.tag !== null || fallback.detail !== "[REDACTED]") return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("PromptQueue & ConfiguredModel credential scrubbing, endpoint planning & call validation obey strict security invariants", async () => {
    const scopeArb = Schema.Literals(["s1", "s2"])
    const opArb = Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("enq"),
        id: Schema.Literals(["p1", "p2", "p3", "p4"]),
        scope: scopeArb,
        text: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24)))
      }),
      Schema.Struct({
        _tag: Schema.Literal("rem"),
        id: Schema.Literals(["p1", "p2", "p3", "p4"])
      })
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(opArb).pipe(Schema.check(Schema.isMaxLength(12))),
        draft: Schema.String.pipe(Schema.check(Schema.isMaxLength(20))),
        recordId: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          Schema.Literals(["default", "my-model-1", "INVALID", "a"])
        ]),
        credName: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          Schema.Literals(["OPENAI_API_KEY", "ORIGIN", "FOO_ORIGIN", "bad_key", "MY_KEY_1"])
        ]),
        proto: Schema.Literals(ConfiguredModel.MODEL_PROTOCOLS),
        host: Schema.Literals(["local", "cloud"]),
        origin: Schema.Literals(["https://api.openai.com/v1", "http://127.0.0.1:8080/v1", "http://evil.example/v1", "ftp://bad"]),
        secret: Schema.Literals(["sk-secret-value-12345678", "Bearer_token_abcdef_987654", "short"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ops, draft, recordId, credName, proto, host, origin, secret }) =>
          Effect.sync(() => {
            let queue: ReadonlyArray<PromptQueue.Prompt> = []
            for (const op of ops) {
              if (op._tag === "enq") {
                queue = PromptQueue.enqueue(queue, { id: op.id, scope: op.scope, text: op.text })
              } else {
                queue = PromptQueue.remove(queue, op.id)
              }
              const s1 = PromptQueue.inScope(queue, "s1")
              if (PromptQueue.next(queue, "s1") !== s1[0]) return false
              if (typeof PromptQueue.restoreDraft(s1, draft) !== "string") return false
            }

            if (ConfiguredModel.ModelRecordIdSchema.safeParse("default").success) return false
            if (ConfiguredModel.ModelRecordIdSchema.safeParse(recordId).success && recordId === "default") return false
            if (ConfiguredModel.ModelCredentialNameSchema.safeParse(credName).success && credName.endsWith("ORIGIN")) {
              return false
            }

            const leaked = `error: ${secret} leaked in output`
            const cut = ConfiguredModel.cutModelCredential(leaked, secret)
            if (secret.length >= 6 && cut.includes(secret)) return false
            const scrubbed = ConfiguredModel.scrubModelSample(leaked, secret)
            if (secret.length >= 6 && scrubbed.includes(secret)) return false
            if (ConfiguredModel.modelCredentialParts(secret).length === 0 && secret.length >= 6) return false

            const parsedOrigin = ConfiguredModel.modelOriginOf(origin)
            if (parsedOrigin !== undefined) {
              if (typeof ConfiguredModel.isLoopbackOrigin(parsedOrigin) !== "boolean") return false
            }
            const env: Record<string, string> = {
              OPENAI_API_KEY: "sk-1234567890",
              SMITHERS_MODEL_KEY_CUSTOM_ONE: "sk-custom-999999",
              SMITHERS_MODEL_KEY_CUSTOM_ONE_ORIGIN: "https://custom.example.test"
            }
            const listings = ConfiguredModel.hostModelCredentials(env)
            if (listings.length === 0) return false
            const custom = ConfiguredModel.customModelCredentials(env)
            if (!custom.some((c) => c.name === "CUSTOM_ONE")) return false
            if (!ConfiguredModel.modelCredentialEnvName("CUSTOM_ONE").startsWith(ConfiguredModel.MODEL_CREDENTIAL_ENV_PREFIX)) {
              return false
            }

            const seats = ConfiguredModel.modelSeatsOf(host)
            if (seats.length === 0) return false
            const kind = ConfiguredModel.modelKindOf(proto)
            const defCall = ConfiguredModel.modelCallDefault(kind)
            if (defCall.kind !== kind) return false

            const sampleOut: ConfiguredModel.ModelCallOutput = kind === "generation"
              ? { kind: "generation", text: `reply ${secret}` }
              : { kind: "decision", answers: { ok: { type: "boolean", value: true, probability: 0.9 } } }
            const sample = ConfiguredModel.modelCallSample(sampleOut, secret)
            if (secret.length >= 6 && sample.includes(secret)) return false

            const binding: ConfiguredModel.ModelBinding = {
              protocol: proto,
              modelId: proto === "evaluation" ? "typesafe-ai/jev" : "gpt-5.4",
              baseUrl: origin,
              credential: "OPENAI_API_KEY"
            }
            const endpointRes = ConfiguredModel.resolveModelEndpoint(binding, listings)
            if (origin.startsWith("ftp:") && endpointRes.ok) return false
            const planned = ConfiguredModel.planModelBinding(binding, listings)
            if (typeof planned.ok !== "boolean") return false

            const failObj: ConfiguredModel.ModelTestFailure = { code: "refused", status: 401 }
            const fault = ConfiguredModel.modelFailureFault(failObj, host)
            if (typeof fault !== "string") return false
            const refCode = ConfiguredModel.modelFailureRefusalCode(failObj)
            if (typeof refCode !== "string") return false
            const failed = ConfiguredModel.failedModelTest(failObj, 42, host)
            if (failed.ok) return false
            if (ConfiguredModel.modelTestStateOf(undefined, true) !== "running") return false
            if (ConfiguredModel.modelTestStateOf(undefined, false) !== "idle") return false
            if (ConfiguredModel.modelTestFixOf(false, failed) !== "edit") return false
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("SubagentCard rendering, clipping, diffCounts, activity & header helpers obey bounds and totality invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Literals(["running", "waiting", "queued", "parked", "done", "failed", "cancelled"]),
        now: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
        width: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 8, maximum: 120 }))),
        added: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
        removed: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
        open: Schema.Boolean,
        tool: Schema.Literals(["read", "edit", "bash", "grep", "unknown_tool"]),
        text: Schema.String.pipe(Schema.check(Schema.isMaxLength(60)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ status, now, width, added, removed, open, tool, text }) =>
          Effect.sync(() => {
            if (!SubagentCard.frames.includes(SubagentCard.spinner(now) as never)) return false
            const g = SubagentCard.glyph(status, now)
            if (g.glyph.length === 0) return false
            const out = SubagentCard.outcome(status)
            if (status === "running" && out !== "working") return false
            if (status === "done" && out !== "done") return false

            const v = SubagentCard.verb(tool)
            if (v.pending.length === 0 || v.done.length === 0) return false
            const clipped = SubagentCard.clip(text, width)
            if (typeof clipped !== "string") return false
            const dc = SubagentCard.diffCounts(`--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n+new2\n`)
            if (dc.added !== 2 || dc.removed !== 1) return false
            SubagentCard.counts(added, removed)
            SubagentCard.duration(now)

            const entries: ReadonlyArray<SubagentCard.Entry> = [
              { kind: "tool", tool, state: "done", target: text || "src/a.ts", added, removed },
              { kind: "tool", tool: "bash", state: "pending", target: "pnpm test" },
              { kind: "text", text: text || "thinking" }
            ]
            const act = SubagentCard.activity(entries)
            for (const row of act.rows) {
              const ln = SubagentCard.line(row, width)
              if (ln.length === 0) return false
            }
            const filesView = SubagentCard.files([{ path: "src/a.ts", added, removed }], open)
            if (filesView === undefined) return false

            const sub: SubagentCard.Subagent = {
              title: text || "Worker",
              status,
              model: "sol",
              startedAt: 1000,
              ...(status === "running" ? {} : { endedAt: 1000 + now }),
              entries,
              files: [{ path: "src/a.ts", added, removed }]
            }
            const c = SubagentCard.card(sub, 1000 + now, { open })
            if (c.title.length === 0) return false
            const hdr = SubagentCard.header([status], 1000 + now)
            if (SubagentCard.headerLine(hdr).length === 0) return false
            SubagentCard.earlierBatches([sub, sub], open)
            SubagentCard.earlierLine(2)
            SubagentCard.finished(sub.title, status === "done" || status === "failed" || status === "cancelled" ? status : "done", "1s")
            SubagentCard.toast(sub, 1000 + now)
            return true
          }),
        { seed: seed + 4, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("FileRead, FileList, DocsPages, GatewayWorkspace, UiInstruction, WorkerControls & StackIssues/StackView obey total invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        arg1: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24))),
        arg2: Schema.Literals(["", "src/index.ts", "dir/sub dir/file.ts", "1..20"]),
        slug: Schema.Literals(["overview", "flows", "missing-page"]),
        wsId: Schema.Literals(["ws_0123456789abcdef", "0123456789abcdef", "bad id!", ""]),
        workerStatus: Schema.Literals(["running", "waiting", "queued", "parked", "done", "failed", "cancelled"]),
        workerAction: Schema.Literals(["stop", "steer", "pause", "resume"]),
        ms: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 200_000_000 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ arg1, arg2, slug, wsId, workerStatus, workerAction, ms }) =>
          Effect.sync(() => {
            const cleanArg1 = arg1.replace(/[\r\n\0"\\]/g, "a").trim() || "repo"
            const formatted = FileRead.fileArgs(cleanArg1, arg2 || undefined)
            const parsed = FileRead.parseFileArgs(formatted)
            if (typeof parsed !== "object" || parsed === null) return false
            FileRead.parseFileReadArgs(formatted)
            const fCard = FileRead.fileReadCard(
              { repo: "owner/repo", path: "src/a.ts", content: "line1\nline2", binary: false },
              1000,
              1
            )
            if (!fCard.value.includes("src/a.ts")) return false

            FileList.parseFileListArgs(formatted)
            const entries: ReadonlyArray<FileList.FileListEntry> = [
              { name: "z.ts", kind: "file" },
              { name: "a-dir", kind: "dir" },
              { name: "b.ts", kind: "file" }
            ]
            const sorted = FileList.sortEntries(entries)
            if (sorted[0]!.kind !== "dir") return false
            FileList.listingValue("owner/repo", "", sorted)
            FileList.fileListCard({ repo: "owner/repo", path: "", entries: sorted }, 1000, 1)

            const pages: ReadonlyArray<DocsPages.DocsPage> = [
              { slug: "overview", title: "Overview", summary: "Intro", markdown: "# Intro" },
              { slug: "flows", title: "Flows", summary: "Durable flows", markdown: "# Flows" }
            ]
            DocsPages.parseDocsArgs(slug)
            const found = DocsPages.readDocsPage(pages, slug)
            if (slug === "missing-page" && "value" in found) return false
            if (slug !== "missing-page" && !("value" in found)) return false
            if ("value" in found) {
              DocsPages.docsCard(pages, slug, 1000, 1)
            } else {
              DocsPages.unknownDocsPage(pages, slug)
            }

            GatewayWorkspace.isGatewayWorkspaceId(wsId)
            GatewayWorkspace.GatewayCardWorkspaceIdSchema.safeParse(wsId)
            UiInstruction.isUiInstructionCommand(arg1)
            UiInstruction.isFormInstructionCommand(arg1)
            WorkerControls.live(workerStatus)
            WorkerControls.allowed(workerAction as never, { status: workerStatus, canSteer: true } as never)

            if (StackIssues.spanLabel(ms).length === 0) return false
            const accLbl = StackView.accountLabel({ id: "u1", login: "will", name: "Will" } as never)
            if (accLbl.length === 0) return false
            return true
          }),
        { seed: seed + 5, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
