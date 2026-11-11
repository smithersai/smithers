/**
 * Ingest blog posts, analyze their topics and sentiment, and report editorial insights.
 *
 * Port of the 0.x `blog-analyzer-pipeline.jsx`. Three agents run in sequence:
 * an ingester reads up to `limit` posts (default 50) from the source, an
 * analyst classifies the first five articles and is told how many it was not
 * shown, and a reporter turns the first five insights and the top categories
 * into an editorial report.
 *
 * 0.x's prompts were placeholders that printed their props; these prompts state the same props.
 * 0.x gave the ingester `read`, `bash` and `grep` and the reporter `bash`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** How many articles and insights each later step is shown. */
export const sampleSize = 5

/** One ingested article. */
export const Article = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.String,
  author: Schema.optional(Schema.String),
  publishedAt: Schema.optional(Schema.String)
})

/** What the ingester read. */
export const Ingest = Schema.Struct({
  articles: Schema.Array(Article),
  totalIngested: Schema.Number,
  errors: Schema.Array(Schema.String)
})

/** One article's analysis. */
export const Insight = Schema.Struct({
  articleId: Schema.String,
  categories: Schema.Array(Schema.String),
  sentiment: Schema.Literals(["positive", "neutral", "negative"]),
  keyTopics: Schema.Array(Schema.String),
  readabilityScore: Schema.Number
})

/** What the analyst found. */
export const Analysis = Schema.Struct({
  insights: Schema.Array(Insight),
  totalAnalyzed: Schema.Number,
  topCategories: Schema.Array(Schema.Struct({ category: Schema.String, count: Schema.Number }))
})

/** The editorial report the flow settles with. */
export const Report = Schema.Struct({
  summary: Schema.String,
  categoryBreakdown: Schema.Record(Schema.String, Schema.Number),
  sentimentDistribution: Schema.Record(Schema.String, Schema.Number),
  topTopics: Schema.Array(Schema.String),
  recommendations: Schema.Array(Schema.String),
  totalProcessed: Schema.Number
})

/** Reads the posts from the source. */
export const IngestPosts = AgentAction.make("examples/BlogAnalyzerPipeline/Ingest", {
  payload: { source: Schema.String, format: Schema.String, limit: Schema.Number },
  output: Ingest,
  seat,
  system: [
    `You are a content ingester. Read blog posts from the specified source,
extract article text, titles, and metadata. Handle different formats (HTML, Markdown, RSS)
and report any articles that could not be parsed.`
  ],
  prompt: ({ format, limit, source }) => `Ingest up to ${limit} blog posts.\n\nSource: ${source}\nFormat: ${format}`
})

/** Classifies the sampled articles. */
export const AnalyzePosts = AgentAction.make("examples/BlogAnalyzerPipeline/Analyze", {
  payload: {
    totalIngested: Schema.Number,
    articles: Schema.Array(Article),
    remainingCount: Schema.Number,
    categories: Schema.Array(Schema.String)
  },
  output: Analysis,
  seat,
  system: [
    `You are a content analyst. Classify each article into categories, detect
sentiment, extract key topics, and compute a readability score. Aggregate results into
top-level category counts.`
  ],
  prompt: ({ articles, categories, remainingCount, totalIngested }) =>
    `Analyze these articles.\n\nTotal ingested: ${totalIngested}\nNot shown: ${remainingCount}\nCategories: ${
      categories.length > 0 ? categories.join(", ") : "any"
    }\nArticles: ${JSON.stringify(articles)}`
})

/** Writes the editorial report. */
export const ReportInsights = AgentAction.make("examples/BlogAnalyzerPipeline/Report", {
  payload: {
    totalAnalyzed: Schema.Number,
    insights: Schema.Array(Insight),
    topCategories: Analysis.fields.topCategories,
    outputFormat: Schema.String
  },
  output: Report,
  seat,
  system: [
    `You are a report generator. Synthesize the analysis into a structured
editorial report with category breakdowns, sentiment distribution, top topics, and
actionable recommendations for content strategy.`
  ],
  prompt: ({ insights, outputFormat, topCategories, totalAnalyzed }) =>
    `Write the editorial report as ${outputFormat}.\n\nTotal analyzed: ${totalAnalyzed}\nTop categories: ${
      JSON.stringify(topCategories)
    }\nInsights: ${JSON.stringify(insights)}`
})

/** The analyst's sample of the ingest. Pure, so it is a `Node.map`, not a step. */
const sample = ({ ingest }: { readonly ingest: typeof Ingest.Type }) => ({
  totalIngested: ingest.totalIngested,
  articles: ingest.articles.slice(0, sampleSize),
  remainingCount: Math.max(ingest.totalIngested - sampleSize, 0)
})

/** The pipeline: ingest, analyze a sample, report. */
export const BlogAnalyzerPipeline = Flow.make("examples/BlogAnalyzerPipeline", {
  payload: {
    source: Schema.String,
    format: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
    categories: Schema.optional(Schema.Array(Schema.String)),
    outputFormat: Schema.optional(Schema.String)
  },
  success: Report,
  error: AgentAction.AgentFailure,
  body: ({ categories = [], format = "auto-detect", limit = 50, outputFormat = "markdown", source }) =>
    Node.bindPlanned(
      IngestPosts.call({ source, format, limit }),
      (ingest: Planned.Planned<typeof Ingest.Type>) =>
        Node.bindPlanned(
          Node.map(Node.succeed({ ingest }), sample),
          (sampled: Planned.Planned<ReturnType<typeof sample>>) =>
            Node.bindPlanned(
              AnalyzePosts.call({
                totalIngested: sampled.totalIngested,
                articles: sampled.articles,
                remainingCount: sampled.remainingCount,
                categories
              }),
              (analysis: Planned.Planned<typeof Analysis.Type>) =>
                Node.bindPlanned(
                  Node.map(Node.succeed({ analysis }), ({ analysis }) => analysis.insights.slice(0, sampleSize)),
                  (insights: Planned.Planned<ReadonlyArray<typeof Insight.Type>>) =>
                    ReportInsights.call({
                      totalAnalyzed: analysis.totalAnalyzed,
                      insights,
                      topCategories: analysis.topCategories,
                      outputFormat
                    })
                )
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(IngestPosts.layer, AnalyzePosts.layer, ReportInsights.layer)
