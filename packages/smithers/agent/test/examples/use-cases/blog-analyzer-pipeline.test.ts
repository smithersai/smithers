import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BlogAnalyzerPipeline, layer } from "../../../examples/use-cases/blog-analyzer-pipeline.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "blog-analyzer-pipeline-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const article = (n: number) => ({ id: `post-${n}`, title: `Post ${n}`, content: `body ${n}` })

/**
 * An ingester that reads `count` articles, an analyst that answers one
 * "engineering" insight per ingested article, and a reporter that lists the
 * insights it is handed. Each request is recorded in order with what it carried.
 */
const script = (count: number) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const ingest = /Ingest up to (\d+) blog posts\.\n\nSource: (.+)\nFormat: (.+)/.exec(asked)
    if (ingest !== null) {
      turns.push(`ingest ${ingest[1]} from ${ingest[2]} as ${ingest[3]}`)
      return {
        articles: Array.from({ length: count }, (_, i) => article(i + 1)),
        totalIngested: count,
        errors: []
      }
    }
    const analyze = /Total ingested: (\d+)\nNot shown: (\d+)\nCategories: (.+)\nArticles: (.+)/.exec(asked)
    if (analyze !== null) {
      const articles: ReadonlyArray<{ readonly id: string }> = JSON.parse(analyze[4]!)
      turns.push(`analyze ${articles.length} of ${analyze[1]}, ${analyze[2]} not shown, categories ${analyze[3]}`)
      // One insight per ingested article, more than the reporter is shown.
      const total = Number(analyze[1])
      return {
        insights: Array.from({ length: total }, (_, i) => ({
          articleId: `post-${i + 1}`,
          categories: ["engineering"],
          sentiment: "positive",
          keyTopics: ["durability"],
          readabilityScore: 60
        })),
        totalAnalyzed: total,
        topCategories: [{ category: "engineering", count: total }]
      }
    }
    const report = /Write the editorial report as (.+)\.\n\nTotal analyzed: (\d+)\nTop categories: (.+)\nInsights: (.+)/
      .exec(asked)
    if (report !== null) {
      const insights: ReadonlyArray<{ readonly articleId: string }> = JSON.parse(report[4]!)
      turns.push(`report ${insights.length} insights as ${report[1]}`)
      return {
        summary: `Analyzed ${report[2]} posts: ${insights.map((i) => i.articleId).join(", ")}`,
        categoryBreakdown: { engineering: Number(report[2]) },
        sentimentDistribution: { positive: Number(report[2]) },
        topTopics: ["durability"],
        recommendations: ["Write more about durability."],
        totalProcessed: Number(report[2])
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("analyzes a five-article sample and tells the analyst how many it was not shown", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(7)
    const report = yield* Kit.run(BlogAnalyzerPipeline, { source: "https://blog.example/rss" }, {
      filename: join(directory, "sampled.sqlite"),
      executionId: "blog-analyzer-sampled",
      script: answer,
      actions: layer
    })

    // Defaults reach the ingester; the analyst sees five of seven articles.
    expect(turns).toEqual([
      "ingest 50 from https://blog.example/rss as auto-detect",
      "analyze 5 of 7, 2 not shown, categories any",
      "report 5 insights as markdown"
    ])
    // The reporter was handed the first five of the analyst's seven insights.
    expect(report.summary).toBe("Analyzed 7 posts: post-1, post-2, post-3, post-4, post-5")
    expect(report.totalProcessed).toBe(7)
  }))

it.effect("passes the caller's limit, format and categories, and shows a short ingest whole", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(3)
    const report = yield* Kit.run(BlogAnalyzerPipeline, {
      source: "posts/",
      format: "markdown",
      limit: 3,
      categories: ["engineering", "product"],
      outputFormat: "json"
    }, {
      filename: join(directory, "short.sqlite"),
      executionId: "blog-analyzer-short",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      "ingest 3 from posts/ as markdown",
      "analyze 3 of 3, 0 not shown, categories engineering, product",
      "report 3 insights as json"
    ])
    expect(report.summary).toBe("Analyzed 3 posts: post-1, post-2, post-3")
  }))
