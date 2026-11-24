import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as FileCard from "../src/FileCard.ts"
import * as FlowCard from "../src/FlowCard.ts"
import * as HomeCard from "../src/HomeCard.ts"
import * as LocalApp from "../src/LocalApp.ts"
import * as LocalLsp from "../src/LocalLsp.ts"
import * as MonitorCard from "../src/MonitorCard.ts"
import * as Mythical from "../src/Mythical.ts"
import * as Refusal from "../src/Refusal.ts"
import * as RepositoryHome from "../src/RepositoryHome.ts"
import * as RunCard from "../src/RunCard.ts"
import * as SetupCard from "../src/SetupCard.ts"
import * as StackView from "../src/StackView.ts"
import * as SubagentCard from "../src/SubagentCard.ts"
import * as TodoCard from "../src/TodoCard.ts"
import * as TodoCommands from "../src/TodoCommands.ts"
import * as UiInstruction from "../src/UiInstruction.ts"
import * as UserFailure from "../src/UserFailure.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/rpc Wave 7 deep fuzz (Mythical, SubagentCard, StackView, UiInstruction, Refusal, Card schemas)", () => {
  it("Mythical routes, durations, machines, misroutes, settled states, and StackView projections hold invariants across all states", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        owner: Schema.Literals(["acme", "smithersai", "my-org"]),
        repo: Schema.Literals(["app", "smithers", "svc"]),
        state: Schema.Literals([
          "pending",
          "queued",
          "planning",
          "implementing",
          "integrating",
          "verifying",
          "proposed",
          "merged",
          "skipped",
          "failed",
          "blocked",
          "parked"
        ]),
        durationMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500_000 })),
        placementKind: Schema.Literals(["none", "local", "ssh", "cloud"]),
        misrouted: Schema.Boolean,
        accountKind: Schema.Literals(["claude", "codex", "api"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ owner, repo, state, durationMs, placementKind, misrouted, accountKind }) =>
          Effect.sync(() => {
            for (const key of Object.keys(Mythical.MYTHICAL_ROUTES) as Array<keyof typeof Mythical.MYTHICAL_ROUTES>) {
              const r = Mythical.mythicalRoute(key, owner, repo, "42")
              expect(r).toContain(owner)
              expect(r).toContain(repo)
            }

            const startedAt = "2026-10-20T00:00:00.000Z"
            const finishedAt = new Date(Date.parse(startedAt) + durationMs).toISOString()
            const dur1 = Mythical.mythicalReceiptDuration({
              stage: "verify",
              startedAt,
              finishedAt,
              ok: true
            } as never)
            const dur2 = Mythical.mythicalReceiptDuration({
              stage: "verify",
              startedAt,
              ok: false
            } as never)
            expect(dur1 === undefined || typeof dur1 === "string").toBe(true)
            expect(dur2 === undefined || typeof dur2 === "string").toBe(true)

            const placement =
              placementKind === "none"
                ? undefined
                : placementKind === "local"
                  ? { kind: "local", host: "macbook" }
                  : placementKind === "ssh"
                    ? { kind: "ssh", host: "nyc-02", machine: "nyc-02" }
                    : { kind: "cloud", region: "iad", machine: "cf-1" }
            const mach = Mythical.mythicalMachine(placement as never)
            expect(mach === undefined || typeof mach === "string").toBe(true)

            const routeCheck = Mythical.isMythicalMisroute({
              target: misrouted ? "main" : "mythical",
              expected: "mythical",
              actual: misrouted ? "other" : "mythical",
              expectedTarget: "mythical",
              actualTarget: misrouted ? "other" : "mythical"
            } as never)
            expect(typeof routeCheck).toBe("boolean")

            const item = {
              number: 7,
              title: "Ship fuzzing",
              state,
              reason: state === "skipped" || state === "failed" ? "policy_refusal" : undefined,
              skipReason: state === "skipped" ? "duplicate" : undefined,
              failure: state === "failed" ? { code: "test_failed", message: "boom" } : undefined,
              issue: { number: 7, title: "Ship fuzzing", url: "https://github.com/acme/app/issues/7" },
              pr: state === "proposed" || state === "merged" ? { number: 8, url: "https://github.com/acme/app/pull/8", state: "open" } : undefined
            } as unknown as Mythical.MythicalItem

            const stack = {
              owner,
              repo,
              state: "active",
              items: [item],
              changes: [],
              lanes: [],
              accounts: []
            } as unknown as Mythical.MythicalStack

            expect(typeof Mythical.isSettledItemState(state as never)).toBe("boolean")
            expect(typeof StackView.settled(item)).toBe("boolean")
            expect(StackView.itemStateLabel(item).length).toBeGreaterThan(0)
            expect(StackView.itemTitle(stack, item).length).toBeGreaterThan(0)
            const reason = StackView.itemReason(item)
            expect(reason === undefined || typeof reason === "string").toBe(true)
            const accLabel = StackView.accountLabel({
              id: "acc-1",
              provider: accountKind,
              label: "work",
              name: "acc-1"
            } as never)
            expect(accLabel.length).toBeGreaterThan(0)
            return true
          }),
        { executions: Math.min(executions, 140), seed }
      )
    )
    assertPassed(report)
  })

  it("SubagentCard grid, rowHeights, card, header, headerLine, earlierBatches, finished, toast, files, and diffCounts uphold layout & formatting invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        width: Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 220 })),
        count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 12 })),
        status: Schema.Literals(["requested", "queued", "running", "waiting", "parked", "done", "failed", "cancelled"]),
        now: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
        open: Schema.Boolean,
        added: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 })),
        removed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ width, count, status, now, open, added, removed }) =>
          Effect.sync(() => {
            const cols = SubagentCard.columns(width, count)
            expect(cols).toBeGreaterThanOrEqual(1)
            const rows = SubagentCard.grid(width, count)
            const totalCells = rows.reduce((acc, r) => acc + r.length, 0)
            expect(totalCells).toBe(count)
            const heights = SubagentCard.rowHeights(rows, Array.from({ length: count }, (_, i) => i + 1))
            expect(heights.length).toBe(rows.length)

            const entries: ReadonlyArray<SubagentCard.Entry> = [
              { kind: "tool", tool: "read", target: "src/index.ts" } as unknown as SubagentCard.Entry,
              { kind: "tool", tool: "edit", target: "src/app.ts", added, removed } as unknown as SubagentCard.Entry,
              { kind: "tool", tool: "bash", target: "pnpm test" } as unknown as SubagentCard.Entry
            ]
            const act = SubagentCard.activity(entries, 2)
            expect(act).toBeDefined()
            const fList = SubagentCard.files(
              [
                { path: "src/a.ts", added, removed },
                { path: "src/b.ts", added: 1, removed: 0 }
              ] as never,
              open
            )
            expect(fList).toBeDefined()

            const sub: SubagentCard.Subagent = {
              id: "sub-1",
              name: "worker-1",
              role: "Fuzzer",
              status,
              startedAt: 0,
              finishedAt: status === "done" || status === "failed" ? Math.max(1, now) : undefined,
              entries,
              files: [{ path: "src/a.ts", added, removed }]
            } as unknown as SubagentCard.Subagent

            const built = SubagentCard.card(sub, now, { open })
            expect(built).toBeDefined()
            const hdr = SubagentCard.header([status, "done"], now)
            expect(SubagentCard.headerLine(hdr).length).toBeGreaterThan(0)
            expect(SubagentCard.earlierBatches([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], open).length).toBeGreaterThanOrEqual(0)
            expect(SubagentCard.earlierLine(count)).toContain(String(count))
            expect(SubagentCard.finished("Fuzzer", status).line.length).toBeGreaterThan(0)
            expect(SubagentCard.toast({ title: "Fuzzer", status, startedAt: 0, endedAt: now }, now)).toBeDefined()
            expect(SubagentCard.counts(added, removed)).toBeDefined()
            expect(SubagentCard.diffCounts("+a\n+b\n-c\n context\n")).toEqual({ added: 2, removed: 1 })
            expect(SubagentCard.clip("hello world long string", Math.max(1, width))).toBeDefined()
            expect(SubagentCard.duration(now).length).toBeGreaterThan(0)
            return true
          }),
        { executions: Math.min(executions, 140), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("UiInstructionFrameSchema, Refusal helpers, TodoCommands, and Card schemas validate valid/invalid shapes consistently", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cmd: Schema.Literals(["runs.trace.view", "todo.new", "unknown.cmd"]),
        extraField: Schema.Literals(["none", "undeclared", "badState", "validState", "nonStringForm"]),
        status: Schema.Literals([200, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]),
        retryAfter: Schema.Literals(["none", "5", "invalid", "Wed, 21 Oct 2026 07:28:00 GMT"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cmd, extraField, status, retryAfter }) =>
          Effect.sync(() => {
            expect(typeof UiInstruction.isUiInstructionCommand(cmd)).toBe("boolean")
            expect(typeof UiInstruction.isFormInstructionCommand(cmd)).toBe("boolean")

            const frame: Record<string, unknown> = { command: cmd }
            if (extraField === "undeclared") frame["nonexistent_xyz"] = "abc"
            else if (extraField === "badState") frame["state"] = { invalid: 123 }
            else if (extraField === "validState") frame["state"] = null
            else if (extraField === "nonStringForm") frame["title"] = 999
            const parsedFrame = UiInstruction.UiInstructionFrameSchema.safeParse(frame)
            if (cmd === "unknown.cmd" || extraField === "undeclared") {
              expect(parsedFrame.success).toBe(false)
            }

            const fault = Refusal.faultOfStatus(status)
            expect(fault).toBeDefined()
            const ra = Refusal.retryAfterHeader({
              get: (name) => (name.toLowerCase() === "retry-after" && retryAfter !== "none" ? retryAfter : null)
            })
            expect(ra === null || typeof ra === "number").toBe(true)

            const ref = Refusal.refusalOf({
              body: { code: status === 429 ? "rate_limited" : status === 503 ? "no_capacity" : "unknown" },
              status,
              message: `status ${status}`,
              retryAfterSeconds: ra
            })
            const stored = Refusal.storedRefusal(ref)
            const restored = Refusal.refusalFromStored(stored)
            expect(restored.code).toBe(ref.code)
            expect(Refusal.statedWords(ref)).toBe(ref.message)
            expect(typeof Refusal.isCapacityRefusal(ref)).toBe("boolean")
            expect(typeof Refusal.mayAutoRetry(ref)).toBe("boolean")

            // Exercise TodoCommands + Card schema safeParse boundaries
            const tc = TodoCommands.todoCard(1, undefined, 0, 1_700_000_000_000)
            expect(tc.kind).toBe("todo")
            expect(FileCard.FileCardSchema.safeParse({}).success).toBe(false)
            expect(FlowCard.FlowCardSchema.safeParse({}).success).toBe(false)
            expect(HomeCard.HomeCardSchema.safeParse({}).success).toBe(false)
            expect(SetupCard.SetupCardSchema.safeParse({}).success).toBe(false)
            expect(TodoCard.TodoCardSchema.safeParse({}).success).toBe(false)
            expect(MonitorCard.MonitorCardSchema.safeParse({}).success).toBe(false)
            expect(RunCard.PlanCardGraphSchema.safeParse({}).success).toBe(false)
            expect(RepositoryHome.RepositoryHomeSchema.safeParse({}).success).toBe(false)
            expect(LocalApp.RepoSchema.safeParse({}).success).toBe(false)
            expect(LocalLsp.LspHoverSchema ? LocalLsp.LspHoverSchema.safeParse({}).success : false).toBe(false)
            expect(UserFailure).toBeDefined()
            return true
          }),
        { executions: Math.min(executions, 140), seed: seed + 2 }
      )
    )
    assertPassed(report)
  })
})
