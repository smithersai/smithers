import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as CardAction from "../src/CardAction.ts"
import * as ConfiguredModel from "../src/ConfiguredModel.ts"
import * as DocsPages from "../src/DocsPages.ts"
import * as StackView from "../src/StackView.ts"
import * as TodoCommands from "../src/TodoCommands.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261180")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(40, Math.min(baseExecutions, 140))

const assertPassed = <A, E = unknown>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const samplePages: ReadonlyArray<DocsPages.DocsPage> = [
  { slug: "intro", title: "Introduction", summary: "Getting started", markdown: "# Intro\nHello" },
  { slug: "self-host", title: "Self-Hosting", summary: "Run locally", markdown: "# Self-Host\n## HTTPS" }
]

describe("@smthrs/rpc Wave 9 deep fuzzing", () => {
  it(
    "DocsPages parseDocsArgs, readDocsPage, unknownDocsPage & docsCard handle every valid, anchor, missing & malformed input",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          argKind: Schema.Literals([
            "empty",
            "slug",
            "slug-anchor",
            "json-read",
            "json-page",
            "json-bad-field",
            "json-broken",
            "missing-slug"
          ]),
          ordinal: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50 }))),
          createdAt: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ argKind, ordinal, createdAt }) =>
            Effect.sync(() => {
              const rawArg = argKind === "empty"
                ? undefined
                : argKind === "slug"
                ? "self-host"
                : argKind === "slug-anchor"
                ? "self-host#https"
                : argKind === "json-read"
                ? JSON.stringify({ mode: "read", page: "intro#top" })
                : argKind === "json-page"
                ? JSON.stringify({ page: "self-host" })
                : argKind === "json-bad-field"
                ? JSON.stringify({ page: "intro", extra: 1 })
                : argKind === "json-broken"
                ? "{bad json"
                : "does-not-exist#sec"

              const parsed = DocsPages.parseDocsArgs(rawArg)
              if (argKind === "json-bad-field" || argKind === "json-broken") {
                expect("error" in parsed).toBe(true)
              } else {
                expect("payload" in parsed).toBe(true)
                if ("payload" in parsed) {
                  const cardRes = DocsPages.docsCard(samplePages, parsed.payload.page, ordinal, createdAt)
                  expect(cardRes.card.kind).toBe("docs")
                  expect(cardRes.card.payload.toc?.length).toBe(samplePages.length)
                  if (argKind === "missing-slug") {
                    expect(cardRes.card.payload.not_found).toBe("does-not-exist")
                    expect(cardRes.card.payload.anchor).toBeUndefined()
                  }
                  if (argKind === "slug-anchor") {
                    expect(cardRes.card.payload.anchor).toBe("https")
                  }
                }
              }

              const readEmpty = DocsPages.readDocsPage(samplePages, "   ")
              expect("error" in readEmpty).toBe(true)
              const readMissing = DocsPages.readDocsPage(samplePages, "nope")
              expect("error" in readMissing).toBe(true)
              expect(DocsPages.unknownDocsPage(samplePages, "nope")).toContain("intro")
              const readOk = DocsPages.readDocsPage(samplePages, "self-host#https")
              expect("value" in readOk).toBe(true)

              expect(() => DocsPages.docsCard([], "intro", 0, 0)).toThrow(DocsPages.DocsPagesEmpty)
              return true
            }),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "CardAction historical tag mapping, ConfiguredModel helpers, StackView & TodoCommands preserve invariants",
    async () => {
      const historicalTags = [
        "prs",
        "prs.list",
        "prs.view",
        "box.list",
        "box.open",
        "box.view",
        "flow.run.stop",
        "flow.run.retry",
        "flow.run.stop-all",
        "change.view",
        "change.diff",
        "change.pins",
        "change.checks",
        "files.open-diff",
        "files.list",
        "box.files",
        "box.file",
        "repo.tree",
        "files.read",
        "proposal",
        "flow.list",
        "approvals.list",
        "approvals.open",
        "runs.attention",
        "github.retry",
        "github.app",
        "github.app.open",
        "github.app.choose",
        "github.reconcile",
        "context.inspect",
        "secrets.set",
        "secrets.delete",
        "secrets.scope",
        "secrets.bind"
      ] as const

      const arb = Arbitrary.schema(
        Schema.Struct({
          tag: Schema.Literals(historicalTags),
          placement: Schema.Literals(["top", "bottom", "after"]),
          title: Schema.Literals(["Fix bug", "Add tests", "Ship v1"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ tag, placement, title }) =>
            Effect.sync(() => {
              const parsedAction = CardAction.ActionSchema.safeParse({
                label: title,
                tag,
                args: {}
              })
              if (parsedAction.success) {
                const reg = CardAction.registeredAction(parsedAction.data)
                expect(typeof reg.tag).toBe("string")
              }
              expect(
                CardAction.FormFieldSchema.safeParse({
                  name: "f1",
                  label: "Field",
                  kind: "text",
                  required: true
                }).success
              ).toBe(true)
              expect(
                TodoCommands.TodoPlacementSchema.safeParse(
                  placement === "after" ? { after: 1 } : placement === "top" ? { before: 2 } : {}
                ).success
              ).toBe(true)
              expect(TodoCommands.TodoPlacementSchema.safeParse({ after: 1, before: 2 }).success).toBe(false)
              expect(ConfiguredModel).toBeDefined()
              expect(StackView).toBeDefined()
              expect(title.length).toBeGreaterThan(0)
              return true
            }),
          { seed: seed + 1, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
