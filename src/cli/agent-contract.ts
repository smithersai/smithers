import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SmithersError } from "../utils/errors";

export type SmithersToolSurface = "raw" | "semantic";

export type SmithersAgentToolCategory =
  | "runs"
  | "approvals"
  | "workflows"
  | "debug"
  | "admin";

export type SmithersAgentContractTool = {
  name: string;
  description: string;
  destructive: boolean;
  category: SmithersAgentToolCategory;
};

export type SmithersAgentContract = {
  toolSurface: SmithersToolSurface;
  serverName: string;
  tools: SmithersAgentContractTool[];
  promptGuidance: string;
  docsGuidance: string;
};

export type SmithersListedTool = {
  name: string;
  description?: string | null;
};

export type SmithersMcpLaunchSpec = {
  command: string;
  args: string[];
};

type CreateSmithersAgentContractOptions = {
  toolSurface?: SmithersToolSurface;
  serverName?: string;
  tools: SmithersListedTool[];
};

type ProbeSmithersAgentContractOptions = {
  toolSurface?: SmithersToolSurface;
  serverName?: string;
  cwd?: string;
};

type RenderGuidanceOptions = {
  available?: boolean;
  toolNamePrefix?: string;
};

const DEFAULT_SERVER_NAME = "smithers";
const TOOL_CATEGORY_ORDER: SmithersAgentToolCategory[] = [
  "workflows",
  "runs",
  "approvals",
  "debug",
  "admin",
];
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

function normalizeDescription(description: string | null | undefined) {
  return (description ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferCategory(name: string): SmithersAgentToolCategory {
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

function isDestructive(name: string, description: string) {
  return (
    DESTRUCTIVE_TOOL_NAMES.has(name) ||
    description.toLowerCase().startsWith("destructive:")
  );
}

function sortTools(tools: SmithersAgentContractTool[]) {
  return [...tools].sort((left, right) => {
    const categoryDelta =
      TOOL_CATEGORY_ORDER.indexOf(left.category) -
      TOOL_CATEGORY_ORDER.indexOf(right.category);
    if (categoryDelta !== 0) {
      return categoryDelta;
    }
    return left.name.localeCompare(right.name);
  });
}

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

export function resolveSmithersCliEntryPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
}

export function buildSmithersMcpLaunchSpec(
  toolSurface: SmithersToolSurface = "semantic",
): SmithersMcpLaunchSpec {
  return {
    command: process.execPath,
    args: [
      "run",
      resolveSmithersCliEntryPath(),
      "--mcp",
      "--surface",
      toolSurface,
    ],
  };
}

export function buildSmithersMcpConfigFile(
  toolSurface: SmithersToolSurface = "semantic",
  serverName = DEFAULT_SERVER_NAME,
) {
  const dir = mkdtempSync(join(tmpdir(), "smithers-ask-"));
  const configPath = join(dir, "mcp.json");
  const launchSpec = buildSmithersMcpLaunchSpec(toolSurface);
  const contents = {
    mcpServers: {
      [serverName]: {
        command: launchSpec.command,
        args: launchSpec.args,
      },
    },
  };

  writeFileSync(configPath, JSON.stringify(contents, null, 2));

  return {
    dir,
    path: configPath,
    contents,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function listLiveSmithersMcpTools(
  options: ProbeSmithersAgentContractOptions = {},
): Promise<SmithersListedTool[]> {
  const toolSurface = options.toolSurface ?? "semantic";
  const launchSpec = buildSmithersMcpLaunchSpec(toolSurface);
  const transport = new StdioClientTransport({
    command: launchSpec.command,
    args: launchSpec.args,
    cwd: options.cwd ?? process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({
    name: "smithers-agent-contract-probe",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  } catch (error: any) {
    throw new SmithersError(
      "ASK_BOOTSTRAP_FAILED",
      `Failed to probe the live Smithers MCP tools: ${error?.message ?? String(error)}`,
      {
        cwd: options.cwd ?? process.cwd(),
        toolSurface,
        command: launchSpec.command,
        args: launchSpec.args,
      },
    );
  } finally {
    try {
      await client.close();
    } catch {}
    try {
      await transport.close();
    } catch {}
  }
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

export function createSmithersAgentContract(
  options: CreateSmithersAgentContractOptions,
): SmithersAgentContract {
  const toolSurface = options.toolSurface ?? "semantic";
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
  const tools = sortTools(
    options.tools.map((tool) => {
      const description = normalizeDescription(tool.description);
      return {
        name: tool.name,
        description,
        destructive: isDestructive(tool.name, description),
        category: inferCategory(tool.name),
      };
    }),
  );

  const contract: SmithersAgentContract = {
    toolSurface,
    serverName,
    tools,
    promptGuidance: "",
    docsGuidance: "",
  };

  contract.promptGuidance = renderSmithersAgentPromptGuidance(contract);
  contract.docsGuidance = renderSmithersAgentDocsGuidance(contract);

  return contract;
}

export async function probeSmithersAgentContract(
  options: ProbeSmithersAgentContractOptions = {},
) {
  const tools = await listLiveSmithersMcpTools(options);
  return createSmithersAgentContract({
    toolSurface: options.toolSurface,
    serverName: options.serverName,
    tools,
  });
}
