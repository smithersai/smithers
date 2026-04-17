// @smithers-type-exports-begin
/** @typedef {import("./WorkflowSourceType.ts").WorkflowSourceType} WorkflowSourceType */
// @smithers-type-exports-end

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { SmithersError } from "@smithers/errors";

/** @typedef {import("./DiscoveredWorkflow.ts").DiscoveredWorkflow} DiscoveredWorkflow */

const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * @param {string} root
 */
function workflowsDir(root) {
    return join(root, ".smithers", "workflows");
}
/**
 * @param {string} source
 * @param {string} id
 */
function parseMetadata(source, id) {
    const sourceMatch = source.match(/^\/\/\s*smithers-source:\s*(.+)$/m);
    const displayMatch = source.match(/^\/\/\s*smithers-display-name:\s*(.+)$/m);
    return {
        sourceType: sourceMatch?.[1]?.trim() || "user",
        displayName: displayMatch?.[1]?.trim() || id,
    };
}
/**
 * @param {string} file
 * @param {string} root
 * @returns {DiscoveredWorkflow}
 */
function workflowFromFile(file, root) {
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
/**
 * @param {string} name
 * @returns {string}
 */
function displayNameFromWorkflowName(name) {
    return name
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}
/**
 * @param {string} root
 * @returns {DiscoveredWorkflow[]}
 */
export function discoverWorkflows(root) {
    const dir = workflowsDir(root);
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((file) => file.endsWith(".tsx"))
        .filter((file) => statSync(join(dir, file)).isFile())
        .sort()
        .map((file) => workflowFromFile(file, root));
}
/**
 * @param {string} name
 */
export function validateWorkflowName(name) {
    if (!WORKFLOW_NAME_PATTERN.test(name)) {
        throw new SmithersError("INVALID_WORKFLOW_NAME", `Invalid workflow name: ${name}. Use lowercase kebab-case.`, { name });
    }
}
/**
 * @param {string} id
 * @param {string} root
 * @returns {DiscoveredWorkflow}
 */
export function resolveWorkflow(id, root) {
    const workflow = discoverWorkflows(root).find((candidate) => candidate.id === id);
    if (!workflow) {
        throw new SmithersError("RUN_NOT_FOUND", `Workflow not found: ${id}`, {
            id,
            root,
        });
    }
    return workflow;
}
/**
 * @param {string} name
 * @param {string} root
 * @returns {DiscoveredWorkflow}
 */
export function createWorkflowFile(name, root) {
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
    writeFileSync(entryFile, [
        "// smithers-source: generated",
        `// smithers-display-name: ${displayNameFromWorkflowName(name)}`,
        "/** @jsxImportSource smithers */",
        'import { createSmithers, Workflow } from "smithers";',
        "",
        "const { smithers } = createSmithers({});",
        "",
        `export default smithers(() => <Workflow name="${name}" />);`,
        "",
    ].join("\n"));
    return workflowFromFile(`${name}.tsx`, root);
}
