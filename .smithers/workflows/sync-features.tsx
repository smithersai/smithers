// smithers-display-name: Sync Features
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const memoryNamespace = { kind: "workflow", id: "sync-features" } as const;

const bootstrapSchema = z
  .object({
    exists: z.boolean(),
    existingFeatures: z.record(z.string(), z.array(z.string())).nullable(),
    lastCommitHash: z.string().nullable(),
    currentHead: z.string(),
    codebaseSummary: z.string(),
  })
  .passthrough();

const featureScanSchema = z
  .object({
    featureGroups: z.record(z.string(), z.array(z.string())).default({}),
    totalFeatures: z.number().int().default(0),
    lastCommitHash: z.string().nullable().optional(),
    markdownBody: z.string(),
  })
  .passthrough();

const writeResultSchema = z
  .object({
    filePath: z.string(),
    commitHash: z.string(),
    totalGroups: z.number().int(),
    totalFeatures: z.number().int(),
  })
  .passthrough();

const { Workflow, Task, smithers, outputs } = createSmithers({
  bootstrap: bootstrapSchema,
  featureScan: featureScanSchema,
  writeResult: writeResultSchema,
});

export default smithers((ctx) => {
  const bootstrap = ctx.outputMaybe("bootstrap", { nodeId: "bootstrap" });
  const scanResult = ctx.outputMaybe("featureScan", { nodeId: "scan" });

  return (
    <Workflow name="sync-features">
      {/* Step 1: Gather codebase state via compute — no LLM needed */}
      <Task id="bootstrap" output={outputs.bootstrap}>
        {async () => {
          const fs = await import("node:fs");
          const { execSync } = await import("node:child_process");
          const path = await import("node:path");

          const cwd = process.cwd();
          const featuresPath = path.resolve(cwd, "specs/features.ts");
          const exists = fs.existsSync(featuresPath);

          let existingFeatures: Record<string, string[]> | null = null;
          if (exists) {
            const content = fs.readFileSync(featuresPath, "utf-8");
            existingFeatures = {};
            const groupRegex = /(\w+):\s*\[([^\]]*)\]/gs;
            let match;
            while ((match = groupRegex.exec(content)) !== null) {
              const groupName = match[1];
              const featuresStr = match[2];
              const features = [...featuresStr.matchAll(/"([^"]+)"/g)].map(
                (m) => m[1],
              );
              if (features.length > 0) {
                existingFeatures[groupName] = features;
              }
            }
          }

          const currentHead = execSync("git rev-parse HEAD", { cwd })
            .toString()
            .trim();

          // Build a codebase summary for the agent to analyze
          const parts: string[] = [];

          // Source tree structure
          const tree = execSync(
            "find src -type f -name '*.ts' -not -path '*/node_modules/*' | sort",
            { cwd },
          )
            .toString()
            .trim();
          parts.push("=== SOURCE FILES (src/) ===", tree);

          // Components
          const components = execSync(
            "find src/components -type f -name '*.ts' 2>/dev/null | sort",
            { cwd },
          )
            .toString()
            .trim();
          if (components) parts.push("\n=== COMPONENTS ===", components);

          // Agents
          const agentFiles = execSync(
            "find src/agents -type f -name '*.ts' 2>/dev/null | sort",
            { cwd },
          )
            .toString()
            .trim();
          if (agentFiles) parts.push("\n=== AGENTS ===", agentFiles);

          // CLI commands
          const cliFiles = execSync(
            "find src/cli -type f -name '*.ts' 2>/dev/null | sort",
            { cwd },
          )
            .toString()
            .trim();
          if (cliFiles) parts.push("\n=== CLI ===", cliFiles);

          // Memory
          const memoryFiles = execSync(
            "find src/memory -type f -name '*.ts' 2>/dev/null | sort",
            { cwd },
          )
            .toString()
            .trim();
          if (memoryFiles) parts.push("\n=== MEMORY ===", memoryFiles);

          // Exports from index
          const indexExports = execSync(
            "grep -E '^export' src/index.ts 2>/dev/null || true",
            { cwd },
          )
            .toString()
            .trim();
          if (indexExports) parts.push("\n=== PUBLIC API (src/index.ts) ===", indexExports);

          // Examples
          const examples = execSync(
            "ls examples/*.tsx 2>/dev/null | head -20 || true",
            { cwd },
          )
            .toString()
            .trim();
          if (examples) parts.push("\n=== EXAMPLES ===", examples);

          // Workflows
          const workflows = execSync(
            "ls .smithers/workflows/*.tsx 2>/dev/null || true",
            { cwd },
          )
            .toString()
            .trim();
          if (workflows)
            parts.push("\n=== WORKFLOW PACK (.smithers/workflows/) ===", workflows);

          // Reusable components
          const wfComponents = execSync(
            "ls .smithers/components/*.tsx 2>/dev/null || true",
            { cwd },
          )
            .toString()
            .trim();
          if (wfComponents) parts.push("\n=== WORKFLOW COMPONENTS ===", wfComponents);

          // Docs
          const docs = execSync(
            "find docs -name '*.mdx' -type f 2>/dev/null | sort | head -40 || true",
            { cwd },
          )
            .toString()
            .trim();
          if (docs) parts.push("\n=== DOCUMENTATION ===", docs);

          // Tests
          const tests = execSync(
            "find tests -type f -name '*.test.*' 2>/dev/null | sort | head -30 || true",
            { cwd },
          )
            .toString()
            .trim();
          if (tests) parts.push("\n=== TESTS ===", tests);

          // package.json
          const pkg = execSync("cat package.json 2>/dev/null || true", { cwd })
            .toString()
            .trim();
          if (pkg) parts.push("\n=== PACKAGE.JSON ===", pkg);

          // Recent commits (for delta mode)
          const lastCommitHash: string | null = null;

          const codebaseSummary = parts.join("\n");

          return {
            exists,
            existingFeatures,
            lastCommitHash,
            currentHead,
            codebaseSummary,
          };
        }}
      </Task>

      {/* Step 2: Agent analyzes the collected info — no file I/O needed */}
      {bootstrap && !bootstrap.exists ? (
        <Task
          id="scan"
          output={outputs.featureScan}
          agent={agents.smartTool}
          heartbeatTimeoutMs={300000}
          memory={{
            remember: {
              namespace: memoryNamespace,
              key: "feature-scan",
            },
          }}
        >
          {`Produce an exhaustive feature inventory for this Smithers orchestrator codebase.
You have the full file tree below — DO NOT read any files yourself. Analyze the structure
and produce the feature groups directly.

Rules:
1. Group features by domain using SCREAMING_SNAKE_CASE group names.
2. Use SCREAMING_SNAKE_CASE feature names that are specific and code-backed.
3. Split broad buckets into concrete, independently auditable features.
4. lastCommitHash should be "${bootstrap.currentHead}".
5. Include a markdownBody that explains the grouping.

CODEBASE STRUCTURE:
${bootstrap.codebaseSummary}`}
        </Task>
      ) : null}

      {bootstrap && bootstrap.exists ? (
        <Task
          id="scan"
          output={outputs.featureScan}
          agent={agents.smartTool}
          heartbeatTimeoutMs={300000}
          memory={{
            recall: {
              namespace: memoryNamespace,
              query: "feature inventory feature groups",
              topK: 3,
            },
            remember: {
              namespace: memoryNamespace,
              key: "feature-scan",
            },
          }}
        >
          {`Refine the existing feature inventory by analyzing recent changes.

${bootstrap.lastCommitHash ? `Compare with the previous inventory at commit ${bootstrap.lastCommitHash}. Check what changed.` : "This is the first delta check — review the existing features against the codebase structure below."}

CURRENT FEATURE GROUPS:
${JSON.stringify(bootstrap.existingFeatures ?? {}, null, 2)}

CODEBASE STRUCTURE:
${bootstrap.codebaseSummary}

Checklist:
1. Add any concrete missing features based on the codebase structure.
2. Remove entries not supported by the current codebase.
3. Preserve naming discipline: SCREAMING_SNAKE_CASE groups and features.
4. lastCommitHash should be "${bootstrap.currentHead}".
5. markdownBody should summarize what changed.`}
        </Task>
      ) : null}

      {/* Step 3: Write the TypeScript file */}
      {scanResult ? (
        <Task
          id="write-features"
          output={outputs.writeResult}
          agent={agents.smartTool}
          heartbeatTimeoutMs={300000}
          memory={{
            remember: {
              namespace: memoryNamespace,
              key: "last-sync",
            },
          }}
        >
          {`Write the file specs/features.ts with the feature groups below.

First create the directory: mkdir -p specs

Use this exact TypeScript structure:

\`\`\`typescript
/**
 * Code-backed Smithers feature inventory.
 *
 * Auto-generated by the sync-features workflow.
 * Last synced at commit: ${scanResult.lastCommitHash ?? "unknown"}
 */

export const FeatureGroups = {
  // Source: <file paths>
  GROUP_NAME: [
    "FEATURE_1",
    "FEATURE_2",
  ],
} as const satisfies Record<string, readonly string[]>;

type FeatureGroupMap = typeof FeatureGroups;
export type FeatureGroupName = keyof FeatureGroupMap;
export type FeatureName = FeatureGroupMap[FeatureGroupName][number];

const featureEntries: Array<readonly [FeatureName, FeatureName]> = [];

for (const group of Object.values(FeatureGroups) as readonly (readonly FeatureName[])[]) {
  for (const feature of group) {
    featureEntries.push([feature, feature] as const);
  }
}

export const Features = Object.freeze(
  Object.fromEntries(featureEntries) as Record<FeatureName, FeatureName>,
);
\`\`\`

FEATURE GROUPS:
${JSON.stringify(scanResult.featureGroups, null, 2)}

Write the file, then report: filePath "specs/features.ts", commitHash "${scanResult.lastCommitHash ?? "unknown"}", totalGroups and totalFeatures counts.`}
        </Task>
      ) : null}
    </Workflow>
  );
});
