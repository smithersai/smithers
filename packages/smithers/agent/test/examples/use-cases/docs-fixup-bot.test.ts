import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrokenExample, PullRequestRequest } from "../../../examples/use-cases/docs-fixup-bot.vibe"
import { DocsFixupBot, layer } from "../../../examples/use-cases/docs-fixup-bot.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "docs-fixup-bot-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const broken = (docPath: string, snippet: string): typeof BrokenExample.Type => ({
  docPath,
  lineRange: { start: 10, end: 12 },
  language: "ts",
  snippet,
  error: `${snippet} does not resolve`,
  category: "import"
})

/**
 * A scanner that answers with `found`; a repair agent that fixes every
 * snippet it is handed except those in `unfixable`; a verifier that flags a
 * regression for each doc in `regressing`. Every step, the host's pull request
 * included, appends to one shared `log` in the order it ran.
 */
const script = (
  found: ReadonlyArray<typeof BrokenExample.Type>,
  options: { readonly unfixable?: ReadonlyArray<string>; readonly regressing?: ReadonlyArray<string> } = {}
) => {
  const log: Array<string> = []
  const scanned: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You scan documentation files for broken code examples")) {
      log.push("scan")
      scanned.push(asked)
      return { brokenExamples: found, totalDocsScanned: 40, totalBroken: found.length, summary: "scanned" }
    }
    if (asked.includes("You repair broken documentation examples")) {
      const handed: ReadonlyArray<typeof BrokenExample.Type> = JSON.parse(/Broken examples: (.+)/.exec(asked)![1]!)
      log.push(`repair ${handed.length}`)
      const fixable = handed.filter((b) => !(options.unfixable ?? []).includes(b.docPath))
      return {
        fixes: fixable.map((b) => ({
          docPath: b.docPath,
          original: b.snippet,
          fixed: `${b.snippet}.js`,
          explanation: "added the extension"
        })),
        filesChanged: fixable.map((b) => b.docPath),
        skipped: handed.filter((b) => !fixable.includes(b)).map((b) => ({ docPath: b.docPath, reason: "ambiguous" })),
        summary: `repaired ${fixable.length}`
      }
    }
    if (asked.includes("You verify that repaired documentation examples are correct")) {
      const fixes: ReadonlyArray<{ readonly docPath: string }> = JSON.parse(/\nFixes: (.+)/.exec(asked)![1]!)
      log.push(`verify ${fixes.map((f) => f.docPath).join(",")}`)
      const regressions = fixes.map((f) => f.docPath).filter((p) => (options.regressing ?? []).includes(p))
      return {
        allPassing: regressions.length === 0,
        results: fixes.map((f) => ({
          docPath: f.docPath,
          passed: !regressions.includes(f.docPath),
          issues: regressions.includes(f.docPath) ? ["type error"] : []
        })),
        regressions,
        summary: `${regressions.length} regressions`
      }
    }
    return undefined
  }
  const opened: Array<typeof PullRequestRequest.Type> = []
  const actions = layer({
    openPullRequest: (request) =>
      Effect.sync(() => {
        log.push(`pr ${request.filesChanged.join(",")}`)
        opened.push(request)
        return {
          branch: "docs/fixup",
          title: "docs: fix broken examples",
          filesChanged: request.filesChanged,
          created: !request.dryRun,
          summary: request.summary
        }
      })
  })
  return { actions, answer, log, opened, scanned }
}

it.effect("repairs what the scan found, then verifies and opens the pull request on that repair", () =>
  Effect.gen(function*() {
    const { actions, answer, log, opened, scanned } = script(
      [broken("docs/a.md", "import { run } from './run'"), broken("docs/b.md", "import { x } from './x'")],
      { unfixable: ["docs/b.md"] }
    )
    const output = yield* Kit.run(DocsFixupBot, {}, {
      filename: join(directory, "repairs.sqlite"),
      executionId: "docs-fixup-bot-repairs",
      script: answer,
      actions
    })

    // The scanner got the 0.x default globs and categories.
    expect(scanned[0]).toContain(
      "Doc globs: docs/**/*.mdx, docs/**/*.md\nSource globs: src/**/*.ts, src/**/*.tsx\nCategories: import, api, cli, syntax, dead-link"
    )
    // Scan, then one repair of both examples, then verify and the PR in either order.
    expect(log.slice(0, 2)).toEqual(["scan", "repair 2"])
    expect([...log.slice(2)].sort()).toEqual(["pr docs/a.md", "verify docs/a.md"])
    expect(opened).toEqual([{
      filesChanged: ["docs/a.md"],
      summary: "repaired 1",
      totalFixed: 1,
      skipped: [{ docPath: "docs/b.md", reason: "ambiguous" }],
      repo: null,
      dryRun: false
    }])
    expect(output.scan.totalBroken).toBe(2)
    expect(output.verification.allPassing).toBe(true)
    expect(output.pullRequest.created).toBe(true)
  }))

it.effect("opens the pull request even when the verifier finds a regression, as 0.x did", () =>
  Effect.gen(function*() {
    const { actions, answer, opened } = script([broken("docs/a.md", "import { run } from './run'")], {
      regressing: ["docs/a.md"]
    })
    const output = yield* Kit.run(DocsFixupBot, { repo: "acme/site", dryRun: true, docGlobs: ["guide/*.md"] }, {
      filename: join(directory, "regression.sqlite"),
      executionId: "docs-fixup-bot-regression",
      script: answer,
      actions
    })

    expect(output.verification).toMatchObject({ allPassing: false, regressions: ["docs/a.md"] })
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ repo: "acme/site", dryRun: true, totalFixed: 1 })
    expect(output.pullRequest.created).toBe(false)
  }))

it.effect("fails the run when the repair agent never answers on schema", () =>
  Effect.gen(function*() {
    const { actions, answer, log, opened } = script([broken("docs/a.md", "import { run } from './run'")])
    const exit = yield* Effect.exit(Kit.run(DocsFixupBot, {}, {
      filename: join(directory, "repair-fails.sqlite"),
      executionId: "docs-fixup-bot-repair-fails",
      script: (asked) => asked.includes("You repair broken documentation examples") ? { nope: true } : answer(asked),
      actions
    }))

    // Nothing ran after the failed repair: no verify, no pull request.
    expect(exit._tag).toBe("Failure")
    expect(log).toEqual(["scan"])
    expect(opened).toEqual([])
  }))
