import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve, basename } from "node:path";
import { SmithersError } from "../utils/errors";

export type WorkflowSourceType = "seeded" | "user" | "generated";

export type DiscoveredWorkflow = {
  id: string;
  displayName: string;
  entryFile: string;
  sourceType: WorkflowSourceType;
};

const WORKFLOW_ROOT = ".smithers/workflows";
const SOURCE_MARKER = "smithers-source:";
const DISPLAY_NAME_MARKER = "smithers-display-name:";
const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseWorkflowMetadata(entryFile: string) {
  let sourceType: WorkflowSourceType = "user";
  let displayName: string | undefined;

  try {
    const contents = readFileSync(entryFile, "utf8");
    const lines = contents.split(/\r?\n/, 6);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//")) {
        const payload = trimmed.slice(2).trim();
        if (payload.startsWith(SOURCE_MARKER)) {
          const value = payload.slice(SOURCE_MARKER.length).trim();
          if (value === "seeded" || value === "generated" || value === "user") {
            sourceType = value;
          }
        }
        if (payload.startsWith(DISPLAY_NAME_MARKER)) {
          const value = payload.slice(DISPLAY_NAME_MARKER.length).trim();
          if (value) displayName = value;
        }
      }
    }
  } catch {}

  return { sourceType, displayName };
}

export function discoverWorkflows(rootDir = process.cwd()): DiscoveredWorkflow[] {
  const workflowsDir = resolve(rootDir, WORKFLOW_ROOT);
  if (!existsSync(workflowsDir)) {
    return [];
  }

  return readdirSync(workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".tsx")
    .map((entry) => {
      const entryFile = resolve(workflowsDir, entry.name);
      const id = basename(entry.name, ".tsx");
      const metadata = parseWorkflowMetadata(entryFile);
      return {
        id,
        displayName: metadata.displayName ?? id,
        entryFile,
        sourceType: metadata.sourceType,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveWorkflow(workflowId: string, rootDir = process.cwd()): DiscoveredWorkflow {
  const workflow = discoverWorkflows(rootDir).find((entry) => entry.id === workflowId);
  if (!workflow) {
    throw new SmithersError(
      "WORKFLOW_NOT_FOUND",
      `Workflow not found: ${workflowId}. Expected ${WORKFLOW_ROOT}/${workflowId}.tsx`,
    );
  }
  return workflow;
}

function toDisplayName(workflowId: string) {
  return workflowId
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function validateWorkflowName(workflowId: string) {
  if (!WORKFLOW_NAME_PATTERN.test(workflowId)) {
    throw new SmithersError(
      "INVALID_WORKFLOW_NAME",
      `Invalid workflow name: ${workflowId}. Use lowercase letters, numbers, and hyphens only.`,
    );
  }
}

export function createWorkflowFile(workflowId: string, rootDir = process.cwd()) {
  validateWorkflowName(workflowId);

  const workflowsDir = resolve(rootDir, WORKFLOW_ROOT);
  const entryFile = resolve(workflowsDir, `${workflowId}.tsx`);
  mkdirSync(workflowsDir, { recursive: true });
  if (existsSync(entryFile)) {
    throw new SmithersError("WORKFLOW_EXISTS", `Workflow already exists: ${entryFile}`);
  }

  const displayName = toDisplayName(workflowId);
  const contents = [
    "// smithers-source: generated",
    `// smithers-display-name: ${displayName}`,
    "/** @jsxImportSource smithers-orchestrator */",
    'import { createSmithers } from "smithers-orchestrator";',
    'import { agents } from "../agents";',
    'import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";',
    'import { reviewOutputSchema } from "../components/Review";',
    "",
    "const { Workflow, smithers } = createSmithers({",
    "  implement: implementOutputSchema,",
    "  validate: validateOutputSchema,",
    "  review: reviewOutputSchema,",
    "});",
    "",
    "export default smithers((ctx) => (",
    `  <Workflow name="${workflowId}">`,
    "    <ValidationLoop",
    `      idPrefix="${workflowId}"`,
    `      prompt={ctx.input.prompt ?? "Describe what ${workflowId} should do."}`,
    "      implementAgents={agents.smart}",
    "      validateAgents={agents.cheapFast}",
    "      reviewAgents={agents.smart}",
    "    />",
    "  </Workflow>",
    "));",
    "",
  ].join("\n");

  writeFileSync(entryFile, contents, "utf8");

  return {
    id: workflowId,
    path: entryFile,
    sourceType: "generated" as const,
  };
}
