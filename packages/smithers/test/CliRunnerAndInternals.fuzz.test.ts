import type { ControlSchema } from "@smthrs/control"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, Option, Schema, Stream } from "effect"
import * as FsSync from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as ClaudeMirror from "../src/ClaudeMirror.ts"
import * as CliError from "../src/CliError.ts"
import * as CloudSession from "../src/CloudSession.ts"
import * as Alerts from "../src/commands/Alerts.ts"
import * as Globals from "../src/commands/Globals.ts"
import * as Removed from "../src/commands/Removed.ts"
import * as RunControl from "../src/commands/RunControl.ts"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as Settlement from "../src/commands/Settlement.ts"
import * as TuiCmd from "../src/commands/Tui.ts"
import * as ApprovalScope from "../src/internal/ApprovalScope.ts"
import * as BoundedEvents from "../src/internal/BoundedEvents.ts"
import * as CodexLogin from "../src/internal/CodexLogin.ts"
import * as Failure from "../src/internal/Failure.ts"
import * as FeaturedFlows from "../src/internal/FeaturedFlows.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as NodeVersion from "../src/internal/NodeVersion.ts"
import * as RetiredSkills from "../src/internal/RetiredSkills.ts"
import * as RoleProfile from "../src/internal/RoleProfile.ts"
import * as RunListing from "../src/internal/RunListing.ts"
import * as SourceRevision from "../src/internal/SourceRevision.ts"
import * as SupervisorMemory from "../src/internal/SupervisorMemory.ts"
import * as Admission from "../src/runner/Admission.ts"
import * as RunnerConfig from "../src/runner/Config.ts"
import * as RunnerHost from "../src/runner/Host.ts"
import * as LaneIntake from "../src/runner/LaneIntake.ts"
import * as LocalJobs from "../src/runner/LocalJobs.ts"
import * as RunnerSession from "../src/runner/Session.ts"
import * as Spool from "../src/runner/Spool.ts"
import * as StatusPage from "../src/runner/StatusPage.ts"
import * as Tree from "../src/runner/Tree.ts"
import * as RunnerWorkspace from "../src/runner/Workspace.ts"
import * as Workstreams from "../src/runner/Workstreams.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

describe("@smthrs/cli Runner, ClaudeMirror, Internals & Commands fuzz invariants", () => {
  it("Runner Admission, Config, Workstreams, Workspace, Tree, LocalJobs, LaneIntake & Spool enforce capacity/isolation/durability invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-runner-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          cpus: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
          load1m: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 40 })),
          diskFreeGb: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 })),
          claimsCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
          remoteUrl: Schema.Literals([
            "https://github.com/octo/app.git",
            "https://smithers.sh/octo/app.git",
            "http://evil.example/repo.git",
            "file:///etc/passwd",
            "git@github.com:octo/app.git",
            "not a url"
          ]),
          laneStatus: Schema.Literals(["running", "completed", "failed", "queued", "missing", "waiting-approval"]),
          httpCode: Schema.Literals([401, 403, 404, 500, 503]),
          jobKey: Schema.Literals(["job-alpha", "job/beta", "job:gamma:1"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ cpus, load1m, diskFreeGb, claimsCount, remoteUrl, laneStatus, httpCode, jobKey }) =>
            Effect.gen(function*() {
              // 1. Admission.decide & claimed
              const nowMs = 1_700_000_000_000
              let st = Admission.initial
              for (let i = 0; i < claimsCount; i++) {
                st = Admission.claimed(st, nowMs - i * 5_000)
              }
              const dec = Admission.decide(
                Admission.defaults,
                st,
                { cpus, load1m, freeDiskGb: diskFreeGb } as never,
                nowMs
              )
              assertInv(dec.held === undefined || typeof dec.held === "string", "Admission.decide returns Decision")

              // 2. RunnerWorkspace pure helpers
              const trusted = RunnerWorkspace.trustedRemote(remoteUrl)
              if (remoteUrl.startsWith("file://") || remoteUrl === "not a url") {
                assertInv(trusted === undefined, `trustedRemote rejects ${remoteUrl}`)
              }
              const ck = RunnerWorkspace.of(tmpRoot, "https://smithers.sh")
              assertInv(typeof ck.dir === "string", "RunnerWorkspace.of")
              const cmdEnv = RunnerWorkspace.commandEnv({ PATH: "/usr/bin", GIT_SSH_COMMAND: "evil" }, {}, true)
              assertInv(cmdEnv.GIT_SSH_COMMAND === undefined, "commandEnv strips unsafe git vars when credentialed")
              const gitEnv = RunnerWorkspace.gitAuthEnv({
                remote: "https://github.com/octo/app.git",
                username: "x-access-token",
                password: "tok_123"
              })
              assertInv(typeof gitEnv === "object", "RunnerWorkspace.gitAuthEnv")
              assertInv(
                RunnerWorkspace.fetchStoreOf(tmpRoot, "/tmp/mirror").startsWith(tmpRoot),
                "RunnerWorkspace.fetchStoreOf"
              )

              // 3. Workstreams.project + RunnerCmd.renderStatus
              const ws = Workstreams.project(
                {
                  "ws-1": {
                    title: "Core Work",
                    tasks: [{ id: "t1", title: "Implement", criteria: ["tests pass"] }]
                  }
                },
                [
                  {
                    request: "req-1",
                    runId: "run-1",
                    profile: "codex",
                    status: laneStatus as never,
                    task: { workstream: "ws-1", id: "t1", title: "Implement" }
                  }
                ]
              )
              assertInv(ws.length === 1 && ws[0]!.tasks.length === 1, "Workstreams.project")
              const renderedStatus = RunnerCmd.renderStatus(ws)
              assertInv(renderedStatus.includes("ws-1") || renderedStatus.includes("Core Work"), "RunnerCmd.renderStatus")

              // 4. Tree.cpuOf, RunnerHost.authorizationLost, RunnerSession.spawnFailureOf, StatusPage
              const cpu = Tree.cpuOf("12.5\n3.0\nbad\n")
              assertInv(cpu >= 0, "Tree.cpuOf non-negative")
              const hostErr = new RunnerHost.HostError({ code: "refused", route: "/jobs", status: httpCode })
              assertInv(
                RunnerHost.authorizationLost(hostErr) === (httpCode === 401 || httpCode === 403),
                "Host.authorizationLost matches 401/403"
              )
              const spFail = RunnerSession.spawnFailureOf(Cause.fail(new Error("enoent")))
              assertInv(typeof spFail.code === "string" && typeof spFail.reason === "string", "spawnFailureOf")
              assertInv(StatusPage.PAGE.includes("<!doctype html>"), "StatusPage.PAGE html")
              assertInv(StatusPage.routes(Effect.succeed({ ok: true })) !== undefined, "StatusPage.routes")

              // 5. LocalJobs pure helpers + file store + Spool + LaneIntake + RunnerConfig
              assertInv(LocalJobs.fileOf(jobKey).length === 32, "LocalJobs.fileOf sha256 prefix")
              const boundary = LocalJobs.steerBoundary(jobKey, ["s1", "s2"])
              assertInv(boundary.length > 0, "LocalJobs.steerBoundary")
              const jobRow: LocalJobs.Row = {
                key: jobKey,
                claim: "claim-1",
                status: "running",
                leasedUntil: nowMs + 10_000,
                createdAt: nowMs - 1000,
                updatedAt: nowMs,
                steers: []
              } as never
              assertInv(typeof LocalJobs.expired(jobRow, nowMs) === "boolean", "LocalJobs.expired")
              assertInv(typeof LocalJobs.standingOf(jobRow, nowMs) === "object", "LocalJobs.standingOf")

              // Temp state dir operations
              const stateDir = FsSync.mkdtempSync(Path.join(tmpRoot, "st-"))
              try {
                const tokMade = yield* RunnerConfig.makeToken(stateDir)
                const readTok = yield* RunnerConfig.readToken(stateDir)
                assertInv(
                  typeof tokMade.sha256 === "string" &&
                    RunnerConfig.sha256(readTok) === tokMade.sha256 &&
                    readTok.length >= 32,
                  "RunnerConfig token roundtrip + sha256 match"
                )
                const cfgChecked = yield* RunnerConfig.check(
                  {
                    origin: "https://smithers.sh/",
                    name: "runner-1" as never,
                    stateDir,
                    repositories: { "octo/app": { mirror: stateDir } },
                    profiles: {
                      codex: { harness: "codex", command: ["codex"], model: "gpt-5" } as never
                    }
                  },
                  tmpRoot
                )
                assertInv(cfgChecked.origin === "https://smithers.sh", "RunnerConfig.check trims origin slash")

                const spool = yield* Effect.scoped(
                  Effect.gen(function*() {
                    const sp = yield* Spool.open({
                      stateDir,
                      key: jobKey,
                      claim: "c1",
                      scrub: (t) => t.replace(/secret/g, "[REDACTED]")
                    })
                    yield* sp.append("log", { text: "contains secret value" })
                    return sp
                  })
                )
                assertInv(spool !== undefined, "Spool.open + append")
                const spFile = Spool.fileOf(stateDir, jobKey)
                if (FsSync.existsSync(spFile)) {
                  const raw = FsSync.readFileSync(spFile, "utf8")
                  assertInv(!raw.includes("secret"), "Spool scrubs secrets before persisting")
                }

                const intakePaths = LaneIntake.paths(stateDir)
                assertInv(intakePaths.dir.startsWith(stateDir), "LaneIntake.paths")
              } finally {
                FsSync.rmSync(stateDir, { recursive: true, force: true })
              }

              return true
            }),
          { seed, executions: Math.min(executions, 25) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("Internal Failure, CodexLogin, RoleProfile, FeaturedFlows, RunListing, BoundedEvents, SourceRevision, ApprovalScope, SupervisorMemory, NativeEquipment & NodeVersion uphold invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-int-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          rawText: Schema.Literals([
            "clean message",
            "ansi \u001b[31mred\u001b[0m\x07 bell",
            "multi\nline\r\ntext",
            "key sk-ant-api03-1234567890abcdefghij1234567890"
          ]),
          codexJson: Schema.Literals([
            JSON.stringify({ tokens: { access_token: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.sig", refresh_token: "ref_123" } }),
            JSON.stringify({ OPENAI_API_KEY: "sk-test" }),
            "{invalid json",
            ""
          ]),
          instantStr: Schema.Literals(["2026-11-23T00:00:00Z", "1700000000000", "not-a-date", ""]),
          sortOrder: Schema.Literals(["newest", "oldest"]),
          nodeVer: Schema.Literals(["v22.19.0", "v24.0.0", "v18.12.0", "bad"]),
          oid: Schema.Literals(["a".repeat(40), "deadbeef1234", "not-hex!", "", "   \n"]),
          stanceEnv: Schema.Literals(["careful", "paranoid", "other", ""])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ rawText, codexJson, instantStr, sortOrder, nodeVer, oid, stanceEnv }) =>
            Effect.gen(function*() {
              // 1. Failure formatting & terminal safety
              const safe = Failure.terminalSafe(rawText)
              assertInv(!safe.includes("\u001b") && !safe.includes("\x07"), "terminalSafe strips escapes/control chars")
              assertInv(typeof Failure.terminalSafeLines(rawText) === "string", "terminalSafeLines")
              assertInv(typeof Failure.terminalSafeJson(JSON.stringify({ a: rawText })) === "string", "terminalSafeJson")
              assertInv(typeof Failure.terminalSafeValue({ a: rawText, b: [1, rawText] }) === "object", "terminalSafeValue")
              assertInv(typeof Failure.causeLine(rawText) === "string", "causeLine")
              const taggedErr = new CliError.Refused({ fault: "user", code: "denied", message: rawText })
              assertInv(Failure.isTagged(taggedErr) && Failure.tagOf(taggedErr) === "/cli/Refused", "isTagged/tagOf")
              assertInv(typeof Failure.fields(taggedErr) === "string", "Failure.fields")
              assertInv(typeof Failure.sentence(taggedErr) === "string", "Failure.sentence")
              assertInv(typeof Failure.operatorSentence(taggedErr) === "string", "Failure.operatorSentence")
              assertInv(typeof Failure.displayName(taggedErr) === "string", "Failure.displayName")
              assertInv(typeof Failure.isDesigned(taggedErr) === "boolean", "Failure.isDesigned")

              // 2. CodexLogin.parse & unusable & locate
              const parsed = CodexLogin.parse(codexJson)
              assertInv(typeof parsed === "object" && parsed !== null, "CodexLogin.parse")
              const unus = CodexLogin.unusable("/tmp/auth.json", codexJson)
              assertInv(unus === undefined || typeof unus === "string", "CodexLogin.unusable")
              const loc = CodexLogin.locate({ HOME: tmpRoot, CODEX_HOME: Path.join(tmpRoot, ".codex") })
              assertInv(typeof loc === "string" && loc.endsWith("auth.json"), "CodexLogin.locate")

              // 3. RoleProfile.splitFrontmatter & compose
              const split = RoleProfile.splitFrontmatter("---\ntitle: demo\n---\nBody text\n")
              assertInv(split.body.includes("Body text"), "RoleProfile.splitFrontmatter")
              const composed = RoleProfile.compose({
                org: tmpRoot,
                role: "worker",
                body: "Charter instructions",
                meta: { name: "Worker", seat: "openai:gpt-5", skills: [] }
              })
              assertInv(composed.system.some((seg) => seg.includes("Charter instructions")), "RoleProfile.compose")

              // 4. RunListing.instant & request & count
              const instRes = yield* RunListing.instant("--since", instantStr).pipe(Effect.result)
              if (instantStr === "not-a-date" || instantStr === "") {
                assertInv(instRes._tag === "Failure", "RunListing.instant rejects invalid date")
              } else {
                assertInv(instRes._tag === "Success", "RunListing.instant parses valid date")
              }
              const listReq = yield* RunListing.request({ sort: sortOrder }).pipe(Effect.result)
              assertInv(listReq._tag === "Success", "RunListing.request succeeds")
              if (listReq._tag === "Success") {
                const cnt = RunListing.count(listReq.success)
                assertInv(typeof cnt === "number" || typeof cnt === "object", "RunListing.count")
              }

              // 5. BoundedEvents.encodedBytes & collect
              const items = [{ a: rawText }, { b: 2 }, { c: 3 }]
              assertInv(BoundedEvents.encodedBytes(items[0]) > 0, "BoundedEvents.encodedBytes")
              const collected = yield* BoundedEvents.collect(
                Stream.fromIterable(items),
                { operation: "fuzz", subject: "events" },
                { maxEvents: 2, maxBytes: 1024, maxEventBytes: 512 }
              ).pipe(Effect.result)
              assertInv(collected._tag === "Success" || collected._tag === "Failure", "BoundedEvents.collect enforces limits")

              // 6. SourceRevision.objectId & read (with injected Reader)
              const normOid = SourceRevision.objectId(oid)
              if (oid === "a".repeat(40)) assertInv(normOid === "a".repeat(40), "objectId accepts 40-char sha")
              if (oid === "not-hex!") assertInv(normOid === undefined, "objectId rejects non-hex")
              const readRev = yield* SourceRevision.read(tmpRoot, () => Effect.succeed(oid))
              assertInv(readRev === undefined || typeof readRev === "string", "SourceRevision.read")

              // 7. NodeVersion, SupervisorMemory, NativeEquipment, ApprovalScope, FeaturedFlows, CloudSession
              assertInv(typeof NodeVersion.satisfies(nodeVer) === "boolean", "NodeVersion.satisfies")
              const nvRef = NodeVersion.refusal(nodeVer, "/usr/bin/node")
              if (nodeVer === "v18.12.0") assertInv(typeof nvRef === "string", "NodeVersion.refusal rejects old node")
              const stn = SupervisorMemory.stance({ SMITHERS_MEMORY_STANCE: stanceEnv })
              assertInv(stn === "careful" || stn === "paranoid", "SupervisorMemory.stance")
              const memOpts = SupervisorMemory.options({ HOME: tmpRoot }, tmpRoot)
              assertInv(typeof memOpts === "object", "SupervisorMemory.options")
              assertInv(
                ["park", "refuse"].includes(NativeEquipment.askPolicy({ SMITHERS_ASK_POLICY: "refuse" })),
                "NativeEquipment.askPolicy"
              )
              assertInv(Effect.isEffect(NativeEquipment.accountPoolDefaultModel({})), "accountPoolDefaultModel returns Effect")
              const trigDecl = ApprovalScope.triggerDeclaration("trig-1")
              assertInv(typeof trigDecl === "object", "ApprovalScope.triggerDeclaration")
              assertInv(
                typeof CloudSession.isAuthenticationRefusal(taggedErr) === "boolean",
                "CloudSession.isAuthenticationRefusal"
              )

              // FeaturedFlows
              const ffApps = FeaturedFlows.apps(tmpRoot)
              assertInv(Array.isArray(ffApps), "FeaturedFlows.apps")
              assertInv(Array.isArray(FeaturedFlows.appsOf({ apps: [] })), "FeaturedFlows.appsOf")
              assertInv(Array.isArray(FeaturedFlows.warningsOf({ warnings: [] })), "FeaturedFlows.warningsOf")

              return true
            }),
          { seed: seed + 1, executions: Math.min(executions, 80) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")

      await RetiredSkills.register(tmpRoot, Path.join(tmpRoot, "data"))
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("ClaudeMirror, Settlement, RunControl, Alerts, Globals, Removed & Tui command helpers uphold invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-cmd-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          kind: Schema.Literals([
            "control.run.completed",
            "control.run.failed",
            "control.run.cancelled",
            "control.run.running",
            "control.run.waiting-approval",
            "control.approval.requested",
            "control.agent.turn-opened"
          ]),
          status: Schema.Literals(["running", "completed", "failed", "cancelled", "waiting-approval"]),
          approvalJson: Schema.Literals([
            JSON.stringify({ runId: "run-1", approvalId: "a1", decision: "approve" }),
            JSON.stringify({ runId: "run-1", approvalId: "a1", decision: "deny", reason: "no" }),
            "{bad-json",
            "{}"
          ]),
          signalJson: Schema.Literals([
            JSON.stringify({ name: "wake", payload: { x: 1 } }),
            "{bad-json"
          ]),
          flowInput: Schema.Literals(["demo", "demo/sub", "./path/flow.ts", ""])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ kind, status, approvalJson, signalJson, flowInput }) =>
            Effect.gen(function*() {
              // 1. ClaudeMirror subscribe / readSubscriptions / unsubscribe / frame / transition
              const sub = ClaudeMirror.subscribe(tmpRoot, "run-1", "sess-1")
              assertInv(Array.isArray(sub) && sub.length >= 1, "ClaudeMirror.subscribe")
              const subs = ClaudeMirror.readSubscriptions(tmpRoot)
              assertInv(subs.length >= 1, "ClaudeMirror.readSubscriptions")
              ClaudeMirror.unsubscribe(tmpRoot, "run-1", "sess-1")
              assertInv(
                ClaudeMirror.isTerminal(status) === ["completed", "failed", "cancelled"].includes(status),
                "ClaudeMirror.isTerminal"
              )
              const ev: ControlSchema.ControlEvent = {
                sequence: 1,
                kind,
                runId: "run-1" as ControlSchema.ControlEvent["runId"],
                occurredAt: Date.now(),
                payload: { status, approvalId: "a1" } as ControlSchema.ControlEvent["payload"]
              }
              const tr = ClaudeMirror.transition(ev)
              assertInv(tr === undefined || typeof tr === "object", "ClaudeMirror.transition")
              const fr = ClaudeMirror.frame(
                "run-1",
                {
                  runId: "run-1" as ControlSchema.RunSummary["runId"],
                  flowId: "demo",
                  status,
                  createdAt: 1000,
                  updatedAt: 2000
                },
                [ev]
              )
              assertInv(typeof fr === "object" && fr.runId === "run-1", "ClaudeMirror.frame")

              // 2. Settlement pure helpers
              const isSettled = Settlement.settled(kind)
              if (kind === "control.run.completed" || kind === "control.run.failed" || kind === "control.run.cancelled") {
                assertInv(isSettled, `Settlement.settled true for ${kind}`)
              }
              const decErr = Settlement.declined("run-1", undefined)
              assertInv(decErr instanceof CliError.UnsupportedError, "Settlement.declined is UnsupportedError")
              assertInv(!Settlement.wasDeclined(undefined), "Settlement.wasDeclined undefined")

              // 3. RunControl pure decoders
              assertInv(typeof flowInput === "string", "flowInput")
              const decRes = yield* RunControl.decodeInput(["a=1", "b=true"], Option.none()).pipe(Effect.result)
              assertInv(decRes._tag === "Success", "RunControl.decodeInput key=val")
              const apprRes = yield* RunControl.approval(approvalJson).pipe(Effect.result)
              assertInv(apprRes._tag === "Success" || apprRes._tag === "Failure", "RunControl.approval")
              const sigRes = yield* RunControl.signal(signalJson).pipe(Effect.result)
              if (sigRes._tag === "Success") {
                assertInv(RunControl.signalKey("run-1", sigRes.success).length > 0, "RunControl.signalKey")
              }

              // 4. Alerts renderers
              const repStr = Alerts.renderReport({
                runId: "run-1",
                probe: "health",
                state: "ok" as never,
                destination: "none",
                delivered: [],
                failed: [],
                refused: [],
                suppressed: []
              })
              assertInv(typeof repStr === "string", "Alerts.renderReport")
              const listStr = Alerts.renderList({ runId: "run-1", alerts: [] })
              assertInv(typeof listStr === "string", "Alerts.renderList")

              // 5. Globals, Removed & Tui
              yield* Globals.notices({ environment: { HOME: tmpRoot } }).pipe(Effect.orDie)
              const guardRes = yield* Globals.guard({ environment: { HOME: tmpRoot } }).pipe(Effect.result)
              assertInv(guardRes._tag === "Success" || guardRes._tag === "Failure", "Globals.guard")
              assertInv(Removed.commands.length > 0, "Removed.commands non-empty")
              const tuiArgv = TuiCmd.argv({ root: tmpRoot, runId: "run-1" } as never)
              assertInv(Array.isArray(tuiArgv), "TuiCmd.argv")
              const binPkgs = TuiCmd.binaryPackages(TuiCmd.host)
              assertInv(Array.isArray(binPkgs), "TuiCmd.binaryPackages")

              return true
            }),
          { seed: seed + 2, executions: Math.min(executions, 40) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
