import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SmithersError } from "@smithers/core/errors";

export type WorkflowSourceType = "user" | "seeded" | "generated" | string;

export type DiscoveredWorkflow = {
  id: string;
  displayName: string;
  sourceType: WorkflowSourceType;
  entryFile: string;
  path: string;
};

const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function workflowsDir(root: string) {
  return join(root, ".smithers", "workflows");
}

function parseMetadata(source: string, id: string) {
  const sourceMatch = source.match(/^\/\/\s*smithers-source:\s*(.+)$/m);
  const displayMatch = source.match(/^\/\/\s*smithers-display-name:\s*(.+)$/m);
  return {
    sourceType: sourceMatch?.[1]?.trim() || "user",
    displayName: displayMatch?.[1]?.trim() || id,
  };
}

function workflowFromFile(file: string, root: string): DiscoveredWorkflow {
  const id = file.replace(/\.tsx$/, "");
  const entryFile = join(workflowsDir(root), file);
  const metadata = parseMetadata(readFileSync(entryFile, "utf8"), id);
  return {
    id,
    displayName: metadata.displayName,
    sourceType: metadata.sourceType,
    entryFile,
    path: entryFile,
  };
}

export function discoverWorkflows(root: string): DiscoveredWorkflow[] {
  const dir = workflowsDir(root);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((file) => file.endsWith(".tsx"))
    .filter((file) => statSync(join(dir, file)).isFile())
    .sort()
    .map((file) => workflowFromFile(file, root));
}

export function validateWorkflowName(name: string) {
  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Invalid workflow name: ${name}. Use lowercase kebab-case.`,
      { name },
    );
  }
}

export function resolveWorkflow(id: string, root: string): DiscoveredWorkflow {
  const workflow = discoverWorkflows(root).find((candidate) => candidate.id === id);
  if (!workflow) {
    throw new SmithersError("RUN_NOT_FOUND", `Workflow not found: ${id}`, {
      id,
      root,
    });
  }
  return workflow;
}

export function createWorkflowFile(name: string, root: string): DiscoveredWorkflow {
  validateWorkflowName(name);
  const dir = workflowsDir(root);
  mkdirSync(dir, { recursive: true });
  const entryFile = join(dir, `${name}.tsx`);
  if (existsSync(entryFile)) {
    throw new SmithersError("INVALID_INPUT", `Workflow already exists: ${name}`, {
      name,
      entryFile,
    });
  }
  writeFileSync(
    entryFile,
    [
      "// smithers-source: generated",
      `// smithers-display-name: ${name}`,
      'import { createSmithers, Workflow } from "smithers";',
      "",
      "export default createSmithers(() => <Workflow />);",
      "",
    ].join("\n"),
  );
  return workflowFromFile(`${name}.tsx`, root);
}
