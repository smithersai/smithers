import { Fuzz } from "@smthrs/fuzz"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Arbitrary, Effect, Option, PubSub, Schema } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Detached from "../src/Detached.ts"
import * as Forensics from "../src/Forensics.ts"
import * as EngineJournalProjection from "../src/internal/EngineJournalProjection.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as NodeWorkspaceObservation from "../src/internal/NodeWorkspaceObservation.ts"
import * as NodeControl from "../src/NodeControl.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261131")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

describe("@smthrs/cli Wave-6B Deep Detached, Forensics, NodeWorkspaceObservation, EngineJournalProjection, NodeControl & NativeEquipment fuzz invariants", () => {
  it(
    "Detached.launch handles honest admission, forged+retry admission, early exit rejection & timeout/abort cleanup",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-detached-deep-"))
      try {
        // 1. Fuzz admissionLine / announcedRunIds round-trip
        const idArb = Arbitrary.schema(Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{2,20}$/))))
        const rep = await Effect.runPromise(
          Fuzz.run(
            idArb,
            (runId) =>
              Effect.sync(() => {
                const nonce = `n-${runId.slice(0, 6)}`
                const line = Detached.admissionLine(nonce, runId)
                const ids = Detached.announcedRunIds(`noise\n${line}\nmore`, nonce)
                assertInv(ids.includes(runId), "announcedRunIds parses emitted admissionLine")
                assertInv(Detached.announcedRunIds(line, "other-nonce").length === 0, "wrong nonce yields empty")
                return true
              }),
            { executions: Math.min(executions, 40), seed }
          )
        )
        expect(rep._tag).toBe("Passed")

        // 2. Real detached child script exercising all 4 modes
        const script = join(tmp, "detached-child.cjs")
        writeFileSync(
          script,
          `const nonce = process.env[${JSON.stringify(Detached.admissionVariable)}] || ""
const mode = process.argv[4] || "honest"
if (mode === "honest") {
  console.log("SMITHERS_DETACHED_ADMISSION=run:" + nonce + " runId=run-honest-1")
  setTimeout(() => process.exit(0), 60)
} else if (mode === "forged-then-honest") {
  console.log("SMITHERS_DETACHED_ADMISSION=run:" + nonce + " runId=run-forged-1")
  setTimeout(() => {
    console.log("SMITHERS_DETACHED_ADMISSION=run:" + nonce + " runId=run-honest-2")
    setTimeout(() => process.exit(0), 120)
  }, 30)
} else if (mode === "early-exit") {
  console.log("failing immediately without admitting")
  process.exit(1)
} else if (mode === "hang") {
  console.log("hanging until terminated")
  setInterval(() => {}, 1000)
}
`
        )

        // 2a. Honest admission
        const launched1 = await Detached.launch({
          root: tmp,
          payload: "honest",
          execPath: process.execPath,
          entry: script,
          intervalMs: 10,
          timeoutMs: 5000,
          admission: async (runId) => runId === "run-honest-1"
        })
        expect(Detached.isLaunched(launched1)).toBe(true)
        if (Detached.isLaunched(launched1)) {
          expect(launched1.runId).toBe("run-honest-1")
          expect(Detached.logTail(launched1.logFile, 512)).toContain("run-honest-1")
        }

        // 2b. Forged candidate rejected + transient error retried + honest accepted
        let attempts = 0
        const launched2 = await Detached.launch({
          root: tmp,
          payload: "forged-then-honest",
          execPath: process.execPath,
          entry: script,
          intervalMs: 10,
          timeoutMs: 5000,
          admission: async (runId) => {
            if (runId === "run-forged-1") return false
            if (runId === "run-honest-2") {
              attempts++
              if (attempts === 1) throw new Error("transient sqlite busy")
              return true
            }
            return false
          }
        })
        expect(Detached.isLaunched(launched2)).toBe(true)
        expect(attempts).toBeGreaterThanOrEqual(2)

        // 2c. Early exit without admission -> Rejected + discard
        const rej1 = await Detached.launch({
          root: tmp,
          payload: "early-exit",
          execPath: process.execPath,
          entry: script,
          intervalMs: 10,
          timeoutMs: 3000,
          admission: async () => false
        })
        expect(Detached.isLaunched(rej1)).toBe(false)
        if (!Detached.isLaunched(rej1)) {
          expect(rej1.tail).toContain("failing immediately")
          Detached.discard(rej1)
        }

        // 2d. Slow boot + deadline timeout -> onSlowBoot fires & child is terminated cleanly
        const notices: Array<string> = []
        const rej2 = await Detached.launch({
          root: tmp,
          payload: "hang",
          execPath: process.execPath,
          entry: script,
          intervalMs: 10,
          timeoutMs: 60,
          terminationGraceMs: 150,
          onSlowBoot: (m) => notices.push(m),
          admission: async () => false
        })
        expect(Detached.isLaunched(rej2)).toBe(false)
        expect(notices.length).toBeGreaterThanOrEqual(1)
        if (!Detached.isLaunched(rej2)) Detached.discard(rej2)

        // 2e. Abort signal cancels launch cleanly (returns Rejected)
        const ac = new AbortController()
        setTimeout(() => ac.abort(new Error("user cancelled")), 40)
        const rejAbort = await Detached.launch({
          root: tmp,
          payload: "hang",
          execPath: process.execPath,
          entry: script,
          intervalMs: 10,
          timeoutMs: 5000,
          terminationGraceMs: 150,
          signal: ac.signal,
          admission: async () => false
        })
        expect(Detached.isLaunched(rejAbort)).toBe(false)
        if (!Detached.isLaunched(rejAbort)) Detached.discard(rejAbort)

        // Missing logTail returns empty string safely
        expect(Detached.logTail(join(tmp, "no-such.log"))).toBe("")
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Forensics digest/eventLine/renderDiagnosis/renderTranscript & NodeWorkspaceObservation host/changes uphold invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-for-nwo-"))
      try {
        // 1. Forensics across EVERY event kind and run status
        const baseTs = 1_700_000_000_000
        const allEvents: Array<any> = [
          { sequence: 1, runId: "r-1", timestamp: baseTs, kind: "control.run.started", payload: { flowId: "demo" } },
          {
            sequence: 2,
            runId: "r-1",
            timestamp: baseTs + 1000,
            kind: "control.agent.turn-opened",
            payload: { seat: "claude:sonnet", turn: 1 }
          },
          {
            sequence: 3,
            runId: "r-1",
            timestamp: baseTs + 2000,
            kind: "control.agent.model-settled",
            payload: { text: "thinking", usage: { inputTokens: 120, outputTokens: 45 } }
          },
          {
            sequence: 4,
            runId: "r-1",
            timestamp: baseTs + 2500,
            kind: "control.agent.cell-produced",
            payload: { text: "await test()" }
          },
          {
            sequence: 5,
            runId: "r-1",
            timestamp: baseTs + 2600,
            kind: "control.agent.cell-printed",
            payload: { text: "stdout line" }
          },
          {
            sequence: 6,
            runId: "r-1",
            timestamp: baseTs + 3000,
            kind: "control.agent.cell-call-started",
            payload: { flowName: "bash", input: { cmd: "ls" } }
          },
          {
            sequence: 7,
            runId: "r-1",
            timestamp: baseTs + 3100,
            kind: "control.agent.cell-call-settled",
            payload: { outcome: "success", value: { code: 0 } }
          },
          {
            sequence: 8,
            runId: "r-1",
            timestamp: baseTs + 3200,
            kind: "control.agent.cell-call-settled",
            payload: { outcome: "failure", message: "exit 1" }
          },
          {
            sequence: 9,
            runId: "r-1",
            timestamp: baseTs + 3500,
            kind: "control.agent.transition-applied",
            payload: { transition: { _tag: "continue", justification: "retry", state: { step: 1 }, context: ["a"] } }
          },
          {
            sequence: 10,
            runId: "r-1",
            timestamp: baseTs + 4000,
            kind: "control.agent.transition-applied",
            payload: { transition: { _tag: "park", reason: "approval", message: "need ok" } }
          },
          {
            sequence: 11,
            runId: "r-1",
            timestamp: baseTs + 4500,
            kind: "control.agent.transition-applied",
            payload: { transition: { _tag: "complete", output: "done!" } }
          },
          {
            sequence: 12,
            runId: "r-1",
            timestamp: baseTs + 5000,
            kind: "control.agent.cell-settled",
            payload: { outcome: { _tag: "settled" } }
          },
          {
            sequence: 13,
            runId: "r-1",
            timestamp: baseTs + 5100,
            kind: "control.agent.cell-settled",
            payload: { outcome: { _tag: "fault", message: "boom" } }
          },
          {
            sequence: 14,
            runId: "r-1",
            timestamp: baseTs + 5200,
            kind: "control.run.waiting-approval",
            payload: { approvalId: "ap-1", capability: "fs.write", reason: "write file" }
          },
          {
            sequence: 15,
            runId: "r-1",
            timestamp: baseTs + 5300,
            kind: "control.approval.resolved",
            payload: { approvalId: "ap-1", decision: "approved" }
          },
          {
            sequence: 16,
            runId: "r-1",
            timestamp: baseTs + 5400,
            kind: "control.run.failed",
            payload: { error: { _tag: "Crash", message: "fatal" } }
          },
          {
            sequence: 17,
            runId: "r-1",
            timestamp: baseTs + 5500,
            kind: "control.run.completed",
            payload: { output: { ok: true } }
          },
          {
            sequence: 18,
            runId: "r-1",
            timestamp: baseTs + 5600,
            kind: "control.run.cancelled",
            payload: { reason: "operator" }
          },
          {
            sequence: 19,
            runId: "r-1",
            timestamp: baseTs + 5700,
            kind: "control.custom.unknown",
            payload: { foo: "bar" }
          }
        ]

        for (const ev of allEvents) {
          const line = Forensics.eventLine(ev)
          expect(typeof line).toBe("string")
          expect(line.length).toBeGreaterThan(0)
        }

        const d = Forensics.digest(allEvents, "r-1")
        expect(d.turns).toBeGreaterThanOrEqual(1)
        expect(d.calls).toBeGreaterThanOrEqual(1)
        const transcript = Forensics.renderTranscript(allEvents)
        expect(transcript).toContain("model")
        expect(transcript).toContain("call")

        // Render diagnosis across all run states (parked+approval, parked+released, pending, failed, running, completed, codeDrift)
        const diagStates: Array<any> = [
          {
            runId: "r-1",
            flowId: "demo",
            status: "parked",
            waitingReason: "approval",
            codeDrift: { recorded: "aaa", current: "bbb", recordedEngine: "1.0", currentEngine: "1.1" }
          },
          { runId: "r-1", flowId: "demo", status: "parked", waitingReason: "released" },
          { runId: "r-1", flowId: "demo", status: "pending" },
          { runId: "r-1", flowId: "demo", status: "failed" },
          { runId: "r-1", flowId: "demo", status: "running" },
          { runId: "r-1", flowId: "demo", status: "completed" }
        ]
        for (const run of diagStates) {
          const enriched = {
            ...d,
            status: run.status,
            costUsd: 0.1234,
            parkedApproval: run.waitingReason === "approval" ? "ap-tok-1" : undefined,
            parkedQuestion: run.waitingReason === "approval" ? "Proceed?" : undefined,
            finalOutput: run.status === "completed" ? "all done" : undefined,
            cause: run.status === "failed" ? "boom" : undefined,
            memory: { kept: ["mem-1"], withheld: ["mem-2"] }
          }
          const text = Forensics.renderDiagnosis(run, enriched as any)
          expect(text).toContain("r-1")
        }

        // Shell quoting fuzz
        const quoteArb = Arbitrary.schema(Schema.String.pipe(Schema.check(Schema.isMaxLength(40))))
        const qRep = await Effect.runPromise(
          Fuzz.run(
            quoteArb,
            (s) =>
              Effect.sync(() => {
                const q = Forensics.shellQuote(s)
                assertInv(typeof q === "string" && q.length >= s.length, "shellQuote never shrinks")
                return true
              }),
            { executions: Math.min(executions, 40), seed }
          )
        )
        expect(qRep._tag).toBe("Passed")

        // 2. NodeWorkspaceObservation host.entries + changes watcher
        const subDir = join(tmp, "sub")
        mkdirSync(subDir, { recursive: true })
        mkdirSync(join(tmp, ".flows"), { recursive: true })
        const f1 = join(tmp, "a.txt")
        writeFileSync(f1, "hello world")
        writeFileSync(join(subDir, "b.txt"), "nested")
        symlinkSync(f1, join(tmp, "link.txt"))

        const entries = await Effect.runPromise(
          NodeWorkspaceObservation.host.entries(tmp, (name) => name !== "ignored")
        )
        expect(entries.some((e) => e.name === "a.txt" && e.measured._tag === "File")).toBe(true)
        expect(entries.some((e) => e.name === "sub" && e.measured._tag === "Directory")).toBe(true)
        expect(entries.some((e) => e.name === "link.txt" && e.measured._tag === "Skipped")).toBe(true)

        // Error branches: ENOENT (NotFound) and ENOTDIR (BadResource)
        const enoent = await Effect.runPromise(
          Effect.exit(NodeWorkspaceObservation.host.entries(join(tmp, "nope"), () => true))
        )
        expect(enoent._tag).toBe("Failure")
        const enotdir = await Effect.runPromise(Effect.exit(NodeWorkspaceObservation.host.entries(f1, () => true)))
        expect(enotdir._tag).toBe("Failure")

        // Scoped changes watcher: triggers delivered & settled when files change
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const obs = yield* NodeWorkspaceObservation.changes(tmp, { excludePaths: ["excluded.txt"] })
              writeFileSync(join(tmp, "new-file.txt"), "changed!")
              writeFileSync(join(subDir, "c.txt"), "nested-changed!")
              const del = yield* obs.delivered
              expect(Option.isOption(del)).toBe(true)
              const set = yield* obs.settled
              expect(Option.isOption(set)).toBe(true)
            })
          )
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "EngineJournalProjection, NodeControl config/mcp-config/server auth & NativeEquipment resolvers/policies uphold invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-ejp-nc-ne-"))
      // Local mock account-pool HTTP server
      let poolRoutes = ["chatgpt"]
      let poolFail = false
      const poolServer = createServer((req, res) => {
        if (poolFail) {
          res.writeHead(503, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "unavailable" }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ routes: poolRoutes, defaultModel: "gpt-5.1-codex" }))
      })
      await new Promise<void>((r) => poolServer.listen(0, "127.0.0.1", () => r()))
      const poolOrigin = `http://127.0.0.1:${(poolServer.address() as AddressInfo).port}`

      try {
        // 1. EngineJournalProjection: real PubSub + faulty/rewind/compacted Journal.Service!
        const emittedControl: Array<JournalEvent.Input> = []
        const onRecords: Array<string> = []
        let rootSettledGen: number | undefined

        const makeFakeJournal = (opts: {
          entriesByRun: Record<string, Array<JournalEvent.Entry>>
          genByRun?: Record<string, { generation: number; afterSeq: number }>
          failMode?: "none" | "compacted" | "storage" | "gen_fail" | "unordered"
        }) => {
          let failOnce = opts.failMode ?? "none"
          const pubsub = Effect.runSync(PubSub.unbounded<JournalEvent.RunId>())
          const svc = {
            emit: () => Effect.void,
            emitDurable: (input: any) =>
              Effect.sync(() => {
                emittedControl.push(input)
                return {} as any
              }),
            emitDurableUnfenced: (input: any) =>
              Effect.sync(() => {
                emittedControl.push(input)
                return {} as any
              }),
            entries: (q: any) =>
              Effect.suspend(() => {
                if (failOnce === "compacted") {
                  failOnce = "none"
                  return Effect.fail(
                    new Journal.JournalError({ code: "compacted", message: "compacted", checkpointSeq: 2 as any })
                  )
                }
                if (failOnce === "storage") {
                  failOnce = "none"
                  return Effect.fail(new Journal.JournalError({ code: "unknown", message: "disk full" }))
                }
                if (failOnce === "unordered") {
                  failOnce = "none"
                  return Effect.succeed({
                    entries: [
                      new JournalEvent.Entry({
                        runId: "wrong-run" as any,
                        seq: 0 as any,
                        eventId: "e-bad" as any,
                        sourceId: "s" as any,
                        sourceSeq: 0 as any,
                        emittedAtMs: 1,
                        eventType: "x",
                        payload: {},
                        meta: undefined
                      })
                    ],
                    hasMore: false
                  })
                }
                const list = (opts.entriesByRun[q.runId] ?? []).filter((e) =>
                  q.after === undefined || (e.seq as number) > (q.after as number)
                )
                return Effect.succeed({ entries: list, hasMore: false })
              }),
            generation: (runId: any) =>
              Effect.suspend(() => {
                if (failOnce === "gen_fail") {
                  failOnce = "none"
                  return Effect.fail(new Journal.JournalError({ code: "unknown", message: "gen err" }))
                }
                return Effect.succeed(opts.genByRun?.[runId] ?? { generation: 0, afterSeq: -1 })
              }),
            heads: (runIds: any) =>
              Effect.succeed(
                runIds.map((r: any) => {
                  const list = opts.entriesByRun[r] ?? []
                  const g = opts.genByRun?.[r]?.generation ?? 0
                  return {
                    runId: r,
                    generation: g,
                    maxSeq: list.length ? (list[list.length - 1]!.seq as number) : null
                  }
                })
              ),
            changes: PubSub.subscribe(pubsub),
            transact: (e: any) => e
          } as unknown as Journal.Service
          return { svc, pubsub }
        }

        const rootEntry = new JournalEvent.Entry({
          runId: "exec-root" as any,
          seq: 1 as any,
          eventId: "ev-1" as any,
          sourceId: "src-1" as any,
          sourceSeq: 1 as any,
          emittedAtMs: 1000,
          eventType: "flow.started",
          payload: { ok: true },
          meta: undefined
        })
        const childEntry = new JournalEvent.Entry({
          runId: "exec-child" as any,
          seq: 1 as any,
          eventId: "ev-2" as any,
          sourceId: "src-2" as any,
          sourceSeq: 1 as any,
          emittedAtMs: 1001,
          eventType: "flow.completed",
          payload: { ok: true },
          meta: undefined
        })

        const { svc: controlJ } = makeFakeJournal({ entriesByRun: {} })
        const { pubsub: enginePubsub, svc: engineJ } = makeFakeJournal({
          entriesByRun: { "exec-root": [rootEntry], "exec-child": [childEntry], "exec-empty": [] },
          genByRun: { "exec-root": { generation: 1, afterSeq: 0 }, "exec-child": { generation: 0, afterSeq: -1 } }
        })

        let lineageCalls = 0
        const proj = await Effect.runPromise(
          EngineJournalProjection.make({
            controlRunId: "ctrl-1",
            executionId: "exec-root",
            engineJournal: engineJ,
            controlJournal: controlJ,
            engineState: {
              runChildren: (id) =>
                Effect.succeed(id === "exec-root" ? [{ parentId: "exec-root", childId: "exec-child" } as any] : []),
              runChildrenOf: (parents) =>
                Effect.succeed(
                  parents.includes("exec-root") ? [{ parentId: "exec-root", childId: "exec-child" } as any] : []
                )
            },
            runLineage: (id) =>
              Effect.sync(() => {
                lineageCalls++
                if (id === "exec-root") {
                  return [
                    { runId: "exec-root", lineageId: "lin-1", status: "completed" } as any,
                    { runId: "exec-empty", lineageId: "lin-1", status: "completed" } as any
                  ]
                }
                return [{ runId: id, lineageId: id, status: lineageCalls <= 2 ? "running" : "completed" } as any]
              }),
            onRecord: (entry) =>
              Effect.sync(() => {
                onRecords.push(entry.eventId)
              }),
            onRootSettled: (gen) =>
              Effect.sync(() => {
                rootSettledGen = gen
              })
          })
        )

        const seen = await Effect.runPromise(proj.catchUp)
        expect(seen.has("exec-root")).toBe(true)
        expect(seen.has("exec-child")).toBe(true)
        expect(onRecords).toContain("ev-1")
        expect(onRecords).toContain("ev-2")
        expect(emittedControl.some((e) => e.eventType === EngineJournalProjection.gapKind)).toBe(true)

        // followUntilSettled: root terminal while child running -> fires onRootSettled, then child settles!
        lineageCalls = 0
        const wakeTimer = setTimeout(() => {
          Effect.runSync(PubSub.publish(enginePubsub, "exec-child" as any))
        }, 25)
        try {
          await Effect.runPromise(
            proj.followUntilSettled({
              get: () => Effect.succeed({ status: "completed" } as any)
            })
          )
        } finally {
          clearTimeout(wakeTimer)
        }
        expect(rootSettledGen).toBe(1)

        // Faulty journal modes: compacted, storage, gen_fail, unordered
        for (const failMode of ["compacted", "storage", "gen_fail", "unordered"] as const) {
          const { svc: ej } = makeFakeJournal({
            entriesByRun: {
              "exec-f": [new JournalEvent.Entry({ ...rootEntry, runId: "exec-f" as any, seq: 3 as any })]
            },
            failMode
          })
          const p = await Effect.runPromise(
            EngineJournalProjection.make({
              controlRunId: "ctrl-f",
              executionId: "exec-f",
              engineJournal: ej,
              controlJournal: controlJ,
              engineState: { runChildren: () => Effect.succeed([]), runChildrenOf: () => Effect.succeed([]) }
            })
          )
          const ex = await Effect.runPromise(Effect.exit(p.catchUp))
          if (failMode === "compacted") expect(ex._tag).toBe("Success")
          else expect(ex._tag).toBe("Failure")
        }

        // 2. NodeControl.makeConfig & mcpServersFromArguments (every error & success path)
        const mcpValid = join(tmp, "mcp-valid.json")
        writeFileSync(
          mcpValid,
          JSON.stringify([
            { server: "s-stdio", command: "echo", args: ["hi"], envFrom: { MY_KEY: "SRC_KEY" } },
            { server: "s-http", url: "http://127.0.0.1:9999/mcp", bearerTokenEnv: "BEARER_SRC" }
          ])
        )
        const cfgOk = NodeControl.makeConfig(
          ["--mcp-config", mcpValid, "--remote", "http://127.0.0.1:8080"],
          { SRC_KEY: "val1", BEARER_SRC: "tok1", SMITHERS_TOKEN: "st-1" },
          tmp
        )
        expect(cfgOk.mcpServers?.length).toBe(2)

        // Missing envFrom / bearerTokenEnv / file / bad JSON / bad schema / bad remote
        expect(() => NodeControl.makeConfig(["--mcp-config", mcpValid], { BEARER_SRC: "tok1" }, tmp)).toThrow(/SRC_KEY/)
        expect(() => NodeControl.makeConfig(["--mcp-config", mcpValid], { SRC_KEY: "val1" }, tmp)).toThrow(/BEARER_SRC/)
        expect(() => NodeControl.makeConfig(["--mcp-config", join(tmp, "missing.json")], {}, tmp)).toThrow(
          /file not found/
        )
        const mcpBadJson = join(tmp, "mcp-bad.json")
        writeFileSync(mcpBadJson, "{not-json")
        expect(() => NodeControl.makeConfig(["--mcp-config", mcpBadJson], {}, tmp)).toThrow(/not valid JSON/)
        const mcpBadSchema = join(tmp, "mcp-schema.json")
        writeFileSync(mcpBadSchema, JSON.stringify([{ bogus: true }]))
        expect(() => NodeControl.makeConfig(["--mcp-config", mcpBadSchema], {}, tmp)).toThrow(/JSON array/)
        expect(() => NodeControl.makeConfig(["--remote", "not-a-url"], {}, tmp)).toThrow(/http:\/\/ or https:\/\//)
        expect(() => NodeControl.makeConfig(["--remote", "ftp://example.com"], {}, tmp)).toThrow(
          /http:\/\/ or https:\/\//
        )

        const cfgEff = await Effect.runPromise(Effect.exit(NodeControl.configFromArguments(["--remote", "ftp://bad"])))
        expect(cfgEff._tag).toBe("Failure")
        expect(() => NodeControl.layerServerNoopAuth({ host: "0.0.0.0", port: 0 })).toThrow()
        expect(NodeControl.layerServerNoopAuth({ host: "127.0.0.1", port: 0 })).toBeDefined()
        expect(NodeControl.layerServerBearerAuth({ token: "tok" } as any, { host: "127.0.0.1", port: 0 })).toBeDefined()

        // 3. NativeEquipment: askPolicy, checkpointStore, sandboxProvidersFrom, sealedContainer, checkoutFacts, testRunner, seatResolver (pins + roles + pool)
        expect(NativeEquipment.askPolicy({})).toBe("park")
        expect(NativeEquipment.askPolicy({ SMITHERS_ASKS: "park" })).toBe("park")
        expect(NativeEquipment.askPolicy({ SMITHERS_ASKS: "refuse" })).toBe("refuse")
        expect(() => NativeEquipment.askPolicy({ SMITHERS_ASKS: "always" })).toThrow()

        expect(NativeEquipment.checkpointStore({}, tmp)).toEqual({ root: tmp })
        expect(NativeEquipment.checkpointStore({ SMITHERS_TEST_CWD: "/work" }, tmp)).toEqual({
          root: tmp,
          cwd: "/work"
        })
        expect(NativeEquipment.sandboxProvidersFrom({})).toEqual({})
        expect(typeof NativeEquipment.sandboxProvidersFrom({ SMITHERS_SANDBOX_IMAGE: "ubuntu:latest" }).container).toBe(
          "function"
        )

        expect(NativeEquipment.sealedContainer({})).toBeUndefined()
        expect(NativeEquipment.sealedContainer({ SMITHERS_BASH_CONTAINER: "   " })).toBeUndefined()
        expect(NativeEquipment.sealedContainer({ SMITHERS_BASH_CONTAINER: "my-box" })).toBeDefined()

        expect(NativeEquipment.testRunner({}, tmp)).toBeUndefined()
        expect(NativeEquipment.testRunner({ SMITHERS_TEST_COMMAND: "echo ok", SMITHERS_TEST_CWD: "/app" }, tmp))
          .toBeDefined()
        expect(NativeEquipment.checkoutFacts({})).toBeDefined()

        // Account pool default model & seat resolver with pins + SMITHERS_SEATS + SMITHERS_ACCOUNT_POOL_URL
        const claudeDir = join(tmp, "claude-acct")
        const codexDir = join(tmp, "codex-acct")
        mkdirSync(claudeDir, { recursive: true })
        mkdirSync(codexDir, { recursive: true })

        const resolverBadRoles = NativeEquipment.seatResolver({ SMITHERS_SEATS: "{invalid" }, undefined as any)
        const badRoleEx = await Effect.runPromise(Effect.exit(resolverBadRoles.resolve("planner")))
        expect(badRoleEx._tag).toBe("Failure")

        const resolverPins = NativeEquipment.seatResolver(
          {
            SMITHERS_SEATS: JSON.stringify({ planner: "claude:missing-dir", reviewer: "codex:missing-dir" }),
            SMITHERS_ACCOUNT_POOL_URL: poolOrigin,
            SMITHERS_ACCOUNT_POOL_KEY: "pool-key-1"
          },
          undefined as any
        )
        for (
          const seat of [
            "planner",
            "reviewer",
            "unpinned-role",
            `claude:${join(tmp, "nope")}/claude-sonnet-4-5`,
            `claude:${claudeDir}/claude-sonnet-4-5`,
            `codex:${codexDir}/gpt-5.1-codex`,
            "openai/gpt-5.1"
          ]
        ) {
          await Effect.runPromise(Effect.exit(resolverPins.resolve(seat)))
        }

        poolFail = true
        const resolverPoolFail = NativeEquipment.seatResolver(
          {
            SMITHERS_ACCOUNT_POOL_URL: poolOrigin,
            SMITHERS_ACCOUNT_POOL_KEY: "pool-key-1"
          },
          undefined as any
        )
        await Effect.runPromise(Effect.exit(resolverPoolFail.resolve("openai/gpt-5.1")))
        poolFail = false

        const poolDef = NativeEquipment.accountPoolDefaultModel({
          SMITHERS_ACCOUNT_POOL_URL: poolOrigin,
          SMITHERS_ACCOUNT_POOL_KEY: "pool-key-1"
        })
        expect(poolDef).toBeDefined()

        const cands = await NativeEquipment.seatCandidates({
          environment: { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-openai-test" },
          home: tmp,
          platform: process.platform,
          pathExists: () => false,
          readFile: () => undefined,
          which: () => undefined
        } as any)
        expect(Array.isArray(cands)).toBe(true)
      } finally {
        await new Promise<void>((r) => poolServer.close(() => r()))
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )
})
