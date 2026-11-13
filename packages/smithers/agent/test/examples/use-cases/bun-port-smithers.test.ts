import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { DurableDeferred, HumanTask } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { TestNodeRuntime } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunPortSmithers, layer, phases, questions, ZigFile } from "../../../examples/use-cases/bun-port-smithers.ts"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "bun-port-smithers-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** Reads one `NAME: value` header line off a prompt, as 0.x's dry-run agents did. */
const tag = (asked: string, name: string): string => new RegExp(`\\n${name}: (.*)`).exec(asked)?.[1] ?? ""

/** Reads the one-line JSON a prompt renders after `label`. */
const rendered = (asked: string, label: string): any => JSON.parse(new RegExp(`${label}: (.+)`).exec(asked)![1]!)

interface Port {
  /** The class every low-confidence field is classified as. */
  readonly lowClass?: "UNKNOWN" | "OWNED"
  /** The `cargo check` round each crate first compiles on. */
  readonly compilesOn?: Readonly<Record<string, number>>
  /** Gated modules each crate's check reports. */
  readonly gated?: number
  /** The decision round each target is first approved on. */
  readonly approvedOn?: number
}

/**
 * Agents that answer from the headers and rendered JSON of the prompt they were
 * handed. Each request is logged as `<OUTPUT_KIND> <subject>` in order.
 */
const script = (port: Port = {}) => {
  const log: Array<string> = []
  const decisions = new Map<string, number>()
  const fixed = new Set<string>()
  const answer: Kit.Script = (asked) => {
    const kind = tag(asked, "OUTPUT_KIND")
    switch (kind) {
      case "lifetime-classify": {
        const zig = tag(asked, "ZIG")
        log.push(`${kind} ${zig}`)
        const field = (name: string, confidence: "high" | "low") => ({
          struct: "Server",
          field: name,
          zigType: "?*Thing",
          class: confidence === "low" ? port.lowClass ?? "OWNED" : "OWNED",
          rustType: "Option<NonNull<Thing>>",
          evidence: `${zig}:1`,
          confidence
        })
        return { file: zig, crate: tag(asked, "CRATE"), fields: [field("ptr", "low"), field("owned", "high")] }
      }
      case "lifetime-verify": {
        const key = tag(asked, "FIELD_KEY")
        log.push(`${kind} ${key} ${tag(asked, "VOTER")}`)
        return { key, voter: tag(asked, "VOTER"), refuted: false, correctClass: "OWNED", reason: "agrees" }
      }
      case "phase-a-implement":
        log.push(`${kind} ${tag(asked, "ZIG")} -> ${tag(asked, "RS")}`)
        return {
          zig: tag(asked, "ZIG"),
          rs: tag(asked, "RS"),
          status: "drafted",
          confidence: "medium",
          todos: 1,
          rsLoc: 12,
          note: ""
        }
      case "phase-a-verify":
        log.push(`${kind} ${tag(asked, "RS")}`)
        return {
          subject: tag(asked, "RS"),
          reviewer: "phase-a-reviewer",
          approved: false,
          ok: false,
          issues: [{ severity: "must-fix", rule: "SAFETY", detail: "missing // SAFETY:" }],
          feedback: "one must-fix"
        }
      case "phase-a-fix": {
        const findings = rendered(asked, "Findings")
        log.push(`${kind} ${tag(asked, "RS")} ${findings.map((f: { rule: string }) => f.rule).join(",")}`)
        return { zig: tag(asked, "ZIG"), rs: tag(asked, "RS"), applied: findings.length, remaining: 0, note: "" }
      }
      case "crate-check": {
        const crate = tag(asked, "CRATE")
        const previous = rendered(asked, "Round context")
        const rounds = (previous?.rounds ?? 0) + 1
        log.push(`${kind} ${crate} round ${rounds}`)
        return {
          crate,
          tier: Number(tag(asked, "TIER")),
          compiles: rounds >= (port.compilesOn?.[crate] ?? 1),
          errorCount: 0,
          rounds,
          gatedModules: Array.from({ length: port.gated ?? 0 }, (_, i) => `${crate}::m${i}`),
          blockedOn: [],
          notes: ""
        }
      }
      case "proper-port": {
        const target = tag(asked, "TARGET")
        const previous = rendered(asked, "Previous review decision")
        log.push(`${kind} ${target} after ${previous === null ? "none" : previous.feedback}`)
        return { targetId: target, status: "patched", filesChanged: [tag(asked, "FILE")], summary: "ported" }
      }
      case "spec-review": {
        const patch = rendered(asked, "Patch result")
        log.push(`${kind} ${tag(asked, "TARGET")} ${tag(asked, "VOTER")} saw ${patch.status}`)
        return {
          targetId: tag(asked, "TARGET"),
          reviewer: tag(asked, "VOTER"),
          approved: true,
          issues: [],
          feedback: ""
        }
      }
      case "spec-decision": {
        const target = tag(asked, "TARGET")
        const round = (decisions.get(target) ?? 0) + 1
        decisions.set(target, round)
        const reviews = rendered(asked, "Reviews")
        log.push(`${kind} ${target} round ${round} from ${reviews.length} reviews`)
        const approved = round >= (port.approvedOn ?? 1)
        return {
          targetId: target,
          approved,
          approvals: approved ? 2 : 1,
          rejections: approved ? 0 : 1,
          issues: [],
          feedback: approved ? "accepted" : `round ${round} needs the allocator branch`
        }
      }
      case "build":
        log.push(kind)
        return { ok: true, command: "cargo build -p bun_bin", summary: "built bun-rs" }
      case "probe": {
        const probe = tag(asked, "PROBE")
        const passed = fixed.size > 0
        log.push(`${kind} ${probe} ${passed ? "pass" : "panic"}`)
        return {
          probeId: probe,
          command: tag(asked, "COMMAND"),
          passed,
          panicLocation: passed ? null : "src/cli/arguments.rs:88",
          assertion: null,
          signal: null,
          durationMs: 5,
          output: ""
        }
      }
      case "failure-fix": {
        const key = tag(asked, "FAILURE")
        fixed.add(key)
        log.push(`${kind} ${key}`)
        return { failureKey: key, status: "fixed", filesChanged: ["src/cli/arguments.rs"], summary: "" }
      }
      case "test-area":
        log.push(`${kind} ${tag(asked, "AREA")} on ${tag(asked, "BRANCH")}`)
        return {
          areaId: tag(asked, "AREA"),
          pass: 3,
          fail: 0,
          total: 3,
          allPass: true,
          bughuntBugs: 0,
          commits: ["c1"],
          branch: tag(asked, "BRANCH"),
          notes: ""
        }
      case "merge":
        log.push(`${kind} ${tag(asked, "SUBJECT")} from ${tag(asked, "BRANCH")}`)
        return {
          id: tag(asked, "SUBJECT"),
          picked: rendered(asked, "Area result").commits.length,
          conflicts: 0,
          notes: ""
        }
      case "sweep": {
        const previous = rendered(asked, "Previous sweep result")
        log.push(`${kind} ${tag(asked, "SWEEP")} after ${previous === null ? "none" : previous.skipped}`)
        return {
          sweepId: tag(asked, "SWEEP"),
          kind: tag(asked, "KIND"),
          candidates: 2,
          fixed: 1,
          skipped: previous === null ? 1 : 0,
          summary: ""
        }
      }
      default:
        return undefined
    }
  }
  return { answer, log }
}

/**
 * The operator: answers each question in `answers` in order once the run
 * parks on it, recording the prompt it was shown.
 */
const operator = (
  executionId: string,
  answers: ReadonlyArray<readonly [string, typeof HumanTask.action.successSchema.Type]>
) => {
  const shown: Array<string> = []
  const answering = Effect.forEach(answers, ([name, value]) =>
    Effect.gen(function*() {
      const token = DurableDeferred.tokenFromExecutionId(HumanTask.deferred(name, 1), {
        flow: BunPortSmithers,
        executionId
      })
      const state = yield* DurableEngineState.DurableEngineState
      const row = yield* state.waiting(executionId).pipe(
        Effect.repeat({
          until: (waiting) => Option.isSome(waiting) && waiting.value.token === token,
          schedule: Schedule.spaced(10)
        })
      )
      shown.push((Option.getOrThrow(row).request as { readonly prompt: string }).prompt)
      yield* HumanTask.answer({ token, value })
    }), { discard: true })
  return { shown, layer: Layer.effectDiscard(Effect.forkScoped(Effect.orDie(answering))) }
}

const files = [{ zig: "src/http/http.zig", crate: "http", loc: 1200 }]

const firstIndex = (log: ReadonlyArray<string>, kind: string) => log.findIndex((entry) => entry.startsWith(kind))

it.live(
  "runs all seven phases in order, each loop to its exit, and merges the green area",
  () =>
    Effect.gen(function*() {
      const { answer, log } = script({ compilesOn: { http: 2 }, approvedOn: 2 })
      const payload = {
        repo: "/tmp/bun",
        requireOperatorPlan: false,
        files,
        crates: [{ name: "bun_jsc", tier: 1 }, { name: "bun_http", tier: 0 }],
        targets: [{ id: "http-server", crate: "http", file: "src/http/lib.rs" }],
        probes: [{ id: "help", cmd: "--help", expect: "Usage" }],
        areas: [{ id: "bun-http", glob: "test/js/bun/http/", crate: "runtime/server" }],
        sweeps: [{ id: "idioms", kind: "idiom" as const, pattern: "TODO(port)", scope: "src/" }]
      }
      const options = {
        filename: join(directory, "all-phases.sqlite"),
        executionId: "bun-port-all-phases",
        script: answer,
        actions: layer
      }
      const final = yield* Kit.run(BunPortSmithers, payload, options)

      // Each phase starts only after the one before it settled.
      const starts = [
        "lifetime-classify",
        "phase-a-implement",
        "crate-check",
        "proper-port",
        "build",
        "test-area",
        "sweep"
      ]
        .map((kind) => firstIndex(log, kind))
      expect(starts).toEqual([...starts].sort((a, b) => a - b))
      expect(starts.every((index) => index >= 0)).toBe(true)
      // The low-confidence field got three votes; the high-confidence one was not sampled.
      const verifiers = log.filter((e) => e.startsWith("lifetime-verify"))
      expect([...verifiers].sort()).toEqual(
        [1, 2, 3].map((n) => `lifetime-verify src/http/http.zig|Server|ptr verifier-${n}`)
      )
      expect(
        log.every((entry, index) =>
          !entry.startsWith("lifetime-verify") || index < firstIndex(log, "phase-a-implement")
        )
      ).toBe(true)
      // Reopen the persisted run. Replay retains its recorded sequence and never
      // calls the seats again, even when they would now reject every request.
      const recordedLog = [...log]
      const history = () =>
        Effect.scoped(
          Effect.gen(function*() {
            const journal = yield* Journal.Journal
            const state = yield* DurableEngineState.DurableEngineState
            const pending = [options.executionId]
            const pages: Array<Journal.EntriesPage> = []
            for (const runId of pending) {
              pages.push(yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 10_000 }))
              for (const edge of yield* state.runChildren(runId)) {
                if (!pending.includes(edge.childId)) pending.push(edge.childId)
              }
            }
            return pages
          }).pipe(Effect.provide(TestNodeRuntime.durableEngine(options.filename, "examples-use-cases")))
        )
      const recorded = yield* history()
      expect(recorded.length).toBeGreaterThan(1)
      for (const page of recorded) {
        expect(page.hasMore).toBe(false)
        expect(page.entries.length).toBeGreaterThan(0)
      }
      const replayed = yield* Kit.run(BunPortSmithers, payload, {
        ...options,
        script: () => {
          throw new Error("Replay must not call a model")
        }
      })
      expect(replayed).toEqual(final)
      expect(yield* history()).toEqual(recorded)
      expect(log).toEqual(recordedLog)
      expect(log.filter((e) => e.startsWith("lifetime-verify"))).toEqual(verifiers)
      // Phase A wrote the path 0.x computed and fixed the must-fix finding.
      expect(log).toContain("phase-a-implement src/http/http.zig -> src/http/lib.rs")
      expect(log).toContain("phase-a-fix src/http/lib.rs SAFETY")
      // Tier 0 compiled on its second round before tier 1 started.
      expect(log.filter((e) => e.startsWith("crate-check"))).toEqual([
        "crate-check http round 1",
        "crate-check http round 2",
        "crate-check jsc round 1"
      ])
      // The rejected target was re-patched with the decision that rejected it.
      expect(log.filter((e) => e.startsWith("proper-port") || e.startsWith("spec-decision"))).toEqual([
        "proper-port http-server after none",
        "spec-decision http-server round 1 from 2 reviews",
        "proper-port http-server after round 1 needs the allocator branch",
        "spec-decision http-server round 2 from 2 reviews"
      ])
      // The panicking probe was fixed, and the next round rebuilt and passed.
      expect(log.filter((e) => /^(build|probe|failure-fix)/.test(e))).toEqual([
        "build",
        "probe help panic",
        "failure-fix src/cli/arguments.rs:88|no-assertion|no-signal|--help",
        "build",
        "probe help pass"
      ])
      expect(log).toContain("merge bun-http from bun-port/bun-http")
      expect(log.filter((e) => e.startsWith("sweep"))).toEqual(["sweep idioms after none", "sweep idioms after 1"])
      expect(final).toEqual({
        status: "completed",
        phasesRun: [...phases],
        summary: "Bun port Smithers workflow completed 7 phase(s).",
        nextActions: [
          "Inspect child run reports and Smithers scores.",
          "Use timeline/fork/replay for any failed or low-confidence node."
        ]
      })
    }),
  { timeout: 120_000 }
)

it.live(
  "asks the operator first, skips the phase it switched off, and gates a high UNKNOWN rate",
  () =>
    Effect.gen(function*() {
      const { answer, log } = script({ lowClass: "UNKNOWN" })
      const person = operator("bun-port-operator", [
        [questions.plan, { approved: true, runPhaseA: false }],
        [questions.lifetimes, true]
      ])
      const final = yield* Kit.run(BunPortSmithers, { repo: "/tmp/bun", phases: ["lifetimes", "phaseA"], files }, {
        filename: join(directory, "operator.sqlite"),
        executionId: "bun-port-operator",
        script: answer,
        actions: Layer.mergeAll(layer, person.layer)
      })

      expect(person.shown[0]).toContain("Review this Bun port run before agent work starts.")
      expect(person.shown[0]).toContain("\"phases\":[\"lifetimes\",\"phaseA\"]")
      // One of the two classified fields is UNKNOWN, above the 0.05 default.
      expect(person.shown[1]).toContain("Approve lifetime classification quality?")
      expect(person.shown[1]).toContain("UNKNOWN rate 0.5.")
      expect(log.some((e) => e.startsWith("lifetime-classify"))).toBe(true)
      expect(log.some((e) => e.startsWith("phase-a"))).toBe(false)
      expect(final.phasesRun).toEqual(["lifetimes"])
      expect(final.summary).toBe("Bun port Smithers workflow completed 1 phase(s).")
    }),
  { timeout: 120_000 }
)

it.live("cancels without asking any agent when the operator does not approve", () =>
  Effect.gen(function*() {
    const { answer, log } = script()
    const person = operator("bun-port-denied", [[questions.plan, { approved: false, comments: "scope too wide" }]])
    const final = yield* Kit.run(BunPortSmithers, { files }, {
      filename: join(directory, "denied.sqlite"),
      executionId: "bun-port-denied",
      script: answer,
      actions: Layer.mergeAll(layer, person.layer)
    })

    expect(log).toEqual([])
    expect(final).toEqual({
      status: "cancelled",
      phasesRun: [],
      summary: "Operator did not approve the Bun port run. scope too wide",
      nextActions: ["Revise input scope and start a new run."]
    })
  }), { timeout: 120_000 })

it.live("fails the run when the operator denies broad compile gate debt", () =>
  Effect.gen(function*() {
    const { answer, log } = script({ gated: 21 })
    const person = operator("bun-port-gate-denied", [[questions.compile, false]])
    const failure = yield* Effect.flip(Kit.run(BunPortSmithers, {
      requireOperatorPlan: false,
      phases: ["compile", "ungate"],
      crates: [{ name: "http", tier: 0 }],
      targets: [{ id: "http-server", crate: "http", file: "src/http/lib.rs" }]
    }, {
      filename: join(directory, "gate-denied.sqlite"),
      executionId: "bun-port-gate-denied",
      script: answer,
      actions: Layer.mergeAll(layer, person.layer)
    }))

    expect(person.shown[0]).toContain("Approve compile gate/stub debt?")
    expect(person.shown[0]).toContain("\"gatedModules\":21")
    expect(failure).toEqual({ _tag: "examples/BunPortSmithers/ApprovalDenied", gate: questions.compile })
    expect(log).toEqual(["crate-check http round 1"])
  }), { timeout: 120_000 })

it("rejects a non-Zig path at the input schema", () => {
  for (const zig of ["src/a.ts", "", "src/a.zig/", "src/a.zig.bak"]) {
    expect(Exit.isFailure(Schema.decodeUnknownExit(ZigFile)({ zig }))).toBe(true)
  }
  expect(Schema.decodeUnknownSync(ZigFile)({ zig: "src/http/http.zig" })).toEqual({ zig: "src/http/http.zig" })
})

it.live("rejects invalid file input before spending a model call", () =>
  Effect.gen(function*() {
    const { answer, log } = script()
    const exit = yield* Kit.run(BunPortSmithers, {
      requireOperatorPlan: false,
      phases: ["lifetimes"],
      files: [{ zig: "src/a.ts" }]
    }, {
      filename: join(directory, "invalid-file.sqlite"),
      executionId: "bun-invalid-file",
      script: answer,
      actions: layer
    }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(log).toEqual([])
  }))

it.live("keeps an incomplete phase partial in the final report", () =>
  Effect.gen(function*() {
    const { answer } = script()
    const final = yield* Kit.run(BunPortSmithers, {
      requireOperatorPlan: false,
      phases: ["lifetimes"],
      files
    }, {
      filename: join(directory, "partial-phase.sqlite"),
      executionId: "bun-partial-phase",
      actions: layer,
      script: (asked) => {
        const result = answer(asked)
        return tag(asked, "OUTPUT_KIND") === "lifetime-verify" ? { ...result as object, refuted: true } : result
      }
    })
    expect(final.status).toBe("partial")
    expect(final.phasesRun).toEqual(["lifetimes"])
    expect(final.summary).toContain("partial")
  }), { timeout: 120_000 })

it.live("reports a requested phase with no result as partial", () =>
  Effect.gen(function*() {
    const { answer } = script()
    const final = yield* Kit.run(BunPortSmithers, {
      requireOperatorPlan: false,
      phases: ["phaseA"],
      files
    }, {
      filename: join(directory, "null-phase.sqlite"),
      executionId: "bun-null-phase",
      actions: layer,
      script: (asked) => {
        const result = answer(asked)
        return tag(asked, "OUTPUT_KIND") === "phase-a-verify" ? { ...result as object, issues: [] } : result
      }
    })
    expect(final.status).toBe("partial")
    expect(final.phasesRun).toEqual(["phaseA"])
  }), { timeout: 120_000 })
