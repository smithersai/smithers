/**
 * <BlogAnalyzerPipeline> — Ingest blog content, analyze topics, and emit structured insights.
 *
 * Pattern: Content Ingester → Analyzer → Report Sink.
 * Use cases: blog categorization, content audits, editorial insights, topic clustering.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IngestPrompt from "./prompts/blog-analyzer-pipeline/ingest.mdx";
import AnalyzePrompt from "./prompts/blog-analyzer-pipeline/analyze.mdx";
import ReportPrompt from "./prompts/blog-analyzer-pipeline/report.mdx";

const ingestSchema = z.object({
  articles: z.array(z.object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    author: z.string().optional(),
    publishedAt: z.string().optional(),
  })),
  totalIngested: z.number(),
  errors: z.array(z.string()),
});

const analyzeSchema = z.object({
  insights: z.array(z.object({
    articleId: z.string(),
    categories: z.array(z.string()),
    sentiment: z.enum(["positive", "neutral", "negative"]),
    keyTopics: z.array(z.string()),
    readabilityScore: z.number(),
  })),
  totalAnalyzed: z.number(),
  topCategories: z.array(z.object({
    category: z.string(),
    count: z.number(),
  })),
});

const reportSchema = z.object({
  summary: z.string(),
  categoryBreakdown: z.record(z.string(), z.number()),
  sentimentDistribution: z.record(z.string(), z.number()),
  topTopics: z.array(z.string()),
  recommendations: z.array(z.string()),
  totalProcessed: z.number(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  ingest: ingestSchema,
  analyze: analyzeSchema,
  report: reportSchema,
});

const ingester = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a content ingester. Read blog posts from the specified source,
extract article text, titles, and metadata. Handle different formats (HTML, Markdown, RSS)
and report any articles that could not be parsed.`,
});

const analyzer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `You are a content analyst. Classify each article into categories, detect
sentiment, extract key topics, and compute a readability score. Aggregate results into
top-level category counts.`,
});

const reporter = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a report generator. Synthesize the analysis into a structured
editorial report with category breakdowns, sentiment distribution, top topics, and
actionable recommendations for content strategy.`,
});

export default smithers((ctx) => (
  <Workflow name="blog-analyzer-pipeline">
    <Sequence>
      <Task id="ingest" output={outputs.ingest} agent={ingester}>
        <IngestPrompt
          source={ctx.input.source}
          format={ctx.input.format ?? "auto-detect"}
          limit={ctx.input.limit ?? 50}
        />
      </Task>

      <Task id="analyze" output={outputs.analyze} agent={analyzer} deps={{ ingest: outputs.ingest }}>
        {(deps) => (
          <AnalyzePrompt
            totalIngested={deps.ingest.totalIngested}
            articles={deps.ingest.articles.slice(0, 5)}
            remainingCount={Math.max(deps.ingest.totalIngested - 5, 0)}
            categories={ctx.input.categories ?? []}
          />
        )}
      </Task>

      <Task id="report" output={outputs.report} agent={reporter} deps={{ analyze: outputs.analyze }}>
        {(deps) => (
          <ReportPrompt
            totalAnalyzed={deps.analyze.totalAnalyzed}
            insights={deps.analyze.insights.slice(0, 5)}
            topCategories={deps.analyze.topCategories}
            outputFormat={ctx.input.outputFormat ?? "markdown"}
          />
        )}
      </Task>
    </Sequence>
  </Workflow>
));
