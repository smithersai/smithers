import { renderSmithersAgentPromptGuidance } from "./renderSmithersAgentPromptGuidance.js";
/** @typedef {import("./SmithersListedTool.ts").SmithersListedTool} SmithersListedTool */
/** @typedef {import("./SmithersToolSurface.ts").SmithersToolSurface} SmithersToolSurface */
/** @typedef {import("./SmithersAgentContractTool.ts").SmithersAgentContractTool} SmithersAgentContractTool */
/** @typedef {import("./SmithersAgentToolCategory.ts").SmithersAgentToolCategory} SmithersAgentToolCategory */

/**
 * @typedef {{ toolSurface?: SmithersToolSurface; serverName?: string; tools: SmithersListedTool[]; }} CreateSmithersAgentContractOptions
 */
/** @typedef {import("./SmithersAgentContract.ts").SmithersAgentContract} SmithersAgentContract */

const DEFAULT_SERVER_NAME = "smithers";
const TOOL_CATEGORY_ORDER = [
    "workflows",
    "runs",
    "approvals",
    "debug",
    "admin",
];
const WORKFLOW_TOOL_NAMES = new Set([
    "graph",
    "list_workflows",
    "run_workflow",
    "up",
    "workflow_create",
    "workflow_doctor",
    "workflow_list",
    "workflow_path",
    "workflow_run",
]);
const APPROVAL_TOOL_NAMES = new Set([
    "approve",
    "deny",
    "list_pending_approvals",
    "resolve_approval",
    "signal",
]);
const RUN_TOOL_NAMES = new Set([
    "cancel",
    "down",
    "events",
    "explain_run",
    "get_run",
    "inspect",
    "list_runs",
    "logs",
    "ps",
    "run_workflow",
    "supervise",
    "watch_run",
    "why",
]);
const DEBUG_TOOL_NAMES = new Set([
    "chat",
    "diff",
    "fork",
    "get_artifacts",
    "get_chat_transcript",
    "get_node_detail",
    "get_run_events",
    "hijack",
    "list_artifacts",
    "node",
    "openapi_list",
    "rag_ingest",
    "rag_query",
    "replay",
    "revert",
    "revert_attempt",
    "retry-task",
    "scores",
    "timeline",
    "timetravel",
]);
const DESTRUCTIVE_TOOL_NAMES = new Set([
    "approve",
    "cancel",
    "cron_add",
    "cron_rm",
    "cron_start",
    "deny",
    "down",
    "fork",
    "replay",
    "resolve_approval",
    "revert",
    "revert_attempt",
    "retry-task",
    "run_workflow",
    "signal",
    "timetravel",
    "up",
    "workflow_create",
    "workflow_run",
]);
/**
 * @param {string | null | undefined} description
 */
function normalizeDescription(description) {
    return (description ?? "")
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * @param {string} name
 * @returns {SmithersAgentToolCategory}
 */
function inferCategory(name) {
    if (WORKFLOW_TOOL_NAMES.has(name) || name.startsWith("workflow_")) {
        return "workflows";
    }
    if (APPROVAL_TOOL_NAMES.has(name)) {
        return "approvals";
    }
    if (RUN_TOOL_NAMES.has(name)) {
        return "runs";
    }
    if (DEBUG_TOOL_NAMES.has(name)) {
        return "debug";
    }
    if (name.startsWith("memory_") || name.startsWith("cron_")) {
        return "admin";
    }
    return "admin";
}
/**
 * @param {string} name
 * @param {string} description
 */
function isDestructive(name, description) {
    return (DESTRUCTIVE_TOOL_NAMES.has(name) ||
        description.toLowerCase().startsWith("destructive:"));
}
/**
 * @param {SmithersAgentContractTool[]} tools
 */
function sortTools(tools) {
    return [...tools].sort((left, right) => {
        const categoryDelta = TOOL_CATEGORY_ORDER.indexOf(left.category) -
            TOOL_CATEGORY_ORDER.indexOf(right.category);
        if (categoryDelta !== 0) {
            return categoryDelta;
        }
        return left.name.localeCompare(right.name);
    });
}
/**
 * @param {SmithersAgentContract} contract
 */
function renderDocsGuidance(contract) {
    const lines = [
        `## Smithers ${contract.toolSurface} Tool Surface`,
        "",
        "| Tool | Category | Destructive | Description |",
        "| --- | --- | --- | --- |",
    ];
    for (const tool of contract.tools) {
        lines.push(`| \`${tool.name}\` | ${tool.category} | ${tool.destructive ? "yes" : "no"} | ${tool.description || "No description provided."} |`);
    }
    return lines.join("\n");
}
/**
 * @param {CreateSmithersAgentContractOptions} options
 * @returns {SmithersAgentContract}
 */
export function createSmithersAgentContract(options) {
    const toolSurface = options.toolSurface ?? "semantic";
    const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
    const tools = sortTools(options.tools.map((tool) => {
        const description = normalizeDescription(tool.description);
        return {
            name: tool.name,
            description,
            destructive: isDestructive(tool.name, description),
            category: inferCategory(tool.name),
        };
    }));
    const contract = {
        toolSurface,
        serverName,
        tools,
        promptGuidance: "",
        docsGuidance: "",
    };
    contract.promptGuidance = renderSmithersAgentPromptGuidance(contract);
    contract.docsGuidance = renderDocsGuidance(contract);
    return contract;
}
