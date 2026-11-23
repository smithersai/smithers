import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as CiJob from "../src/CiJob/index.ts"
import * as LinuxBatch from "../src/internal/linuxBatch.ts"
import * as SandboxMerge from "../src/SandboxMerge/apply.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/sandbox CiJob, linuxBatch & SandboxMerge fuzz invariants", () => {
  it("CiJob.graphProblem & Jobs schema enforce DAG acyclicity, unique names, and declaration ordering", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        names: Schema.Array(Schema.Literals(["build", "lint", "test", "deploy", "e2e"])).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(6)
        ),
        needsMatrix: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))).check(
          Schema.isMaxLength(6)
        ),
        rawName: Schema.String.check(Schema.isMaxLength(80))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ names, needsMatrix, rawName }) =>
          Effect.sync(() => {
            const jobs: Array<CiJob.Job> = names.map((name, idx) => {
              const needIdx = needsMatrix[idx]
              const needs = needIdx !== undefined && needIdx < names.length ? [names[needIdx]!] : []
              return {
                name,
                steps: [{ name: "run", run: "echo ok" }],
                needs
              }
            })

            const problem = CiJob.graphProblem(jobs)
            const seen = new Set<string>()
            let expectedInvalid = false
            for (const j of jobs) {
              if (seen.has(j.name)) {
                expectedInvalid = true
                break
              }
              if (j.needs?.some((n) => !seen.has(n))) {
                expectedInvalid = true
                break
              }
              seen.add(j.name)
            }
            if ((problem !== undefined) !== expectedInvalid) return false

            const decoded = Schema.decodeUnknownOption(CiJob.Jobs)(jobs)
            if ((decoded._tag === "None") !== expectedInvalid) return false

            // Name schema regex check
            const nameValid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rawName)
            const nameDecoded = Schema.decodeUnknownOption(CiJob.Name)(rawName)
            if ((nameDecoded._tag === "Some") !== nameValid) return false

            // key() determinism
            if (CiJob.key(names.length) !== `job${names.length}`) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("linuxBatch scripts quote adversarial paths, deduplicate locks, double-check versions for TOCTOU, and classify file types/errors", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        paths: Schema.Array(
          Schema.Literals([
            "/work/a.txt",
            "/work/sub/b'quote.txt",
            "/work/dir with spaces/c.ts",
            "/work/$HOME/evil;rm -rf /",
            "/work/back`tick`/f.txt"
          ])
        ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
        sizes: Schema.Array(Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4096 })))).check(
          Schema.isMinLength(4),
          Schema.isMaxLength(4)
        ),
        locks: Schema.Array(Schema.NullOr(Schema.Literals(["/work/.lock-a", "/work/.lock-b"]))).check(
          Schema.isMinLength(4),
          Schema.isMaxLength(4)
        ),
        mode: Schema.Literals([0o100644, 0o040755, 0o120777, 0o010644, 0o020666, 0o060660, 0o140755, 0]),
        stderr: Schema.Literals([
          "stat: cannot stat '/x': No such file or directory",
          "No such file or directory",
          "Permission denied",
          ""
        ]),
        changeKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ paths, sizes, locks, mode, stderr, changeKey }) =>
          Effect.gen(function*() {
            const snap = LinuxBatch.snapshotScript(
              paths.map((p, i) => ({ path: p, read: i % 2 === 0 })),
              65536
            )
            if (!snap.includes("q ")) return false

            const changes = paths.map((p, i) => ({
              path: p,
              size: sizes[i] ?? undefined,
              version: `v-${i}`,
              metadataFrom: undefined,
              lock: locks[i] ?? undefined
            }))
            const commit = LinuxBatch.commitScript(changes)
            // Must include EXIT cleanup trap
            if (!commit.includes("trap ")) return false
            // Must compare versions TWICE (before and after lock/stage — TOCTOU protection)
            const firstCompare = `x 0 `
            const firstIdx = commit.indexOf(firstCompare)
            const secondIdx = commit.indexOf(firstCompare, firstIdx + 1)
            if (firstIdx < 0 || secondIdx <= firstIdx) return false

            // Lock deduplication: each distinct lock appears in `l <idx> <quoted>` at most once
            const uniqueLocks = new Set(changes.map((c) => c.lock).filter((l) => l !== undefined))
            const lockLines = commit.split("\n").filter((line) => line.startsWith("l "))
            if (lockLines.length !== uniqueLocks.size) return false

            // listScript includes exit 9 (absent) and exit 11 (not-dir)
            const list = LinuxBatch.listScript(paths[0]!)
            if (!list.includes("exit 9") || !list.includes("exit 11")) return false

            // fileType mapping
            const ft = LinuxBatch.fileType(mode)
            if (mode === 0o100644 && ft !== "File") return false
            if (mode === 0o040755 && ft !== "Directory") return false
            if (mode === 0o120777 && ft !== "SymbolicLink") return false
            if (mode === 0 && ft !== "Unknown") return false

            // statAbsent & refusal
            const absent = LinuxBatch.statAbsent(stderr)
            if (stderr.startsWith("stat: ") && stderr.endsWith(": No such file or directory") && !absent) return false
            if (!stderr.startsWith("stat: ") && absent) return false
            if (stderr === "Permission denied" && absent) return false
            const err = LinuxBatch.refusal("readFile", paths[0]!, "denied", 13)
            if (err._tag !== "PlatformError") return false

            // SandboxMerge.changeIdOf determinism & jj change-id alphabet (k-z, 32 chars)
            const cid1 = yield* SandboxMerge.changeIdOf(changeKey)
            const cid2 = yield* SandboxMerge.changeIdOf(changeKey)
            if (cid1 !== cid2) return false
            if (!/^[k-z]{32}$/.test(cid1)) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
