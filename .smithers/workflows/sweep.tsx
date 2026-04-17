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
import SweepDocumentation from "../prompts/sweep-documentation.mdx";
import SweepE2ETesting from "../prompts/sweep-e2e-testing.mdx";
import SweepUnitTests from "../prompts/sweep-unit-tests.mdx";
import SweepObservability from "../prompts/sweep-observability.mdx";
import SweepImplementation from "../prompts/sweep-implementation.mdx";
import SweepCli from "../prompts/sweep-cli.mdx";

const TOPIC_KEYS = [
  "DOCUMENTATION",
  "E2E_TESTING",
  "UNIT_TESTS",
  "OBSERVABILITY",
  "IMPLEMENTATION",
  "CLI",
] as const;

type TopicKey = (typeof TOPIC_KEYS)[number];

const TOPICS: Record<TopicKey, { name: string; prompt: React.ReactNode }> = {
  DOCUMENTATION: {
    name: "Documentation",
    prompt: <SweepDocumentation />,
  },
  E2E_TESTING: {
    name: "E2E Testing",
    prompt: <SweepE2ETesting />,
  },
  UNIT_TESTS: {
    name: "Unit Tests",
    prompt: <SweepUnitTests />,
  },
  OBSERVABILITY: {
    name: "Observability",
    prompt: <SweepObservability />,
  },
  IMPLEMENTATION: {
    name: "Implementation Quality",
    prompt: <SweepImplementation />,
  },
  CLI: {
    name: "CLI",
    prompt: <SweepCli />,
  },
};

const bootstrapSchema = z.looseObject({
  features: z.record(z.string(), z.array(z.string())),
  totalGroups: z.number().int(),
  totalFeatures: z.number().int(),
});

const sweepSummarySchema = z.looseObject({
  topicsRun: z.array(z.string()),
  totalGroups: z.number().int(),
  totalTopics: z.number().int(),
  summary: z.string(),
  markdownBody: z.string(),
});

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
