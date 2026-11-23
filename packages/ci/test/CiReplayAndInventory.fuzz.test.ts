import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Expression from "../src/inventory/Expression.ts"
import * as Tools from "../src/inventory/Tools.ts"
import * as Cpu from "../src/replay/Cpu.ts"
import * as DiskSpace from "../src/replay/DiskSpace.ts"
import * as Failures from "../src/replay/Failures.ts"
import * as Names from "../src/replay/Names.ts"
import * as ProcessTable from "../src/replay/ProcessTable.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/ci replay, process table, CPU meter, failure classifier & expression evaluator fuzz invariants", () => {
  it("Expression.evaluate, toNumber, toText, truthy & formatPieces handle arbitrary expressions without crashing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        expr: Schema.Literals([
          "github.event_name == 'push'",
          "github.ref != 'refs/heads/main' && matrix.os == 'ubuntu-latest'",
          "contains('hello world', 'world') || startsWith('abc', 'a')",
          "endsWith('foo.ts', '.ts') && !false",
          "format('{0}-{1}', matrix.os, 42)",
          "join(matrix.items, ',')",
          "toJSON(matrix)",
          "fromJSON('{\"a\":1}').a == 1",
          "success() || always() || failure() || cancelled()",
          "unknown_ctx.field == 1",
          "((1 < 2) && (3 >= 3)) || (4 <= 2)",
          "invalid ((( syntax ===",
          ""
        ]),
        rawExpr: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
        osName: Schema.Literals(["ubuntu-latest", "macos-latest", "windows-latest"]),
        eventName: Schema.Literals(["push", "pull_request", "workflow_dispatch"]),
        template: Schema.Literals(["{0}-{1}", "literal {{0}}", "{99}", "{bad", "a{0}b"]),
        valStr: Schema.String.pipe(Schema.check(Schema.isMaxLength(20)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ expr, rawExpr, osName, eventName, template, valStr }) =>
          Effect.sync(() => {
            const ctxMap: Record<string, Expression.Context> = {
              github: Expression.value({ event_name: eventName, ref: "refs/heads/main" }),
              matrix: Expression.value({ os: osName, items: ["a", "b"] }),
              unknown_ctx: Expression.variable("v1", "unknown_ctx", true, false)
            }
            const scope: Expression.Scope = {
              context: (name) => ctxMap[name],
              status: { success: true, always: true, cancelled: false, failure: false }
            }
            const r1 = Expression.evaluate(expr, scope)
            const r2 = Expression.evaluate(expr, scope)
            if (r1.kind !== r2.kind) return false

            // Arbitrary raw input must never throw
            Expression.evaluate(rawExpr, scope)

            // Coercion & template helpers must be total & deterministic
            const n = Expression.toNumber(valStr)
            if (typeof n !== "number") return false
            if (Expression.toText(valStr) !== valStr) return false
            if (Expression.truthy(null) !== false) return false
            if (Expression.truthy(true) !== true) return false
            if (Expression.truthy(0) !== false) return false
            if (Expression.truthy(1) !== true) return false
            Expression.formatPieces(template)
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ProcessTable (fromStat/fromPs/treeOf) & Cpu (meterOf/observe/cpuMsOf) maintain monotonic tree & CPU accounting", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rootPid: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 10, maximum: 500 }))),
        childDelta: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
        utime1: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
        utime2: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
        comm: Schema.Literals(["node", "vitest (worker)", "cargo-fuzz", "sh"]),
        rawStat: Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
        elapsedMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 600_000 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rootPid, childDelta, utime1, utime2, comm, rawStat, elapsedMs }) =>
          Effect.sync(() => {
            const childPid = rootPid + childDelta
            const grandPid = childPid + 1
            // Valid Linux /proc/<pid>/stat line: pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime
            const stat1 = `${rootPid} (${comm}) S 1 ${rootPid} 1 0 -1 0 0 0 0 0 ${utime1} 5 0 0 20 0 1 0 100`
            const stat2 = `${childPid} (${comm}) R ${rootPid} ${rootPid} 1 0 -1 0 0 0 0 0 ${utime2} 3 0 0 20 0 1 0 200`
            const p1 = ProcessTable.fromStat(stat1)
            const p2 = ProcessTable.fromStat(stat2)
            if (p1 === undefined || p2 === undefined) return false
            if (p1.pid !== rootPid || p2.parent !== rootPid) return false

            // Malformed stat lines never throw
            ProcessTable.fromStat(rawStat)

            const psText = [
              `  ${rootPid}     1 00:00:01.25`,
              `  ${childPid} ${rootPid} 00:00:02.50`,
              `  ${grandPid} ${childPid} 1-00:00:03`,
              `  99999     1 00:01:00`
            ].join("\n")
            const psEntries = ProcessTable.fromPs(psText)
            const tree = ProcessTable.treeOf(psEntries, rootPid)
            if (!tree.pids.includes(rootPid) || !tree.pids.includes(childPid) || !tree.pids.includes(grandPid)) return false
            if (tree.pids.includes(99999)) return false

            const meter = Cpu.meterOf(rootPid)
            Cpu.observe(meter, [p1, p2])
            const ms1 = Cpu.cpuMsOf(meter)
            Cpu.observe(meter, [p1, { ...p2, cpuMs: p2.cpuMs + 50 }])
            const ms2 = Cpu.cpuMsOf(meter)
            if (ms2 < ms1) return false

            const bucket: Cpu.CpuBucket = { ms: 0, seen: false }
            if (Cpu.usedBy(bucket) !== undefined) return false
            Cpu.addTo(bucket, ms2)
            if (Cpu.usedBy(bucket) !== ms2) return false

            if (ProcessTable.workOver(elapsedMs) <= 0) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Failures, Names, DiskSpace & Tools classify outputs, escape sequences, versions & sizes deterministically", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ansiText: Schema.String.pipe(Schema.check(Schema.isMaxLength(120))),
        exitCode: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
        signal: Schema.Literals(["SIGTERM", "SIGKILL", "SIGINT", "SIGSEGV", "UNKNOWN"]),
        bytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50_000_000_000 }))),
        minutes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 120 }))),
        tool: Schema.Literals(["node", "pnpm", "bun", "rust", "zig", "go", "python", "custom-tool"]),
        verAsked: Schema.Literals(["22", "22.1", "22.1.0", "1.80"]),
        verFound: Schema.Literals(["v22.1.0", "22.2.0", "1.80.1", "no-version"]),
        host: Schema.Literals(["linux", "darwin", "win32", "freebsd"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ansiText, exitCode, signal, bytes, minutes, tool, verAsked, verFound, host }) =>
          Effect.sync(() => {
            const withAnsi = `\x1b[31mError: ${ansiText}\x1b[0m\nsecond line`
            const clean = Failures.readable(withAnsi)
            if (clean.includes("\x1b[")) return false
            Failures.firstLine(clean)
            Failures.errorLine(clean)
            Failures.commandLine(clean)
            const reason = Failures.reasonOf({
              stdout: clean,
              stderr: `FAIL ${clean}`,
              exitCode
            })
            if (typeof reason !== "string") return false
            const noProg = Failures.noProgress(minutes)
            if (!Failures.madeNoProgress({ error: noProg })) return false
            const mark = Failures.failureMark({ error: reason, exitCode })
            if (mark.length === 0) return false
            const sigCode = Failures.signalExit(signal)
            if (sigCode < 0) return false
            Failures.printedFailure(`$ pnpm test\n${clean}\nexit code ${exitCode}`)
            if (Failures.printedLimitOf(5) <= 0) return false

            const safeName = ansiText.replace(/[\uD800-\uDFFF]/g, "x")
            Names.bytesOf(safeName)
            Names.notUtf8(safeName)
            Names.unreadableName(safeName, "deadbeef")
            if (Names.sha256(safeName).length !== 64) return false

            const sz = DiskSpace.sizeOf(bytes)
            if (sz.length === 0) return false

            if (Tools.programsOf(tool).length === 0) return false
            const parsedVer = Tools.versionIn(verFound)
            if (parsedVer !== undefined) {
              Tools.differs(verAsked, parsedVer)
            }
            if (Tools.systemName(host).length === 0) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
