import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BuildFailed,
  BuildTarget,
  DefendingCode,
  layer,
  targetSource
} from "../../../examples/use-cases/defending-code.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "defending-code-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** A build that records what it compiled, and fails or reports `ok` as told. */
const build = (built: Array<string>, outcome: "ok" | "not-ok" | "broken" = "ok") =>
  BuildTarget.toLayer(({ binary, source, work }) =>
    Effect.gen(function*() {
      built.push(`${source} -> ${binary}`)
      if (outcome === "broken") return yield* Effect.fail(new BuildFailed({ log: "clang: error: no input files" }))
      return { ok: outcome === "ok", binaryPath: binary, sourcePath: `${work}/card_parser.c`, log: "" }
    })
  )

/** The planted bug each subsystem has, by crash site. */
const sites: Record<string, string> = {
  name: "card_parser.c:31 in parse_name",
  email: "card_parser.c:48 in parse_email",
  tags: "card_parser.c:70 in parse_tags"
}

interface Options {
  /** The subsystems recon proposes, by id. */
  readonly subsystems: ReadonlyArray<string>
  /** Subsystems whose finder crashes the target. */
  readonly crashes: ReadonlyArray<string>
  /** Subsystems whose finder answers off-schema. */
  readonly brokenFinders?: ReadonlyArray<string>
  /** Subsystems the grader cannot reproduce. */
  readonly unreproduced?: ReadonlyArray<string>
}

/**
 * Agents that derive every answer from the prompt they were handed: a finder
 * crashes its subsystem's site with a PoC naming the subsystem, the grader
 * reproduces what it was shown, the judge makes one bug per verified site, and
 * the patcher fixes the bugs its prompt lists. Each request is recorded.
 */
const script = (options: Options) => {
  const asked: Array<string> = []
  const answer: Kit.Script = (text) => {
    if (text.includes("You are a security recon agent")) {
      asked.push("recon")
      return {
        subsystems: options.subsystems.map((id) => ({
          id,
          name: `${id.toUpperCase()} field`,
          hypothesis: "unbounded copy"
        })),
        notes: "three fields"
      }
    }
    const find = /Subsystem: .+ \(id: (.+)\)/.exec(text)
    if (find !== null && text.includes("You are a vulnerability-discovery agent")) {
      const id = find[1]!
      asked.push(`find ${id}`)
      if (options.brokenFinders?.includes(id)) return { unexpected: true }
      const crashed = options.crashes.includes(id.toLowerCase())
      return {
        subsystemId: id,
        crashed,
        crashKind: crashed ? "stack-buffer-overflow" : "none",
        crashSite: crashed ? sites[id.toLowerCase()]! : "",
        pocPath: `runs/r1/poc-${id}.card`,
        pocInput: `${id.toUpperCase()}: ${"A".repeat(80)}`,
        reproCount: crashed ? 3 : 0,
        attempts: 4
      }
    }
    const verify = /Reported by subsystem "(.+)": (.+) at (.+)/.exec(text)
    if (verify !== null) {
      const [, id, kind, site] = verify
      asked.push(`verify ${id}`)
      const reproduced = !(options.unreproduced ?? []).includes(id!)
      return { subsystemId: id, reproduced, reproCount: reproduced ? 3 : 0, crashKind: kind, crashSite: site, note: "" }
    }
    const verified = /Verified findings: (.+)/.exec(text)
    if (verified !== null) {
      const findings: ReadonlyArray<{ subsystemId: string; crashKind: string; crashSite: string }> = JSON.parse(
        verified[1]!
      )
      asked.push(`dedupe ${findings.map((f) => f.subsystemId).join(",")}`)
      const uniqueBugs = findings.map((f, index) => ({
        bugId: `BUG-${index + 1}`,
        crashKind: f.crashKind,
        crashSite: f.crashSite,
        rootCause: `unbounded strcpy into ${f.subsystemId}`,
        representativeSubsystemId: f.subsystemId,
        representativePoc: `${f.subsystemId.toUpperCase()}: AAAA`,
        duplicateCount: 1
      }))
      // The judge also repeats the first bug under a differently cased id.
      const repeated = uniqueBugs[0] === undefined ? [] : [{ ...uniqueBugs[0], bugId: "bug-1" }]
      return {
        uniqueBugs: [...uniqueBugs, ...repeated],
        totalVerified: findings.length,
        totalUnique: uniqueBugs.length
      }
    }
    const report = /\n(BUG-\d+): .+ at (.+)\nRoot cause/.exec(text)
    if (report !== null) {
      asked.push(`report ${report[1]}`)
      return {
        bugId: report[1],
        title: `Overflow at ${report[2]}`,
        severity: "high",
        primitive: "stack write",
        reachability: "card file",
        impact: "code execution",
        writeup: "..."
      }
    }
    if (text.includes("Fix every confirmed bug, then prove the fixes.")) {
      const bugs = [...text.matchAll(/\n- (BUG-\d+): /g)].map((m) => m[1]!)
      asked.push(`patch ${bugs.join(",")}`)
      return {
        filesChanged: ["runs/r1/card_parser.c"],
        diff: "--- a\n+++ b\n",
        bugsFixed: bugs.map((bugId) => ({ bugId, pocNoLongerCrashes: true })),
        rebuildOk: true,
        smokeTestOk: true,
        allValidated: true,
        note: "bounded every copy"
      }
    }
    return undefined
  }
  return { answer, asked }
}

it.effect("finds, verifies, dedupes, reports and patches the crashing subsystems", () =>
  Effect.gen(function*() {
    const built: Array<string> = []
    // `Name` slugs like `name`, so it gets no finder of its own.
    const { answer, asked } = script({ subsystems: ["name", "email", "tags", "Name"], crashes: ["name", "email"] })
    const summary = yield* Kit.run(DefendingCode, { runId: "r1" }, {
      filename: join(directory, "patched.sqlite"),
      executionId: "defending-code-patched",
      script: answer,
      actions: Layer.mergeAll(layer, build(built))
    })

    expect(built).toEqual([`${targetSource} -> runs/r1/card_parser`])
    expect(asked[0]).toBe("recon")
    expect(asked.filter((a) => a.startsWith("find")).sort()).toEqual(["find email", "find name", "find tags"])
    // Only the two crashes are verified, and both reach the judge.
    expect(asked.filter((a) => a.startsWith("verify")).sort()).toEqual(["verify email", "verify name"])
    expect(asked.filter((a) => a.startsWith("dedupe"))).toHaveLength(1)
    // The judge's repeated `bug-1` is dropped before reporting and patching.
    expect(asked.filter((a) => a.startsWith("report")).sort()).toEqual(["report BUG-1", "report BUG-2"])
    expect(asked.at(-1)).toBe("patch BUG-1,BUG-2")
    expect(summary).toEqual({
      subsystemsProbed: 4,
      crashesFound: 2,
      verified: 2,
      uniqueBugs: 2,
      bugsFixed: 2,
      patchValidated: true,
      headline: "Found and patched 2 unique memory-safety bug(s); all PoCs neutralized and the smoke test passes."
    })
  }))

it.effect("drops a failed finder and stops before the judge when nothing reproduces", () =>
  Effect.gen(function*() {
    const built: Array<string> = []
    const { answer, asked } = script({
      subsystems: ["name", "email", "tags"],
      crashes: ["name", "email"],
      brokenFinders: ["email"],
      unreproduced: ["name"]
    })
    const summary = yield* Kit.run(DefendingCode, { runId: "r2", fanout: 1 }, {
      filename: join(directory, "unreproduced.sqlite"),
      executionId: "defending-code-unreproduced",
      script: answer,
      actions: Layer.mergeAll(layer, build(built))
    })

    // The broken finder was asked (and re-asked) but its crash never reached the grader.
    expect(asked).toContain("find email")
    expect(asked.filter((a) => a.startsWith("verify"))).toEqual(["verify name"])
    expect(asked.some((a) => a.startsWith("dedupe") || a.startsWith("report") || a.startsWith("patch"))).toBe(false)
    expect(summary).toEqual({
      subsystemsProbed: 3,
      crashesFound: 1,
      verified: 0,
      uniqueBugs: 0,
      bugsFixed: 0,
      patchValidated: false,
      headline: "Found 0 unique memory-safety bug(s) across 1 crash(es)."
    })
  }))

it.effect("reports zeros without recon when the build is not ok", () =>
  Effect.gen(function*() {
    const built: Array<string> = []
    const { answer, asked } = script({ subsystems: ["name"], crashes: ["name"] })
    const summary = yield* Kit.run(DefendingCode, { runId: "r3" }, {
      filename: join(directory, "not-ok.sqlite"),
      executionId: "defending-code-not-ok",
      script: answer,
      actions: Layer.mergeAll(layer, build(built, "not-ok"))
    })

    expect(built).toHaveLength(1)
    expect(asked).toEqual([])
    expect(summary.subsystemsProbed).toBe(0)
    expect(summary.headline).toBe("Found 0 unique memory-safety bug(s) across 0 crash(es).")
  }))

it.effect("fails the run on a broken build", () =>
  Effect.gen(function*() {
    const built: Array<string> = []
    const { answer, asked } = script({ subsystems: ["name"], crashes: ["name"] })
    const failure = yield* Effect.flip(Kit.run(DefendingCode, { runId: "r4" }, {
      filename: join(directory, "broken.sqlite"),
      executionId: "defending-code-broken",
      script: answer,
      actions: Layer.mergeAll(layer, build(built, "broken"))
    }))

    expect(failure).toMatchObject({ _tag: "examples/DefendingCode/BuildFailed", log: "clang: error: no input files" })
    expect(asked).toEqual([])
  }))
