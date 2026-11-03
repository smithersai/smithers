import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import type { ScanResult } from "../../../examples/use-cases/repo-janitor.vibe"
import { empty, layer, RepoJanitor } from "../../../examples/use-cases/repo-janitor.vibe"

const directory = mkdtempSync(join(tmpdir(), "repo-janitor-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const todo = (file: string, line: number) => ({
  file,
  line,
  description: `TODO from 2023 at ${file}:${line}`,
  severity: "low" as const
})

/**
 * A scanner that answers with `found`; a fixer that fixes every item it is
 * handed unless `fixNothing`; a PR author that derives its summary from the
 * totals in its prompt. Every request is recorded in order: the scan prompt,
 * each fixer's category and files, and the summary's totals.
 */
const script = (found: typeof ScanResult.Type, options: { readonly fixNothing?: boolean } = {}) => {
  const turns: Array<string> = []
  const scanned: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a repo scanner")) {
      scanned.push(asked)
      turns.push("scan")
      return found
    }
    if (asked.includes("You are a maintenance agent")) {
      const category = /\nCategory: (.+)/.exec(asked)![1]!
      const items: ReadonlyArray<{ readonly file: string }> = JSON.parse(/\nItems: (.+)/.exec(asked)![1]!)
      const files = options.fixNothing === true ? [] : items.map((i) => i.file)
      turns.push(`fix ${category}: ${items.map((i) => i.file).join(",")}`)
      return { category, filesChanged: files, fixCount: files.length, skipped: [], summary: `fixed ${files.length}` }
    }
    if (asked.includes("You are a PR author")) {
      const total = Number(/\nTotal fixes: (\d+)/.exec(asked)![1])
      const categories = /\nCategories: (.*)/.exec(asked)![1]!
      const files = /\nFiles changed: (.*)/.exec(asked)![1]!
      turns.push(`summarize ${total} in ${categories}`)
      return {
        title: `chore: ${categories} cleanup`,
        body: `Touches ${files}`,
        totalFixes: total,
        categories: categories.split(", "),
        filesChanged: files.split(", "),
        riskLevel: "low"
      }
    }
    return undefined
  }
  return { answer, scanned, turns }
}

it.effect("fixes only the category the scan reported, then writes the PR summary from the fixes", () =>
  Effect.gen(function*() {
    const { answer, scanned, turns } = script({
      category: "stale-todos",
      items: [todo("src/a.ts", 3), todo("src/b.ts", 9)],
      count: 2
    })
    const summary = yield* Kit.run(RepoJanitor, {}, {
      filename: join(directory, "fixes.sqlite"),
      executionId: "repo-janitor-fixes",
      script: answer,
      actions: layer
    })

    // The scanner got the 0.x defaults and all five categories.
    expect(scanned[0]).toContain(
      "Repo root: .\nCategories: warnings, stale-todos, broken-examples, formatting, docs\nMax items per category: 20"
    )
    // One fixer, the TODO one, handed both items; then the summary of its two fixes.
    expect(turns).toEqual(["scan", "fix stale-todos: src/a.ts,src/b.ts", "summarize 2 in stale-todos"])
    expect(summary).toEqual({
      title: "chore: stale-todos cleanup",
      body: "Touches src/a.ts, src/b.ts",
      totalFixes: 2,
      categories: ["stale-todos"],
      filesChanged: ["src/a.ts", "src/b.ts"],
      riskLevel: "low"
    })
  }))

it.effect("settles the fixed empty summary when the scan reports nothing", () =>
  Effect.gen(function*() {
    const { answer, scanned, turns } = script({ category: "warnings", items: [], count: 0 })
    const summary = yield* Kit.run(RepoJanitor, { repoRoot: "packages/web", maxItemsPerCategory: 5 }, {
      filename: join(directory, "clean.sqlite"),
      executionId: "repo-janitor-clean",
      script: answer,
      actions: layer
    })

    expect(scanned[0]).toContain("Repo root: packages/web\n")
    expect(scanned[0]).toContain("Max items per category: 5")
    expect(turns).toEqual(["scan"])
    expect(summary).toEqual(empty)
  }))

it.effect("settles the empty summary without the PR author when the fixer fixed nothing", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ category: "formatting", items: [todo("src/c.ts", 1)], count: 1 }, {
      fixNothing: true
    })
    const summary = yield* Kit.run(RepoJanitor, {}, {
      filename: join(directory, "fixed-nothing.sqlite"),
      executionId: "repo-janitor-fixed-nothing",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual(["scan", "fix formatting: src/c.ts"])
    expect(summary).toEqual(empty)
  }))
