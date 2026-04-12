
/** @typedef {import("./SmithersAgentContractTool.ts").SmithersAgentContractTool} SmithersAgentContractTool */
/** @typedef {import("./SmithersAgentToolCategory.ts").SmithersAgentToolCategory} SmithersAgentToolCategory */

/**
 * @typedef {{ available?: boolean; toolNamePrefix?: string; }} RenderGuidanceOptions
 */
/** @typedef {import("./SmithersAgentContract.ts").SmithersAgentContract} SmithersAgentContract */
const PROMPT_CATEGORY_ORDER = [
    "workflows",
    "runs",
    "approvals",
    "debug",
];
const CATEGORY_LABELS = {
    workflows: "workflow discovery and launch",
    runs: "run inspection and control",
    approvals: "approval handling",
    debug: "debugging and evidence gathering",
    admin: "administration and maintenance",
};
const TOOL_CATEGORY_ORDER = [
    "workflows",
    "runs",
    "approvals",
    "debug",
    "admin",
];
/**
 * @param {Pick<SmithersAgentContractTool, "name">} tool
 */
function displayToolName(tool, prefix = "") {
    return `\`${prefix}${tool.name}\``;
}
/**
 * @param {SmithersAgentContractTool[]} tools
 */
function joinToolNames(tools, prefix = "") {
    return tools.map((tool) => displayToolName(tool, prefix)).join(", ");
}
/**
 * @param {SmithersAgentContractTool[]} tools
 * @returns {Map<SmithersAgentToolCategory, SmithersAgentContractTool[]>}
 */
function groupToolsByCategory(tools) {
    const grouped = new Map();
    for (const category of TOOL_CATEGORY_ORDER) {
        grouped.set(category, []);
    }
    for (const tool of tools) {
        grouped.get(tool.category).push(tool);
    }
    return grouped;
}
/**
 * @param {SmithersAgentContract} contract
 * @param {RenderGuidanceOptions} [options]
 */
export function renderSmithersAgentPromptGuidance(contract, options = {}) {
    const grouped = groupToolsByCategory(contract.tools);
    const prefix = options.toolNamePrefix ?? "";
    const available = options.available ?? true;
    const lines = [
        available
            ? `You have access to the live Smithers ${contract.toolSurface} MCP surface on server "${contract.serverName}".`
            : `The live Smithers ${contract.toolSurface} MCP contract for server "${contract.serverName}" is listed below, but MCP is disabled for this run.`,
        "Only rely on the tool names listed here.",
    ];
    for (const category of PROMPT_CATEGORY_ORDER) {
        const tools = grouped.get(category) ?? [];
        if (tools.length === 0) {
            continue;
        }
        lines.push(`For ${CATEGORY_LABELS[category]}, use ${joinToolNames(tools, prefix)}.`);
    }
    const destructiveTools = contract.tools.filter((tool) => tool.destructive);
    if (destructiveTools.length > 0) {
        lines.push(`Potentially destructive tools: ${joinToolNames(destructiveTools, prefix)}. Confirm intent before using them unless the user already asked for that action.`);
    }
    return lines.join("\n");
}
