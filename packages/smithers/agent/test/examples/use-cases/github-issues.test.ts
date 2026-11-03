import { afterAll, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Issue } from "../../../examples/use-cases/github-issues.vibe"
import { GitHubIssues, layer } from "../../../examples/use-cases/github-issues.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "github-issues-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

type Triaged = typeof Issue.Type

const issue = (number: number, type: Triaged["type"], priority: Triaged["priority"]): Triaged => ({
  number,
  title: `issue ${number}`,
  type,
  priority,
  suggestedLabels: [type]
})

/**
 * A triager that answers with `issues` for whatever repository its prompt
 * names, echoing that name back. Every triage request records the repository
 * it was asked about.
 */
const script = (issues: ReadonlyArray<unknown>) => {
  const asked: Array<string> = []
  const answer: Kit.Script = (text) => {
    const repo = /Triage every open issue in (\S+)\. Use the gh CLI/.exec(text)?.[1]
    if (repo === undefined) return undefined
    asked.push(repo)
    return { repo, issues }
  }
  return { answer, asked }
}

it.effect("groups every triaged issue into its type's column, in 0.x's column order", () =>
  Effect.gen(function*() {
    const { answer, asked } = script([
      issue(7, "feature", "P2"),
      issue(3, "bug", "P0"),
      issue(9, "chore", "P3"),
      issue(4, "bug", "P1")
    ])
    const board = yield* Kit.run(GitHubIssues, {}, {
      filename: join(directory, "board.sqlite"),
      executionId: "github-issues-board",
      script: answer,
      actions: layer
    })

    // With no repository given, the triager is asked about the default one.
    expect(asked).toEqual(["smithersai/smithers"])
    expect(board).toEqual({
      repo: "smithersai/smithers",
      total: 4,
      columns: [
        {
          name: "bug",
          cards: [{ number: 3, title: "issue 3", priority: "P0" }, { number: 4, title: "issue 4", priority: "P1" }]
        },
        { name: "feature", cards: [{ number: 7, title: "issue 7", priority: "P2" }] },
        { name: "question", cards: [] },
        { name: "chore", cards: [{ number: 9, title: "issue 9", priority: "P3" }] }
      ]
    })
  }))

it.effect("builds four empty columns for a repository with no open issues", () =>
  Effect.gen(function*() {
    const { answer, asked } = script([])
    const board = yield* Kit.run(GitHubIssues, { repo: "acme/widgets" }, {
      filename: join(directory, "empty.sqlite"),
      executionId: "github-issues-empty",
      script: answer,
      actions: layer
    })

    expect(asked).toEqual(["acme/widgets"])
    expect(board).toEqual({
      repo: "acme/widgets",
      total: 0,
      columns: ["bug", "feature", "question", "chore"].map((name) => ({ name, cards: [] }))
    })
  }))

it.effect("fails the run when the triager invents a type the board has no column for", () =>
  Effect.gen(function*() {
    const { answer, asked } = script([{ ...issue(1, "bug", "P1"), type: "epic" }])
    const exit = yield* Effect.exit(Kit.run(GitHubIssues, {}, {
      filename: join(directory, "off-schema.sqlite"),
      executionId: "github-issues-off-schema",
      script: answer,
      actions: layer
    }))

    // The off-schema answer earned a correction re-ask, then the step failed
    // with the typed failure an author handles.
    expect(asked).toContain("smithersai/smithers")
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("StructuredOutputFailure")
  }))
