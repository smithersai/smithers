// smithers-display-name: Sweep
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import {
  ForEachFeature,
  forEachFeatureMergeSchema,
  forEachFeatureResultSchema,
} from "../components/ForEachFeature";

const TOPIC_KEYS = [
  "DOCUMENTATION",
  "E2E_TESTING",
  "UNIT_TESTS",
  "OBSERVABILITY",
  "IMPLEMENTATION",
  "CLI",
] as const;

type TopicKey = (typeof TOPIC_KEYS)[number];

const TOPICS: Record<TopicKey, { name: string; prompt: string }> = {
  DOCUMENTATION: {
    name: "Documentation",
    prompt: [
      "Review documentation coverage for this feature group.",
      "",
      "Check docs/ for each feature listed. For every feature:",
      "- Verify documentation exists and is accurate.",
      "- If docs are missing, incomplete, or out of date — fix them directly.",
      "- Improve clarity, add usage examples, and correct errors.",
      "- Do NOT modify the README.",
      "",
      "You MUST succeed regardless of what you find. Fix any issues and report what you changed.",
      "Score 0–100 based on documentation completeness AFTER your fixes.",
    ].join("\n"),
  },
  E2E_TESTING: {
    name: "E2E Testing",
    prompt: [
      "Review end-to-end test coverage for this feature group.",
      "",
      "For every feature listed:",
      "- Verify an e2e test exists with ZERO mocks — real dependencies only.",
      "- Tests must cover all boundary conditions: maximum file sizes, maximum input lengths, empty inputs, extremely large inputs.",
      "- If a value can be infinite or unbounded, there must be a test case for that.",
      "- Every boundary, limit, and edge of the input domain must be exercised.",
      "",
      "If tests are missing or incomplete, write them.",
      "Score 0–100 based on boundary-condition coverage AFTER your fixes.",
    ].join("\n"),
  },
  UNIT_TESTS: {
    name: "Unit Tests",
    prompt: [
      "Review unit test coverage for this feature group.",
      "",
      "For every feature listed:",
      "- Verify unit tests exist covering every boundary condition, edge case, and error condition.",
      "- Tests must exercise: empty inputs, null/undefined, maximum values, minimum values, off-by-one, type mismatches, concurrent access (if applicable), and error/exception paths.",
      "- Each test should isolate a single behavior.",
      "",
      "If tests are missing or incomplete, write them.",
      "Score 0–100 based on edge-case coverage AFTER your fixes.",
    ].join("\n"),
  },
  OBSERVABILITY: {
    name: "Observability",
    prompt: [
      "Review observability coverage for this feature group.",
      "",
      "For every feature listed, verify the implementation has:",
      "- Structured logging at appropriate levels (debug, info, warn, error).",
      "- Distributed tracing spans with meaningful names and attributes.",
      "- Prometheus metrics where applicable (counters, histograms, gauges).",
      "- Error logging with sufficient context for debugging.",
      "",
      "If observability is missing or insufficient, add it.",
      "Score 0–100 based on observability completeness AFTER your fixes.",
    ].join("\n"),
  },
  IMPLEMENTATION: {
    name: "Implementation Quality",
    prompt: [
      "Review implementation quality for this feature group.",
      "",
      "For every feature listed, verify the implementation:",
      "- Has complete and accurate JSDoc on all public functions, types, and classes.",
      "- Is clean, production-ready code.",
      "- Prefers inlining over abstraction — only abstract if the pattern is used more than once.",
      "- Has ZERO magic strings or magic numbers — all such values must be named constants.",
      "- Has no dead code, unused imports, or commented-out code.",
      "",
      "If you see any way to improve the code, improve it.",
      "Score 0–100 based on code quality AFTER your fixes.",
    ].join("\n"),
  },
  CLI: {
    name: "CLI",
    prompt: [
      "Review CLI coverage for this feature group.",
      "",
      "For every feature listed:",
      "- Determine if the feature should be accessible via the CLI.",
      "- If it should, verify a CLI command or flag exists to use it.",
      "- Verify the CLI help text is accurate and complete.",
      "- If CLI access is missing and the feature warrants it, add it.",
      "",
      "Not every feature needs CLI access — use your judgment on applicability.",
      "Score 0–100 based on CLI coverage of applicable features AFTER your fixes.",
    ].join("\n"),
  },
};

const bootstrapSchema = z
  .object({
    features: z.record(z.string(), z.array(z.string())),
    totalGroups: z.number().int(),
    totalFeatures: z.number().int(),
  })
  .passthrough();

const sweepSummarySchema = z
  .object({
    topicsRun: z.array(z.string()),
    totalGroups: z.number().int(),
    totalTopics: z.number().int(),
    summary: z.string(),
    markdownBody: z.string(),
  })
  .passthrough();

const agentTierSchema = z.enum(["cheap", "smart", "smartTool"]).default("cheap");
type AgentTier = z.infer<typeof agentTierSchema>;

const AGENT_TIERS: Record<AgentTier, { work: (typeof agents)[keyof typeof agents]; merge: (typeof agents)[keyof typeof agents] }> = {
  cheap: { work: agents.cheapFast, merge: agents.cheapFast },
  smart: { work: agents.smart, merge: agents.smart },
  smartTool: { work: agents.smartTool, merge: agents.smart },
};

const inputSchema = z.object({
  topics: z
    .string()
    .default(TOPIC_KEYS.join(","))
    .describe("Comma-separated topic keys: DOCUMENTATION,E2E_TESTING,UNIT_TESTS,OBSERVABILITY,IMPLEMENTATION,CLI"),
  model: agentTierSchema,
  maxConcurrency: z.number().int().default(5),
});

function parseTopics(raw: string | null | undefined): TopicKey[] {
  if (!raw) return [...TOPIC_KEYS];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is TopicKey => TOPIC_KEYS.includes(s as TopicKey));
}

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  bootstrap: bootstrapSchema,
  topicResult: forEachFeatureResultSchema,
  topicMerge: forEachFeatureMergeSchema,
  sweepSummary: sweepSummarySchema,
});

export default smithers((ctx) => {
  const bootstrap = ctx.outputMaybe("bootstrap", { nodeId: "bootstrap" });
  const selectedTopics = parseTopics(ctx.input.topics);
  const tier = AGENT_TIERS[ctx.input.model ?? "cheap"];

  const summaryNeeds: Record<string, string> = {};
  const summaryDeps: Record<string, typeof forEachFeatureMergeSchema> = {};
  selectedTopics.forEach((key, i) => {
    summaryNeeds[`topic${i}`] = `${key.toLowerCase()}:merge`;
    summaryDeps[`topic${i}`] = forEachFeatureMergeSchema;
  });

  return (
    <Workflow name="sweep">
      {/* Step 1: Load feature groups from .smithers/specs/features.ts */}
      <Task id="bootstrap" output={outputs.bootstrap}>
        {async () => {
          const fs = await import("node:fs");
          const path = await import("node:path");

          const cwd = process.cwd();
          const featuresPath = path.resolve(cwd, ".smithers/specs/features.ts");

          if (!fs.existsSync(featuresPath)) {
            throw new Error(
              "Missing .smithers/specs/features.ts — run the sync-features workflow first.",
            );
          }

          const content = fs.readFileSync(featuresPath, "utf-8");
          const features: Record<string, string[]> = {};
          const groupRegex = /(\w+):\s*\[([^\]]*)\]/gs;
          let match;
          while ((match = groupRegex.exec(content)) !== null) {
            const groupName = match[1];
            const featuresStr = match[2];
            const featureList = [...featuresStr.matchAll(/"([^"]+)"/g)].map(
              (m) => m[1],
            );
            if (featureList.length > 0) {
              features[groupName] = featureList;
            }
          }

          const totalGroups = Object.keys(features).length;
          const totalFeatures = Object.values(features).reduce(
            (sum, group) => sum + group.length,
            0,
          );

          return { features, totalGroups, totalFeatures };
        }}
      </Task>

      {/* Step 2: Run each topic sequentially — each fans out over all feature groups */}
      {bootstrap ? (
        <Sequence>
          {selectedTopics.map((topicKey) => (
            <ForEachFeature
              key={topicKey}
              idPrefix={topicKey.toLowerCase()}
              agent={tier.work}
              features={bootstrap.features}
              prompt={TOPICS[topicKey].prompt}
              maxConcurrency={ctx.input.maxConcurrency ?? 5}
              mergeAgent={tier.merge}
            />
          ))}
        </Sequence>
      ) : null}

      {/* Step 3: Final summary across all topics */}
      {bootstrap ? (
        <Task
          id="sweep-summary"
          output={outputs.sweepSummary}
          agent={tier.merge}
          needs={summaryNeeds}
          deps={summaryDeps}
        >
          {(deps) => {
            const topicResults = selectedTopics.map((key, i) => ({
              key,
              name: TOPICS[key].name,
              result: deps[`topic${i}`],
            }));

            return [
              "# Sweep Summary",
              "",
              `Topics run: ${selectedTopics.length}`,
              `Feature groups: ${bootstrap.totalGroups}`,
              `Total features: ${bootstrap.totalFeatures}`,
              `Set totalGroups to ${bootstrap.totalGroups}.`,
              `Set totalTopics to ${selectedTopics.length}.`,
              `Set topicsRun to ${JSON.stringify(selectedTopics)}.`,
              "",
              "Combine the per-topic results below into a final sweep report.",
              "For each topic, summarize the key findings and changes made.",
              "Produce a markdownBody suitable for a comprehensive report.",
              "",
              ...topicResults.flatMap(({ name, result }) => [
                `## ${name}`,
                `Groups covered: ${result?.totalGroups ?? 0}`,
                result?.summary ?? "No results.",
                "",
              ]),
            ].join("\n");
          }}
        </Task>
      ) : null}
    </Workflow>
  );
});
