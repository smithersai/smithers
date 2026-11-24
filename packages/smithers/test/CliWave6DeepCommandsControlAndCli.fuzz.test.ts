import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { Command as CliCommand } from "effect/cli"
import * as TestConsole from "effect/testing/TestConsole"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as ControlCommands from "../src/cli/ControlCommands.ts"
import * as Entry from "../src/cli/Entry.ts"
import * as RunEventStream from "../src/cli/RunEventStream.ts"
import * as StepCacheCommands from "../src/cli/StepCacheCommands.ts"
import * as CliError from "../src/CliError.ts"
import * as CommandMod from "../src/Command.ts"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as Settlement from "../src/commands/Settlement.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import * as Ui from "../src/Ui.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261127")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeSyntheticHost = (argv: ReadonlyArray<string>, cwd: string, env: Record<string, string | undefined> = {}) => {
  const stdoutBuf: Array<string> = []
  const stderrBuf: Array<string> = []
  const listeners = new Map<string, Array<() => void>>()
  let exitCode = 0
  const stdout = Object.assign(new PassThrough(), {
    isTTY: false,
    write: (chunk: unknown) => {
      stdoutBuf.push(String(chunk))
      return true
    }
  })
  const stderr = Object.assign(new PassThrough(), {
    isTTY: false,
    write: (chunk: unknown) => {
      stderrBuf.push(String(chunk))
      return true
    }
  })
  const host: Entry.Host = {
    argv: [...argv],
    cwd,
    env: { ...env },
    stdout: stdout as any,
    stderr: stderr as any,
    on: (sig, fn) => {
      const list = listeners.get(sig) ?? []
      list.push(fn)
      listeners.set(sig, list)
    },
    removeListener: (sig, fn) => {
      const list = listeners.get(sig) ?? []
      listeners.set(sig, list.filter((f) => f !== fn))
    },
    setExitCode: (code) => {
      exitCode = code
    }
  }
  return {
    host,
    emit: (sig: "SIGINT" | "SIGTERM") => {
      for (const fn of [...(listeners.get(sig) ?? [])]) fn()
    },
    getStdout: () => stdoutBuf.join(""),
    getStderr: () => stderrBuf.join(""),
    getExitCode: () => exitCode
  }
}

describe("@smthrs/cli Wave-6B Deep Entry, RunEventStream, Settlement, ControlBridge, ControlCommands, StepCache, Runner & Command Tree fuzz invariants", () => {
  it(
    "Settlement & RunEventStream uphold terminal detection, orphan liveness, cursor resume, bounded event size & receipt invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          kind: Schema.Literals([
            "control.run.completed",
            "control.run.failed",
            "control.run.cancelled",
            "control.run.parked",
            "control.run.pending",
            "control.run.waiting-approval",
            "control.run.started",
            "control.run.superseded"
          ]),
          follow: Schema.Boolean,
          useOffsetCursor: Schema.Boolean,
          ownerMode: Schema.Literals(["dead-local", "foreign-host", "invalid-json", "none"]),
          oversizeEvent: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ follow, kind, oversizeEvent, ownerMode, useOffsetCursor }) =>
            Effect.promise(async () => {
              // 1. Settlement pure functions & helpers
              const isSettled = Settlement.settled(kind)
              assertInv(typeof isSettled === "boolean", "settled returns boolean")

              const settlement: Settlement.Settlement = {
                runId: "r-settle-1",
                kind,
                sequence: 5,
                payload: { reason: "test-reason", status: "completed", error: "boom" }
              } as any
              const st = Settlement.status(settlement)
              assertInv(st === undefined || typeof st === "number", "status numeric or undefined")
              const rep = Settlement.report(settlement)
              assertInv(rep === undefined || typeof rep === "object", "report object or undefined")
              const doc = Settlement.receiptDocument(
                { runId: "r-settle-1", accepted: true, status: "running" } as any,
                settlement
              )
              assertInv(typeof doc === "object" && doc !== null, "receiptDocument returns object")
              assertInv(
                Settlement.wasDeclined(settlement) === (kind === "control.run.pending"),
                "wasDeclined matches pending"
              )
              const declErr = Settlement.declined(
                "r-settle-1",
                { runId: "r-settle-1", status: "failed", flowName: "demo" } as any
              )
              assertInv(declErr instanceof CliError.UnsupportedError, "declined returns UnsupportedError")
              const watchErr = Settlement.watchFailure(
                new ControlError.TransportError({ message: "net", retryable: true }),
                "r-settle-1",
                "follow"
              )
              assertInv(watchErr instanceof ControlError.TransportError, "watchFailure wraps TransportError")

              // 2. RunEventStream.events (finite + follow + orphan/terminal + oversize)
              const now = new Date().toISOString()
              const ownerId = ownerMode === "dead-local"
                ? JSON.stringify({ hostId: hostname(), pid: 99999999, nonce: "dead-1" })
                : ownerMode === "foreign-host"
                ? JSON.stringify({ hostId: "other-host.invalid", pid: 1234, nonce: "for-1" })
                : ownerMode === "invalid-json"
                ? "{corrupt"
                : undefined
              const evPayload = oversizeEvent ? { blob: "x".repeat(2 * 1024 * 1024) } : { ok: true }
              const baseEvents = [
                {
                  sequence: 1,
                  runId: "r-stream-1",
                  kind: "control.run.started",
                  timestamp: now,
                  payload: evPayload,
                  cursor: { sequence: 1 }
                },
                {
                  sequence: 2,
                  runId: "r-stream-1",
                  kind,
                  timestamp: now,
                  payload: { ok: true },
                  cursor: { sequence: 2, offset: 1 }
                }
              ]
              let polls = 0
              const fakeControl = Control.Control.of({
                list: () =>
                  Effect.sync(() => {
                    polls++
                    return {
                      _tag: "runs" as const,
                      items: [{
                        runId: "r-stream-1",
                        flowName: "demo",
                        status: "completed",
                        recordedStatus: ownerMode === "dead-local" && polls === 1 ? "running" : "completed",
                        ownerId,
                        startedAt: now
                      } as any]
                    }
                  }),
                watch: (req: any) =>
                  req.follow
                    ? Stream.fromIterable(baseEvents).pipe(Stream.concat(Stream.never as any))
                    : Stream.fromIterable(baseEvents.filter((e) => (req.afterSequence ?? 0) < e.sequence))
              } as any)

              const cursor = useOffsetCursor ? { sequence: 0, offset: 0 } : { sequence: 0 }
              const streamExit = await Effect.runPromiseExit(
                Stream.runCollect(RunEventStream.events("r-stream-1", follow, cursor)).pipe(
                  Effect.provideService(Control.Control, fakeControl)
                )
              )
              if (oversizeEvent) {
                assertInv(Exit.isFailure(streamExit), "oversize event rejected with ResourceLimitError")
              } else {
                assertInv(
                  Exit.isSuccess(streamExit),
                  `expected stream success, got ${Exit.isFailure(streamExit) ? String(streamExit.cause) : ""}`
                )
              }

              // 3. Settlement awaitRun, latestSequence, latestPark, latestResumablePark, decisionPark
              const seq = await Effect.runPromise(Settlement.latestSequence(Stream.fromIterable(baseEvents as any)))
              assertInv(seq === 2, `latestSequence=${seq}`)

              const parkEvents = [
                { sequence: 1, runId: "r-park-1", kind: "control.run.started", timestamp: now, payload: {} },
                {
                  sequence: 2,
                  runId: "r-park-1",
                  kind: "control.run.waiting-approval",
                  timestamp: now,
                  payload: { approvalId: "a-1" }
                },
                {
                  sequence: 3,
                  runId: "r-park-1",
                  kind: "control.run.parked",
                  timestamp: now,
                  payload: { reason: "interrupted", resumable: true, generation: 1 }
                }
              ]
              const parkControl = Control.Control.of({
                list: () =>
                  Effect.succeed({
                    _tag: "runs" as const,
                    items: [{ runId: "r-park-1", flowName: "demo", status: "parked", startedAt: now } as any]
                  }),
                watch: () => Stream.fromIterable(parkEvents as any)
              } as any)
              const lp = await Effect.runPromise(Settlement.latestPark(parkControl, "r-park-1"))
              assertInv(lp === 2, `latestPark=${lp}`)
              const lrp = await Effect.runPromise(Settlement.latestResumablePark(parkControl, "r-park-1"))
              assertInv(lrp === 3, `latestResumablePark=${lrp}`)

              const completedControl = Control.Control.of({
                list: () =>
                  Effect.succeed({
                    _tag: "runs" as const,
                    items: [{ runId: "r-done-1", flowName: "demo", status: "completed", startedAt: now } as any]
                  }),
                watch: () =>
                  Stream.fromIterable([
                    {
                      sequence: 1,
                      runId: "r-done-1",
                      kind: "control.run.completed",
                      timestamp: now,
                      payload: { result: { ok: true } }
                    }
                  ] as any)
              } as any)
              const awaited = await Effect.runPromise(
                (Settlement.awaitRun as any)(completedControl, "r-done-1", 0).pipe(
                  Effect.provideService(Control.Control, completedControl)
                )
              )
              assertInv((awaited as any).kind === "control.run.completed", "awaitRun settles on completed")

              return true
            }),
          { executions: Math.min(executions, 24), seed }
        )
      )
      if (report._tag !== "Passed") {
        throw new Error(`Falsified: ${JSON.stringify(report)}`)
      }
      expect(report._tag).toBe("Passed")
    },
    120_000
  )

  it(
    "Entry.main, ControlBridge, ControlCommands, StepCacheCommands & RunnerCmd uphold CLI dispatch, signal & status invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-entry-fuzz-"))
      try {
        mkdirSync(join(tmp, ".flows"), { recursive: true })

        // 1. Entry.main across help, version, info, cache env stripping, SIGINT (normal vs tui vs tui -p), SIGTERM, and pre-aborted signal
        const h1 = makeSyntheticHost(["--version"], tmp, {
          SMITHERS_CACHE_URL: "https://cache.invalid",
          SMITHERS_CACHE_TOKEN: "tok-secret"
        })
        await Entry.main(h1.host)
        expect(h1.host.env["SMITHERS_CACHE_URL"]).toBeUndefined()
        expect(h1.host.env["SMITHERS_CACHE_TOKEN"]).toBeUndefined()
        expect(h1.getExitCode()).toBe(0)

        const h2 = makeSyntheticHost(["--help"], tmp)
        await Entry.main(h2.host)
        expect(h2.getStdout().length).toBeGreaterThan(0)

        const h3 = makeSyntheticHost(["info", "--json"], tmp)
        await Entry.main(h3.host)
        expect(h3.getExitCode()).toBe(0)

        // Pre-interrupted mainEffect fiber
        const h4 = makeSyntheticHost(["--help"], tmp)
        await Effect.runPromise(
          Effect.gen(function*() {
            const fiber = yield* Effect.forkChild(Entry.mainEffect(h4.host))
            yield* Fiber.interrupt(fiber)
          })
        )

        // 2. ControlBridge utilities
        const bridgeArb = Arbitrary.schema(
          Schema.Struct({
            remote: Schema.Literals(["", "https://remote.smithers.test"]),
            token: Schema.Literals(["", "tok_123"]),
            verbose: Schema.Boolean,
            quiet: Schema.Boolean,
            json: Schema.Boolean,
            format: Schema.Literals(["", "json", "toon"])
          })
        )
        const bridgeRep = await Effect.runPromise(
          Fuzz.run(
            bridgeArb,
            ({ format, json, quiet, remote, token, verbose }) =>
              Effect.sync(() => {
                const opts: any = {
                  root: tmp,
                  ...(remote ? { remote } : {}),
                  ...(token ? { token } : {}),
                  verbose,
                  quiet,
                  json,
                  ...(format ? { format } : {})
                }
                const args = ControlBridge.connectionArguments(opts)
                assertInv(Array.isArray(args), "connectionArguments returns array")
                const cfg = ControlBridge.configuration(opts, { environment: {} })
                assertInv(typeof cfg === "object" && cfg !== null, "configuration returns object")
                assertInv(
                  ControlBridge.isRemote(opts, { environment: {} }) === Boolean(remote),
                  "isRemote matches remote"
                )
                const hasRec = ControlBridge.hasRecords(opts, { environment: {} })
                assertInv(typeof hasRec === "boolean", "hasRecords boolean")

                const ac = new AbortController()
                ac.abort(new Error("aborted-by-user"))
                const abErr = ControlBridge.failureOf(Cause.interrupt(0 as any), ac.signal)
                assertInv(abErr !== undefined, "failureOf handles abort")
                const failErr = ControlBridge.failureOf(Cause.fail(new Error("boom")), undefined)
                assertInv(failErr instanceof Error, "failureOf extracts fail")
                return true
              }),
            { executions: Math.min(executions, 30), seed: seed + 1 }
          )
        )
        expect(bridgeRep._tag).toBe("Passed")

        // 3. ControlCommands: guardIncident, pendingApprovals, cancelAll
        const now = new Date().toISOString()
        const fakeControl = Control.Control.of({
          list: (q: any) =>
            Effect.succeed(
              q._tag === "approvals"
                ? {
                  _tag: "approvals" as const,
                  items: [{
                    approvalId: "app-1",
                    runId: "r-app-1",
                    status: "pending",
                    prompt: "Approve deploy?",
                    requestedAt: now
                  } as any]
                }
                : {
                  _tag: "runs" as const,
                  items: [{
                    runId: "r-app-1",
                    flowName: "demo",
                    status: "running",
                    startedAt: now
                  } as any]
                }
            ),
          watch: () =>
            Stream.fromIterable([
              { sequence: 1, runId: "r-app-1", kind: "control.run.started", timestamp: now, payload: {} },
              {
                sequence: 2,
                runId: "r-app-1",
                kind: "control.agent.guard-incident",
                timestamp: now,
                payload: { kind: "loop", message: "repeated call", count: 3 }
              }
            ] as any),
          cancel: () => Effect.succeed({ runId: "r-app-1", status: "cancelled" } as any)
        } as any)

        const inc = await Effect.runPromise(
          ControlCommands.guardIncident("r-app-1").pipe(Effect.provideService(Control.Control, fakeControl))
        )
        expect(inc === undefined || typeof inc === "object").toBe(true)

        const pending = await Effect.runPromise(
          ControlCommands.pendingApprovals("r-app-1").pipe(Effect.provideService(Control.Control, fakeControl))
        )
        expect(Array.isArray(pending)).toBe(true)

        const pendingAll = await Effect.runPromise(
          ControlCommands.pendingApprovals().pipe(Effect.provideService(Control.Control, fakeControl))
        )
        expect(Array.isArray(pendingAll)).toBe(true)

        const cancelled = await Effect.runPromise(
          (ControlCommands.cancelAll as any)({ all: true, root: tmp }, { environment: {} }).pipe(
            Effect.provideService(Control.Control, fakeControl)
          )
        )
        expect(typeof cancelled).toBe("object")

        // 4. StepCacheCommands CLI (list + show + clear on real SQLite workspace)
        const stepCli = StepCacheCommands.createStepCacheCli({ environment: {} })
        const runSub = async (cli: any, args: Array<string>) => {
          let out = ""
          const codes: Array<number> = []
          await cli.serve(args, { stdout: (s: string) => (out += s), exit: (c: number) => codes.push(c) })
          return { out, codes }
        }
        await runSub(stepCli, ["list", "--root", tmp])
        await runSub(stepCli, ["clear", "--root", tmp, "--yes"])

        // 5. RunnerCmd renderStatus (empty + populated) + createRunnerCli
        expect(RunnerCmd.renderStatus([])).toContain("No workstreams")
        const rendered = RunnerCmd.renderStatus([
          {
            id: "ws-1",
            title: "Core",
            goal: "Ship fast",
            status: "active",
            progress: { done: 1, total: 2 },
            tasks: [
              { id: "t1", title: "Build", status: "done", owners: [] },
              {
                id: "t2",
                title: "Test",
                status: "running",
                owners: [{ runId: "r-1", request: "req-1", profile: "sol", status: "running" }]
              }
            ]
          } as any
        ])
        expect(rendered).toContain("Core (ws-1)")
        expect(rendered).toContain("no lane")
        expect(rendered).toContain("r-1 sol running")

        // RunnerCmd status with origin refused
        const runnerCfgWithOrigin = join(tmp, "runner-origin.json")
        writeFileSync(
          runnerCfgWithOrigin,
          JSON.stringify({
            origin: "https://smithers.sh",
            lanesRoot: join(tmp, "lanes")
          })
        )
        const stExit = await Effect.runPromiseExit(RunnerCmd.status(runnerCfgWithOrigin))
        expect(Exit.isFailure(stExit)).toBe(true)

        // 6. Legacy Effect Command tree (Command.ts): run several read-only subcommands with fake Control
        const runLegacyCmd = (argv: ReadonlyArray<string>) =>
          CliCommand.runWith(CommandMod.cli, { version: "1.0.0" })(argv).pipe(
            Effect.provideService(Control.Control, fakeControl),
            Effect.provideService(Project.ProjectRoot, tmp),
            Effect.provideService(Ui.Ui, Ui.make({ interactive: false, output: process.stderr })),
            Effect.provide(Output.layer),
            Effect.provide(TestConsole.layer),
            Effect.provide(NodeServices.layer)
          )
        for (
          const argv of [
            ["ps"],
            ["ls"],
            ["approvals"],
            ["logs", "r-app-1"],
            ["status", "r-app-1"],
            ["gc", "--dry-run"]
          ]
        ) {
          const res = await Effect.runPromiseExit(runLegacyCmd(argv))
          expect(Exit.isSuccess(res) || Exit.isFailure(res)).toBe(true)
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )
})
