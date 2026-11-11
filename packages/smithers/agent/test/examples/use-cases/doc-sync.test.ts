import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Discrepancy, PullRequestRequest } from "../../../examples/use-cases/doc-sync.vibe"
import { DocSync, layer } from "../../../examples/use-cases/doc-sync.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "doc-sync-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const discrepancy = (
  docFile: string,
  severity: (typeof Discrepancy.Type)["severity"]
): typeof Discrepancy.Type => ({
  docFile,
  codeFile: docFile.replace("docs/", "src/").replace(".mdx", ".ts"),
  issue: "outdated-api",
  description: `${docFile} names a removed option`,
  severity
})

/**
 * An auditor that answers with `found`, and a fixer whose status for each doc
 * is `outcomes[docFile]` (`broken` answers off-schema). Every audit prompt and
 * every fixer request is recorded, the fixer's as `docFile <- codeFile`.
 */
const script = (
  found: ReadonlyArray<typeof Discrepancy.Type>,
  outcomes: Readonly<Record<string, "fixed" | "needs-human" | "skipped" | "broken">>
) => {
  const audited: Array<string> = []
  const fixed: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a docs auditor")) {
      audited.push(asked)
      return { discrepancies: found, totalDocsChecked: 12 }
    }
    if (asked.includes("You are a technical writer")) {
      const file = /\nFile: (.+)/.exec(asked)?.[1] ?? ""
      const code = /\nReference code: (.+)/.exec(asked)?.[1] ?? ""
      fixed.push(`${file} <- ${code}`)
      const outcome = outcomes[file] ?? "skipped"
      if (outcome === "broken") return { unexpected: true }
      return { file, changes: `matched ${code}`, status: outcome }
    }
    return undefined
  }
  return { answer, audited, fixed }
}

/** A host that records each pull request it is asked to open and answers deterministically. */
const host = () => {
  const opened: Array<typeof PullRequestRequest.Type> = []
  return {
    opened,
    actions: layer({
      openPullRequest: (request) =>
        Effect.sync(() => {
          opened.push(request)
          return {
            branch: `${request.branchPrefix}1`,
            prUrl: "https://example.invalid/pull/7",
            filesChanged: request.files.length,
            summary: request.body
          }
        })
    })
  }
}

it.effect("fixes every non-info discrepancy and opens one pull request for the fixed docs", () =>
  Effect.gen(function*() {
    const { answer, audited, fixed } = script([
      discrepancy("docs/run.mdx", "critical"),
      discrepancy("docs/faq.mdx", "info"),
      discrepancy("docs/cli.mdx", "warning")
    ], { "docs/run.mdx": "fixed", "docs/cli.mdx": "needs-human" })
    const { actions, opened } = host()
    const output = yield* Kit.run(DocSync, {}, {
      filename: join(directory, "opens-pr.sqlite"),
      executionId: "doc-sync-opens-pr",
      script: answer,
      actions
    })

    // The auditor got the 0.x defaults.
    expect(audited).toHaveLength(1)
    expect(audited[0]).toContain("Docs directory: docs/\nSource directory: src/\nDoc format: mdx")
    // One fixer per non-info discrepancy, handed its own doc and code file.
    expect([...fixed].sort()).toEqual(["docs/cli.mdx <- src/cli.ts", "docs/run.mdx <- src/run.ts"])
    // Only the fixed doc reached the pull request.
    expect(opened).toEqual([{
      branchPrefix: "docs/auto-sync-",
      files: ["docs/run.mdx"],
      commitMessage: "docs: sync documentation with source code",
      title: "docs: auto-sync documentation",
      body: "Fixes 1 documentation discrepancies found by automated audit"
    }])
    expect(output.audit.totalDocsChecked).toBe(12)
    expect([...output.fixes].map((f) => `${f.file}: ${f.status}`).sort()).toEqual([
      "docs/cli.mdx: needs-human",
      "docs/run.mdx: fixed"
    ])
    expect(output.pullRequest).toEqual({
      branch: "docs/auto-sync-1",
      prUrl: "https://example.invalid/pull/7",
      filesChanged: 1,
      summary: "Fixes 1 documentation discrepancies found by automated audit"
    })
  }))

it.effect("opens no pull request when nothing was fixed, and passes the given directories", () =>
  Effect.gen(function*() {
    const { answer, audited, fixed } = script([
      discrepancy("docs/faq.mdx", "info"),
      discrepancy("docs/api.mdx", "warning")
    ], { "docs/api.mdx": "skipped" })
    const { actions, opened } = host()
    const output = yield* Kit.run(DocSync, { docsDir: "site/", srcDir: "lib/", format: "md" }, {
      filename: join(directory, "nothing-fixed.sqlite"),
      executionId: "doc-sync-nothing-fixed",
      script: answer,
      actions
    })

    expect(audited[0]).toContain("Docs directory: site/\nSource directory: lib/\nDoc format: md")
    expect(fixed).toEqual(["docs/api.mdx <- src/api.ts"])
    expect(opened).toEqual([])
    expect(output.fixes).toEqual([{ file: "docs/api.mdx", changes: "matched src/api.ts", status: "skipped" }])
    expect(output.pullRequest).toBeNull()
  }))

it.effect("drops a failed fixer's result and still opens the pull request for the others", () =>
  Effect.gen(function*() {
    const { answer, fixed } = script([
      discrepancy("docs/a.mdx", "critical"),
      discrepancy("docs/b.mdx", "critical"),
      discrepancy("docs/c.mdx", "warning"),
      discrepancy("docs/d.mdx", "warning")
    ], { "docs/a.mdx": "fixed", "docs/b.mdx": "broken", "docs/c.mdx": "fixed", "docs/d.mdx": "fixed" })
    const { actions, opened } = host()
    const output = yield* Kit.run(DocSync, {}, {
      filename: join(directory, "continue-on-fail.sqlite"),
      executionId: "doc-sync-continue-on-fail",
      script: answer,
      actions
    })

    // The broken fixer was asked (and re-asked for a correction) and then
    // failed; the fourth fixer still ran in the second batch of three.
    expect(fixed).toContain("docs/b.mdx <- src/b.ts")
    expect(fixed).toContain("docs/d.mdx <- src/d.ts")
    expect(output.fixes.map((f) => f.file).sort()).toEqual(["docs/a.mdx", "docs/c.mdx", "docs/d.mdx"])
    expect([...(opened[0]?.files ?? [])].sort()).toEqual(["docs/a.mdx", "docs/c.mdx", "docs/d.mdx"])
    expect(opened[0]?.body).toBe("Fixes 3 documentation discrepancies found by automated audit")
  }))

it.effect("skips the fixers and the pull request when the audit finds only info", () =>
  Effect.gen(function*() {
    const { answer, fixed } = script([discrepancy("docs/faq.mdx", "info")], {})
    const { actions, opened } = host()
    const output = yield* Kit.run(DocSync, {}, {
      filename: join(directory, "info-only.sqlite"),
      executionId: "doc-sync-info-only",
      script: answer,
      actions
    })

    expect(fixed).toEqual([])
    expect(opened).toEqual([])
    expect(output.fixes).toEqual([])
    expect(output.pullRequest).toBeNull()
  }))
