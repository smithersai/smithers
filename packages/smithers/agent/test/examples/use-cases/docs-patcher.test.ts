import { afterAll, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AffectedDoc, PullRequestRequest, SurfaceChange } from "../../../examples/use-cases/docs-patcher.ts"
import { DocsPatcher, layer } from "../../../examples/use-cases/docs-patcher.ts"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "docs-patcher-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const renamed: typeof SurfaceChange.Type = {
  kind: "cli",
  name: "build --out",
  before: "smthrs build --out dist",
  after: "smthrs build --output dist",
  file: "src/cli/build.ts"
}

const stale = (path: string): typeof AffectedDoc.Type => ({
  path,
  reason: "uses --out",
  staleSnippets: ["smthrs build --out dist"]
})

/**
 * A drift agent that answers with `changes` and `affected`; a patch agent that
 * rewrites every stale snippet it is handed to the change's new form; a
 * verifier that checks each patch it is handed. Every step, the host's pull
 * request included, appends to one shared `log` in the order it ran.
 */
const script = (
  changes: ReadonlyArray<typeof SurfaceChange.Type>,
  affected: ReadonlyArray<typeof AffectedDoc.Type>,
  severity: "breaking" | "notable" | "minor"
) => {
  const log: Array<string> = []
  const detected: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You detect public API and CLI surface changes")) {
      log.push("detect")
      detected.push(asked)
      return { changes, affectedDocs: affected, severity, summary: `${changes.length} surface changes` }
    }
    if (asked.includes("You patch documentation files to reflect API/CLI changes")) {
      const handed: ReadonlyArray<typeof SurfaceChange.Type> = JSON.parse(/\nChanges: (.+)/.exec(asked)![1]!)
      const docs: ReadonlyArray<typeof AffectedDoc.Type> = JSON.parse(/\nAffected docs: (.+)/.exec(asked)![1]!)
      log.push(`patch ${docs.map((d) => d.path).join(",")}`)
      return {
        patches: docs.map((doc) => ({
          docPath: doc.path,
          hunks: handed.map((change) => ({ before: change.before, after: change.after }))
        })),
        filesChanged: docs.map((doc) => doc.path),
        summary: `patched ${docs.length} docs`
      }
    }
    if (asked.includes("You verify patched docs for correctness")) {
      const patches: ReadonlyArray<{ readonly docPath: string }> = JSON.parse(/\nPatches: (.+)/.exec(asked)![1]!)
      log.push(`verify ${patches.map((p) => p.docPath).join(",")}`)
      return {
        allValid: true,
        results: patches.map((p) => ({ docPath: p.docPath, valid: true, issues: [] })),
        brokenLinks: [],
        staleReferences: []
      }
    }
    return undefined
  }
  const opened: Array<typeof PullRequestRequest.Type> = []
  const actions = layer({
    createPullRequest: (request) =>
      Effect.sync(() => {
        log.push(`pr ${request.filesChanged.join(",")}`)
        opened.push(request)
        return {
          branch: "docs/patch-surface",
          title: `docs: follow ${request.severity} surface changes`,
          checklist: request.filesChanged.map((file) => `[x] ${file}`),
          created: !request.dryRun,
          summary: request.summary
        }
      })
  })
  return { actions, answer, detected, log, opened }
}

it.effect("patches the docs the drift names, then verifies and opens the follow-up pull request", () =>
  Effect.gen(function*() {
    const { actions, answer, detected, log, opened } = script(
      [renamed],
      [stale("docs/cli.mdx"), stale("README.md")],
      "breaking"
    )
    const output = yield* Kit.run(DocsPatcher, {}, {
      filename: join(directory, "patches.sqlite"),
      executionId: "docs-patcher-patches",
      script: answer,
      actions
    })

    // The drift agent got the 0.x defaults.
    expect(detected[0]).toContain("Base branch: main\nDoc globs: docs/**/*.mdx, README.md\nScope: all")
    // Detect, then one patch of both docs, then verify and the PR in either order.
    expect(log.slice(0, 2)).toEqual(["detect", "patch docs/cli.mdx,README.md"])
    expect([...log.slice(2)].sort()).toEqual(["pr docs/cli.mdx,README.md", "verify docs/cli.mdx,README.md"])
    // The PR carries the drift's severity and the patch's files.
    expect(opened).toEqual([{
      filesChanged: ["docs/cli.mdx", "README.md"],
      summary: "patched 2 docs",
      severity: "breaking",
      repo: null,
      dryRun: false
    }])
    expect(output.patch.patches[0]?.hunks).toEqual([{
      before: "smthrs build --out dist",
      after: "smthrs build --output dist"
    }])
    expect(output.verification.allValid).toBe(true)
    expect(output.pullRequest).toMatchObject({
      title: "docs: follow breaking surface changes",
      checklist: ["[x] docs/cli.mdx", "[x] README.md"],
      created: true
    })
  }))

it.effect("still patches and asks for the pull request when nothing drifted, as 0.x did", () =>
  Effect.gen(function*() {
    const { actions, answer, detected, log, opened } = script([], [], "minor")
    const output = yield* Kit.run(
      DocsPatcher,
      { baseBranch: "release", scope: "cli", repo: "acme/tool", dryRun: true },
      {
        filename: join(directory, "no-drift.sqlite"),
        executionId: "docs-patcher-no-drift",
        script: answer,
        actions
      }
    )

    expect(detected[0]).toContain("Base branch: release\n")
    expect(detected[0]).toContain("Scope: cli")
    expect(log).toContain("patch ")
    expect(opened).toEqual([{
      filesChanged: [],
      summary: "patched 0 docs",
      severity: "minor",
      repo: "acme/tool",
      dryRun: true
    }])
    expect(output.pullRequest.created).toBe(false)
  }))

it.effect("stops before patching when the drift agent never answers on schema", () =>
  Effect.gen(function*() {
    const { actions, answer, log, opened } = script([renamed], [stale("docs/cli.mdx")], "notable")
    const exit = yield* Effect.exit(Kit.run(DocsPatcher, {}, {
      filename: join(directory, "drift-fails.sqlite"),
      executionId: "docs-patcher-drift-fails",
      script: (asked) =>
        asked.includes("You detect public API and CLI surface changes") ? { severity: "huge" } : answer(asked),
      actions
    }))

    expect(Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined).toMatchObject({
      _tag: "Some",
      value: { _tag: "/harness/StructuredOutputFailure" }
    })
    expect(log).toEqual([])
    expect(opened).toEqual([])
  }))
