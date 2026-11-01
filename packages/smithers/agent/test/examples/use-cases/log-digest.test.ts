import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import { layer, LogDigest } from "../../../examples/use-cases/log-digest.vibe"

const directory = mkdtempSync(join(tmpdir(), "log-digest-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A collector that reports one error line per log path it was handed, and an
 * analyst that cites the error lines it was handed as its evidence. With
 * `broken`, the collector answers off-schema. Every request is recorded in
 * order.
 */
const script = (broken = false) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const collect = /Log paths: (.+)\nCommands: (.+)\nTail lines: (\d+)/.exec(asked)
    if (collect !== null) {
      const paths: ReadonlyArray<string> = JSON.parse(collect[1]!)
      const commands: ReadonlyArray<string> = JSON.parse(collect[2]!)
      turns.push(`collect ${paths.length} paths, ${commands.length} commands, tail ${collect[3]}`)
      if (broken) return { lines: "everything" }
      return {
        source: [...paths, ...commands].join(", ") || "nothing",
        lineCount: 400,
        errorLines: paths.map((path) => `${path}: ECONNREFUSED 10.0.0.7:5432`),
        warningLines: ["deprecated flag --legacy-peer-deps"],
        rawTail: "npm ERR! code 1"
      }
    }
    const digest = /Source: (.+)\nLine count: \d+\nError lines: (.+)/.exec(asked)
    if (digest !== null) {
      const errorLines: ReadonlyArray<string> = JSON.parse(digest[2]!)
      turns.push(`summarize ${digest[1]}`)
      return {
        rootCauseHypotheses: [{
          hypothesis: "The database was not reachable",
          confidence: "high",
          evidence: errorLines
        }],
        likelyOwner: { team: "platform", reasoning: `connection refused in ${digest[1]}` },
        nextCommands: [{ command: "pg_isready -h 10.0.0.7", purpose: "Check the database answers" }],
        summary: `${errorLines.length} connection errors`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("hands the collected error lines to the analyst", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const digest = yield* Kit.run(LogDigest, {
      logPaths: ["build.log", "deploy.log"],
      commands: ["kubectl logs deploy/api"],
      tailLines: 50
    }, {
      filename: join(directory, "digest.sqlite"),
      executionId: "log-digest-main",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      "collect 2 paths, 1 commands, tail 50",
      "summarize build.log, deploy.log, kubectl logs deploy/api"
    ])
    // The analyst's evidence is the collector's error lines, carried through.
    expect(digest.rootCauseHypotheses[0]?.evidence).toEqual([
      "build.log: ECONNREFUSED 10.0.0.7:5432",
      "deploy.log: ECONNREFUSED 10.0.0.7:5432"
    ])
    expect(digest.likelyOwner.reasoning).toBe("connection refused in build.log, deploy.log, kubectl logs deploy/api")
    expect(digest.summary).toBe("2 connection errors")
  }))

it.effect("collects with no paths, no commands and a 100-line tail by default", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const digest = yield* Kit.run(LogDigest, {}, {
      filename: join(directory, "defaults.sqlite"),
      executionId: "log-digest-defaults",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual(["collect 0 paths, 0 commands, tail 100", "summarize nothing"])
    expect(digest.rootCauseHypotheses[0]?.evidence).toEqual([])
  }))

it.effect("fails without asking the analyst when the collection is off-schema", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(LogDigest, { logPaths: ["build.log"] }, {
      filename: join(directory, "broken.sqlite"),
      executionId: "log-digest-broken",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(turns).toContain("collect 1 paths, 0 commands, tail 100")
    expect(turns.some((turn) => turn.startsWith("summarize"))).toBe(false)
  }))
