import type { SmithersAgentContractTool } from "./SmithersAgentContractTool";
import type { SmithersAgentContract } from "./SmithersAgentContract";

type RenderGuidanceOptions = {
  available?: boolean;
  toolNamePrefix?: string;
};

function displayToolName(
  tool: Pick<SmithersAgentContractTool, "name">,
  prefix = "",
) {
  return `\`${prefix}${tool.name}\``;
}

export function renderSmithersAgentDocsGuidance(
  contract: SmithersAgentContract,
  options: RenderGuidanceOptions = {},
) {
  const prefix = options.toolNamePrefix ?? "";
  const lines = [
    `## Smithers ${contract.toolSurface} Tool Surface`,
    "",
    "| Tool | Category | Destructive | Description |",
    "| --- | --- | --- | --- |",
  ];

  for (const tool of contract.tools) {
    lines.push(
      `| ${displayToolName(tool, prefix)} | ${tool.category} | ${tool.destructive ? "yes" : "no"} | ${tool.description || "No description provided."} |`,
    );
  }

  return lines.join("\n");
}
