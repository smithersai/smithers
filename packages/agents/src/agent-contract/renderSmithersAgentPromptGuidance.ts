import type { SmithersAgentToolCategory } from "./SmithersAgentToolCategory";
import type { SmithersAgentContractTool } from "./SmithersAgentContractTool";
import type { SmithersAgentContract } from "./SmithersAgentContract";

type RenderGuidanceOptions = {
  available?: boolean;
  toolNamePrefix?: string;
};

const PROMPT_CATEGORY_ORDER: SmithersAgentToolCategory[] = [
  "workflows",
  "runs",
  "approvals",
  "debug",
];

const CATEGORY_LABELS: Record<SmithersAgentToolCategory, string> = {
  workflows: "workflow discovery and launch",
  runs: "run inspection and control",
  approvals: "approval handling",
  debug: "debugging and evidence gathering",
  admin: "administration and maintenance",
};

const TOOL_CATEGORY_ORDER: SmithersAgentToolCategory[] = [
  "workflows",
  "runs",
  "approvals",
  "debug",
  "admin",
];

function displayToolName(
  tool: Pick<SmithersAgentContractTool, "name">,
  prefix = "",
) {
  return `\`${prefix}${tool.name}\``;
}

function joinToolNames(
  tools: SmithersAgentContractTool[],
  prefix = "",
) {
  return tools.map((tool) => displayToolName(tool, prefix)).join(", ");
}

function groupToolsByCategory(
  tools: SmithersAgentContractTool[],
): Map<SmithersAgentToolCategory, SmithersAgentContractTool[]> {
  const grouped = new Map<SmithersAgentToolCategory, SmithersAgentContractTool[]>();
  for (const category of TOOL_CATEGORY_ORDER) {
    grouped.set(category, []);
  }
  for (const tool of tools) {
    grouped.get(tool.category)!.push(tool);
  }
  return grouped;
}

export function renderSmithersAgentPromptGuidance(
  contract: SmithersAgentContract,
  options: RenderGuidanceOptions = {},
) {
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
    lines.push(
      `For ${CATEGORY_LABELS[category]}, use ${joinToolNames(tools, prefix)}.`,
    );
  }

  const destructiveTools = contract.tools.filter((tool) => tool.destructive);
  if (destructiveTools.length > 0) {
    lines.push(
      `Potentially destructive tools: ${joinToolNames(destructiveTools, prefix)}. Confirm intent before using them unless the user already asked for that action.`,
    );
  }

  return lines.join("\n");
}
