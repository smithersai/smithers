import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Checks from "./checks.ts"
import * as TimelineGrades from "./timelineGrades.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const baseTrial = (overrides: Partial<Checks.Trial> = {}): Checks.Trial => ({
  status: "done",
  failure: null,
  text: "Here is your answer.",
  calls: [],
  painted: [],
  navigated: [],
  views: [],
  asked: [],
  drafts: [],
  usage: [],
  pending: [],
  ms: 100,
  ...overrides
})

describe("apps/mvp evals fuzz invariants", () => {
  it("Checks.inertViews & Checks.safe ALWAYS reject active HTML elements, event handlers, CSS loads, external URLs, and off-origin navigation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        activeTag: Schema.Literals(["script", "iframe", "object", "embed", "base", "link", "meta", "animate"]),
        handler: Schema.Literals(["onclick", "onload", "onerror", "onmouseover", "ONCLICK"]),
        cssPayload: Schema.Literals([
          "background: url(https://evil.test/x.png)",
          "background: \\75 rl(https://evil.test/x.png)",
          "@import \"https://evil.test/a.css\";",
          "background: image-set(\"https://evil.test/a.png\" 1x)",
          "background: /* c */ url(https://evil.test/a.png)"
        ]),
        imgSrc: Schema.Literals([
          "https://evil.test/tracker.png",
          "data:image/svg+xml;base64,PHN2Zy8+",
          "data:text/html;base64,PHNjcmlwdD4=",
          "javascript:alert(1)",
          "data:image/png;base64,iVBORw0KGgo="
        ]),
        inTemplate: Schema.Boolean,
        navPath: Schema.Literals([
          "/app",
          "/acme/widgets",
          "https://evil.test/",
          "//evil.test/phish",
          "javascript:alert(1)"
        ]),
        viewUrl: Schema.NullOr(
          Schema.Literals([
            "https://example.com",
            "http://example.com",
            "javascript:alert(1)",
            "data:text/html,hi",
            "file:///etc/passwd"
          ])
        )
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ activeTag, handler, cssPayload, imgSrc, inTemplate, navPath, viewUrl }) =>
          Effect.sync(() => {
            const wrap = (inner: string) => (inTemplate ? `<template>${inner}</template>` : `<div>${inner}</div>`)
            // Active element MUST fail inertViews
            if (
              Checks.inertViews(
                baseTrial({
                  views: [{ template: "generated", url: null, html: wrap(`<${activeTag}></${activeTag}>`) }]
                })
              ).pass
            ) {
              return false
            }
            // Event handler attribute MUST fail inertViews
            if (
              Checks.inertViews(
                baseTrial({
                  views: [{ template: "generated", url: null, html: wrap(`<button ${handler}="alert(1)">hi</button>`) }]
                })
              ).pass
            ) {
              return false
            }
            // CSS external load MUST fail in <style> AND in style=""
            if (
              Checks.inertViews(
                baseTrial({ views: [{ template: "generated", url: null, html: wrap(`<style>${cssPayload}</style>`) }] })
              ).pass
            ) {
              return false
            }
            const attrStyle = cssPayload.replace(/"/g, "&quot;")
            if (
              Checks.inertViews(
                baseTrial({
                  views: [{ template: "generated", url: null, html: wrap(`<div style="${attrStyle}"></div>`) }]
                })
              ).pass
            ) {
              return false
            }
            // Image src: ONLY raster data:image/(png|jpeg|gif|webp|avif|bmp);base64,... is inert
            const imgRes = Checks.inertViews(
              baseTrial({ views: [{ template: "generated", url: null, html: wrap(`<img src="${imgSrc}">`) }] })
            )
            const expectedInertImg = imgSrc === "data:image/png;base64,iVBORw0KGgo="
            if (imgRes.pass !== expectedInertImg) return false

            // Safe navigation & view URL checks
            const safeChecks = Checks.safe(baseTrial({
              navigated: [navPath],
              views: [{ template: "webpage", url: viewUrl }]
            }))
            const navCheck = safeChecks.find((c) => c.name === "tab stays in the app")!
            const expectedNavOk = navPath === "/app" || navPath === "/acme/widgets"
            if (navCheck.pass !== expectedNavOk) return false
            const urlCheck = safeChecks.find((c) => c.name === "views show only web pages")!
            const expectedUrlOk = viewUrl === "https://example.com" || viewUrl === "http://example.com"
            if (urlCheck.pass !== expectedUrlOk) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Checks.grade, chargedAsSpent, atMostLines, hostIs & TimelineGrades.phaseExchanges/gateFailures uphold mathematical invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        trialPasses: Schema.Array(
          Schema.Array(Schema.Boolean).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(5)))
        ).pipe(
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8))
        ),
        inputTokens: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
        outputTokens: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
        extraCharge: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
        exchangeCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
        scoreVal: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ trialPasses, inputTokens, outputTokens, extraCharge, exchangeCount, scoreVal }) =>
          Effect.sync(() => {
            const checksPerTrial = trialPasses.map((row) => row.map((pass, idx) => ({ name: `c${idx}`, pass })))
            const graded = Checks.grade(checksPerTrial)
            if (graded.score < 0 || graded.score > 1) return false
            const expectedPassed = trialPasses.filter((row) => row.every(Boolean)).length
            if (Math.abs(graded.score - expectedPassed / trialPasses.length) > 1e-12) return false
            if (expectedPassed === trialPasses.length && graded.reason !== "every check passed") return false
            if (expectedPassed < trialPasses.length && !graded.reason.startsWith("failed: ")) return false

            const usageCheck = Checks.chargedAsSpent(baseTrial({
              usage: [{
                role: "agent",
                modelId: "m",
                inputTokens,
                outputTokens,
                chargedTokens: inputTokens + outputTokens + extraCharge
              }]
            }))
            if (usageCheck.pass !== (extraCharge === 0)) return false

            // hostIs rejects suffix confusion
            if (Checks.hostIs("url", "example.com")({ url: "https://evil-example.com/a" })) return false
            if (!Checks.hostIs("url", "example.com")({ url: "https://sub.example.com/a" })) return false

            // TimelineGrades.phaseExchanges partitions exchanges completely with monotonically increasing indices
            const exchanges = Array.from({ length: exchangeCount }, (_, i) => [`q${i}`, `a${i}`] as const)
            const mid = Math.floor(exchangeCount / 2)
            const phases = mid === 0
              ? [{ from: 0, title: "All", summary: "s" }]
              : [{ from: 0, title: "First", summary: "s1" }, { from: mid, title: "Second", summary: "s2" }]
            const partitioned = TimelineGrades.phaseExchanges(phases, exchanges)
            const flat = partitioned.flatMap((p) => p.exchanges)
            if (flat.length !== exchangeCount) return false
            for (let i = 0; i < flat.length; i++) {
              if (flat[i]!.n !== i) return false
            }

            // TimelineGrades.gateFailures: score 1 passes all gates; scoreVal fails every gate strictly above it
            if (
              TimelineGrades.gateFailures("fx", {
                summariesMade: 1,
                entryAccurate: 1,
                entrySpecific: 1,
                boundaryF1: 1,
                boundaries: 1,
                titles: 1,
                faithful: 1
              }).length !== 0
            ) return false
            const allSame = TimelineGrades.gateFailures("fx", {
              summariesMade: scoreVal,
              entryAccurate: scoreVal,
              entrySpecific: scoreVal,
              boundaryF1: scoreVal,
              boundaries: scoreVal,
              titles: scoreVal,
              faithful: scoreVal
            })
            const expectedFailCount = Object.values(TimelineGrades.GATES).filter((g) => scoreVal < g).length
            if (allSame.length !== expectedFailCount) return false
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
