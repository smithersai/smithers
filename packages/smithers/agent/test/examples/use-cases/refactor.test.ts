import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, Refactor } from "../../../examples/use-cases/refactor.vibe"

const directory = mkdtempSync(join(tmpdir(), "refactor-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const payload = {
  directory: "src",
  pattern: "var ",
  refactoring: "Replace var with const or let"
}

/**
 * An analyzer that lists `files`, each with the pattern it was handed; a
 * refactorer that answers `outcome[file]` (default `refactored`), or
 * off-schema for a `broken` one; and a verifier that passes unless told
 * otherwise. Every request is recorded: the analyzer's whole prompt, each
 * refactor as `file x occurrences`, each verify as its numbered commands.
 */
const script = (options: {
  readonly files: ReadonlyArray<string>
  readonly outcome?: Record<string, string>
  readonly verifies?: boolean
}) => {
  const analyzed: Array<string> = []
  const refactored: Array<string> = []
  const verified: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a static analysis agent")) {
      analyzed.push(asked)
      const pattern = /\nPattern: (.+)\n/.exec(asked)?.[1] ?? ""
      return {
        targets: options.files.map((file, index) => ({
          file,
          pattern,
          occurrences: index + 1,
          complexity: "simple"
        })),
        totalOccurrences: options.files.length,
        estimatedImpact: "low"
      }
    }
    const file = /Refactor "(.+)":\nPattern: .+ \((\d+) occurrences\)/.exec(asked)
    if (file !== null) {
      refactored.push(`${file[1]} x${file[2]}`)
      const outcome = options.outcome?.[file[1]!] ?? "refactored"
      if (outcome === "broken") return { unexpected: true }
      return { file: file[1], status: outcome, changes: `${outcome} ${file[1]}`, linesChanged: Number(file[2]) }
    }
    const verify = /Verify the refactoring didn't break anything:\nDirectory: .+\n1\. (.+)\n2\. (.+)\n3\. (.+)/.exec(
      asked
    )
    if (verify !== null) {
      verified.push(verify.slice(1).join(" | "))
      const passed = options.verifies ?? true
      return { typecheck: true, tests: passed, lint: true, errors: passed ? [] : ["2 suites broke"], passed }
    }
    return undefined
  }
  return { analyzed, answer, refactored, verified }
}

it.effect("refactors every listed file and verifies the result", () =>
  Effect.gen(function*() {
    const { analyzed, answer, refactored, verified } = script({
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
      outcome: { "src/c.ts": "skipped" }
    })
    const summary = yield* Kit.run(Refactor, { ...payload, example: { before: "var x = 1", after: "const x = 1" } }, {
      filename: join(directory, "verified.sqlite"),
      executionId: "refactor-verified",
      script: answer,
      actions: layer
    })

    expect(analyzed).toHaveLength(1)
    expect(analyzed[0]).toContain("Example: \nBefore: var x = 1\nAfter: const x = 1")
    // One refactor per target, each told its own occurrence count.
    expect([...refactored].sort()).toEqual(["src/a.ts x1", "src/b.ts x2", "src/c.ts x3"])
    // The verifier ran once, with the default commands.
    expect(verified).toEqual(["npx tsc --noEmit | npm test | npx eslint ."])
    expect(summary).toEqual({
      totalTargets: 3,
      refactored: 2,
      skipped: 1,
      failed: 0,
      verified: true,
      summary: "Refactored 2/3 files. Verification: passed"
    })
  }))

it.effect("drops a failed refactor and reports a failing verification", () =>
  Effect.gen(function*() {
    const { answer, refactored, verified } = script({
      files: ["src/a.ts", "src/b.ts"],
      outcome: { "src/a.ts": "broken", "src/b.ts": "failed" },
      verifies: false
    })
    const summary = yield* Kit.run(Refactor, { ...payload, testCmd: "pnpm vitest run" }, {
      filename: join(directory, "dropped.sqlite"),
      executionId: "refactor-dropped",
      script: answer,
      actions: layer
    })

    // The broken refactor was asked (and re-asked for a correction) and then
    // dropped; the one that answered still counts, so the verifier ran.
    expect(refactored).toContain("src/a.ts x1")
    expect(refactored).toContain("src/b.ts x2")
    expect(verified).toEqual(["npx tsc --noEmit | pnpm vitest run | npx eslint ."])
    expect(summary).toEqual({
      totalTargets: 2,
      refactored: 0,
      skipped: 0,
      failed: 1,
      verified: false,
      summary: "Refactored 0/2 files. Verification: pending/failed"
    })
  }))

it.effect("skips the verifier when the analyzer finds nothing", () =>
  Effect.gen(function*() {
    const { analyzed, answer, refactored, verified } = script({ files: [] })
    const summary = yield* Kit.run(Refactor, payload, {
      filename: join(directory, "nothing.sqlite"),
      executionId: "refactor-nothing",
      script: answer,
      actions: layer
    })

    expect(analyzed[0]).toContain("Example: N/A")
    expect(refactored).toEqual([])
    expect(verified).toEqual([])
    expect(summary).toEqual({
      totalTargets: 0,
      refactored: 0,
      skipped: 0,
      failed: 0,
      verified: false,
      summary: "Refactored 0/0 files. Verification: pending/failed"
    })
  }))
