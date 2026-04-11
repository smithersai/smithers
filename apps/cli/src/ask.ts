import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BaseCliAgent } from "@smithers/agents/BaseCliAgent";
import { ClaudeCodeAgent } from "@smithers/agents/ClaudeCodeAgent";
import { CodexAgent } from "@smithers/agents/CodexAgent";
import { GeminiAgent } from "@smithers/agents/GeminiAgent";
import { KimiAgent } from "@smithers/agents/KimiAgent";
import { PiAgent } from "@smithers/agents/PiAgent";
import { SmithersError } from "@smithers/errors";
import {
  createSmithersAgentContract,
  renderSmithersAgentPromptGuidance,
  type SmithersAgentContract,
  type SmithersListedTool,
  type SmithersToolSurface,
} from "@smithers/agents/agent-contract";
import {
  detectAvailableAgents,
  type AgentAvailability,
} from "./agent-detection";

const ASK_AGENT_IDS = ["claude", "codex", "kimi", "gemini", "pi"] as const;
const DEFAULT_SERVER_NAME = "smithers";

type AskAgentId = typeof ASK_AGENT_IDS[number];
type AskBootstrapMode =
  | "mcp-config-file"
  | "mcp-config-inline"
  | "mcp-allow-list"
  | "prompt-only";

type AskOptions = {
  agent?: AskAgentId;
  listAgents?: boolean;
  dumpPrompt?: boolean;
  toolSurface?: SmithersToolSurface;
  noMcp?: boolean;
  printBootstrap?: boolean;
};

type AskSupportedAvailability = AgentAvailability & { id: AskAgentId };

type AskSelection = {
  availability: AskSupportedAvailability;
  bootstrapMode: AskBootstrapMode;
  selectionReason: string;
};

type AskBootstrap =
  | {
      mode: "mcp-config-file";
      serverName: string;
      toolSurface: SmithersToolSurface;
      config: {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
    }
  | {
      mode: "mcp-config-inline";
      serverName: string;
      toolSurface: SmithersToolSurface;
      configOverrides: string[];
    }
  | {
      mode: "mcp-allow-list";
      serverName: string;
      toolSurface: SmithersToolSurface;
      allowedMcpServerNames: string[];
      note: string;
    }
  | {
      mode: "prompt-only";
      serverName: string;
      toolSurface: SmithersToolSurface;
      note: string;
    };

function isAskAgentId(value: AgentAvailability["id"]): value is AskAgentId {
  return ASK_AGENT_IDS.includes(value as AskAgentId);
}

function isSupportedAvailability(
  availability: AgentAvailability,
): availability is AskSupportedAvailability {
  return isAskAgentId(availability.id);
}

function resolveBootstrapMode(
  agentId: AskAgentId,
  noMcp = false,
): AskBootstrapMode {
  if (noMcp) {
    return "prompt-only";
  }

  switch (agentId) {
    case "claude":
    case "kimi":
      return "mcp-config-file";
    case "codex":
      return "mcp-config-inline";
    case "gemini":
      return "mcp-allow-list";
    case "pi":
      return "prompt-only";
  }
}

function bootstrapRank(mode: AskBootstrapMode) {
  switch (mode) {
    case "mcp-config-file":
    case "mcp-config-inline":
      return 3;
    case "mcp-allow-list":
      return 2;
    case "prompt-only":
      return 1;
  }
}

function buildSmithersMcpLaunchSpec(
  toolSurface: SmithersToolSurface = "semantic",
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      "run",
      resolve(dirname(fileURLToPath(import.meta.url)), "index.ts"),
      "--mcp",
      "--surface",
      toolSurface,
    ],
  };
}

function buildJsonMcpConfig(
  toolSurface: SmithersToolSurface,
  serverName = DEFAULT_SERVER_NAME,
) {
  const launchSpec = buildSmithersMcpLaunchSpec(toolSurface);
  return {
    mcpServers: {
      [serverName]: {
        command: launchSpec.command,
        args: launchSpec.args,
      },
    },
  };
}

function buildSmithersMcpConfigFile(
  toolSurface: SmithersToolSurface = "semantic",
  serverName = DEFAULT_SERVER_NAME,
) {
  const dir = mkdtempSync(join(tmpdir(), "smithers-ask-"));
  const configPath = join(dir, "mcp.json");
  const contents = buildJsonMcpConfig(toolSurface, serverName);

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

function buildCodexConfigOverrides(
  toolSurface: SmithersToolSurface,
  serverName = DEFAULT_SERVER_NAME,
) {
  const launchSpec = buildSmithersMcpLaunchSpec(toolSurface);
  return [
    `mcp_servers.${serverName}.command=${JSON.stringify(launchSpec.command)}`,
    `mcp_servers.${serverName}.args=${JSON.stringify(launchSpec.args)}`,
  ];
}

function buildBootstrap(
  selection: AskSelection,
  toolSurface: SmithersToolSurface,
): AskBootstrap {
  switch (selection.bootstrapMode) {
    case "mcp-config-file":
      return {
        mode: "mcp-config-file",
        serverName: DEFAULT_SERVER_NAME,
        toolSurface,
        config: buildJsonMcpConfig(toolSurface),
      };
    case "mcp-config-inline":
      return {
        mode: "mcp-config-inline",
        serverName: DEFAULT_SERVER_NAME,
        toolSurface,
        configOverrides: buildCodexConfigOverrides(toolSurface),
      };
    case "mcp-allow-list":
      return {
        mode: "mcp-allow-list",
        serverName: DEFAULT_SERVER_NAME,
        toolSurface,
        allowedMcpServerNames: [DEFAULT_SERVER_NAME],
        note:
          "Gemini can only allow-list preconfigured MCP servers. Configure the local Smithers server under the same name before relying on MCP.",
      };
    case "prompt-only":
      return {
        mode: "prompt-only",
        serverName: DEFAULT_SERVER_NAME,
        toolSurface,
        note:
          selection.availability.id === "pi"
            ? "PI falls back to prompt-only bootstrap for smithers ask."
            : "MCP bootstrap is disabled for this run.",
      };
  }
}

function compareAgents(
  left: AskSupportedAvailability,
  right: AskSupportedAvailability,
  noMcp = false,
) {
  const leftBootstrap = resolveBootstrapMode(left.id, noMcp);
  const rightBootstrap = resolveBootstrapMode(right.id, noMcp);
  const bootstrapDelta =
    bootstrapRank(rightBootstrap) - bootstrapRank(leftBootstrap);
  if (bootstrapDelta !== 0) {
    return bootstrapDelta;
  }
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return ASK_AGENT_IDS.indexOf(left.id) - ASK_AGENT_IDS.indexOf(right.id);
}

function formatAgentChecks(agent: AgentAvailability) {
  return agent.checks.join(", ");
}

function noUsableAgentError(agents: AgentAvailability[]) {
  return new SmithersError(
    "NO_USABLE_AGENTS",
    `No usable agents detected. Checked: ${agents
      .map((agent) => `${agent.id} => ${formatAgentChecks(agent)}`)
      .join(" | ")}`,
  );
}

function selectAgent(
  agents: AgentAvailability[],
  options: AskOptions,
): AskSelection {
  const supported = agents.filter(isSupportedAvailability);

  if (options.agent) {
    const explicit = supported.find((agent) => agent.id === options.agent);
    if (!explicit) {
      throw new SmithersError(
        "CLI_AGENT_UNSUPPORTED",
        `Agent "${options.agent}" is not supported for \`smithers ask\`.`,
        { agentId: options.agent },
      );
    }
    if (!explicit.usable) {
      throw new SmithersError(
        "NO_USABLE_AGENTS",
        `Agent "${explicit.id}" is not usable. Checked: ${formatAgentChecks(explicit)}`,
        { agentId: explicit.id },
      );
    }
    return {
      availability: explicit,
      bootstrapMode: resolveBootstrapMode(explicit.id, options.noMcp),
      selectionReason: "requested via --agent",
    };
  }

  const usable = supported.filter((agent) => agent.usable);
  if (usable.length === 0) {
    throw noUsableAgentError(agents);
  }

  const best = [...usable].sort((left, right) =>
    compareAgents(left, right, options.noMcp),
  )[0];

  if (!best) {
    throw noUsableAgentError(agents);
  }

  const bootstrapMode = resolveBootstrapMode(best.id, options.noMcp);
  return {
    availability: best,
    bootstrapMode,
    selectionReason: `best available ${bootstrapMode} bootstrap`,
  };
}

function buildSystemPrompt(
  contract: SmithersAgentContract,
  bootstrap: AskBootstrap,
) {
  const lines = [
    "You are an autonomous AI agent operating inside the Smithers repository and control plane.",
    bootstrap.mode === "prompt-only"
      ? "MCP is disabled or unavailable for this run. Use the local Smithers repo and CLI directly when shell access is needed."
      : "Prefer the live Smithers MCP tools over shell commands whenever they can answer the request.",
    bootstrap.mode === "prompt-only"
      ? renderSmithersAgentPromptGuidance(contract, { available: false })
      : contract.promptGuidance,
    "If you need repository documentation, read local files in this checkout, starting with docs/llms-full.txt.",
    "Use `smithers` or `bun run src/cli/index.ts --help` to inspect the current CLI surface when you need shell fallbacks.",
    "Be concise and act directly.",
  ];

  return lines.join("\n\n");
}

function formatBootstrap(selection: AskSelection, bootstrap: AskBootstrap) {
  const lines = [
    `agent: ${selection.availability.id}`,
    `selectionReason: ${selection.selectionReason}`,
    `bootstrapMode: ${bootstrap.mode}`,
    `toolSurface: ${bootstrap.toolSurface}`,
    `serverName: ${bootstrap.serverName}`,
  ];

  switch (bootstrap.mode) {
    case "mcp-config-file":
      lines.push("config:");
      lines.push(JSON.stringify(bootstrap.config, null, 2));
      break;
    case "mcp-config-inline":
      lines.push("configOverrides:");
      lines.push(...bootstrap.configOverrides.map((entry) => `- ${entry}`));
      break;
    case "mcp-allow-list":
      lines.push(
        `allowedMcpServerNames: ${bootstrap.allowedMcpServerNames.join(", ")}`,
      );
      lines.push(`note: ${bootstrap.note}`);
      break;
    case "prompt-only":
      lines.push(`note: ${bootstrap.note}`);
      break;
  }

  return lines.join("\n");
}

function formatAgentList(
  agents: AgentAvailability[],
  options: AskOptions,
  selectedAgentId?: AskAgentId,
) {
  const supported = agents.filter(isSupportedAvailability);
  return supported
    .sort((left, right) => compareAgents(left, right, options.noMcp))
    .map((agent) => {
      const marker = agent.id === selectedAgentId ? "*" : " ";
      return `${marker} ${agent.id}  usable=${agent.usable ? "yes" : "no"}  status=${agent.status}  bootstrap=${resolveBootstrapMode(agent.id, options.noMcp)}`;
    })
    .join("\n");
}

function buildAgent(
  selection: AskSelection,
  bootstrap: AskBootstrap,
  systemPrompt: string,
  cwd: string,
): { agent: BaseCliAgent; cleanup: () => void } {
  switch (selection.availability.id) {
    case "claude": {
      if (bootstrap.mode !== "mcp-config-file") {
        return {
          agent: new ClaudeCodeAgent({
            cwd,
            model: "claude-sonnet-4-20250514",
            systemPrompt,
            dangerouslySkipPermissions: true,
          }),
          cleanup() {},
        };
      }

      const mcpConfig = buildSmithersMcpConfigFile(
        bootstrap.toolSurface,
        bootstrap.serverName,
      );
      return {
        agent: new ClaudeCodeAgent({
          cwd,
          model: "claude-sonnet-4-20250514",
          mcpConfig: [mcpConfig.path],
          strictMcpConfig: true,
          systemPrompt,
          dangerouslySkipPermissions: true,
        }),
        cleanup() {
          mcpConfig.cleanup();
        },
      };
    }
    case "kimi": {
      if (bootstrap.mode !== "mcp-config-file") {
        return {
          agent: new KimiAgent({
            cwd,
            model: "kimi-latest",
            systemPrompt,
          }),
          cleanup() {},
        };
      }

      const mcpConfig = buildSmithersMcpConfigFile(
        bootstrap.toolSurface,
        bootstrap.serverName,
      );
      return {
        agent: new KimiAgent({
          cwd,
          model: "kimi-latest",
          mcpConfigFile: [mcpConfig.path],
          systemPrompt,
        }),
        cleanup() {
          mcpConfig.cleanup();
        },
      };
    }
    case "gemini":
      return {
        agent: new GeminiAgent({
          cwd,
          model: "gemini-3.1-pro-preview",
          allowedMcpServerNames:
            bootstrap.mode === "mcp-allow-list"
              ? bootstrap.allowedMcpServerNames
              : undefined,
          systemPrompt,
          approvalMode: "yolo",
        }),
        cleanup() {},
      };
    case "codex":
      return {
        agent: new CodexAgent({
          cwd,
          model: "gpt-5.3-codex",
          config:
            bootstrap.mode === "mcp-config-inline"
              ? bootstrap.configOverrides
              : undefined,
          systemPrompt,
          fullAuto: true,
          skipGitRepoCheck: true,
        }),
        cleanup() {},
      };
    case "pi":
      return {
        agent: new PiAgent({
          cwd,
          provider: "openai",
          model: "gpt-5.3-codex",
          systemPrompt,
        }),
        cleanup() {},
      };
  }
}

export async function ask(
  question: string | undefined,
  cwd: string,
  options: AskOptions = {},
): Promise<void> {
  const agents = detectAvailableAgents();

  if (options.listAgents) {
    let selectedAgentId: AskAgentId | undefined;
    try {
      selectedAgentId = selectAgent(agents, options).availability.id;
    } catch {}
    process.stdout.write(
      `${formatAgentList(agents, options, selectedAgentId)}\n`,
    );
    return;
  }

  const selection = selectAgent(agents, options);
  const toolSurface = options.toolSurface ?? "semantic";
  const launchSpec = buildSmithersMcpLaunchSpec(toolSurface);
  const transport = new StdioClientTransport({
    command: launchSpec.command,
    args: launchSpec.args,
    cwd,
    stderr: "pipe",
  });
  const client = new Client({
    name: "smithers-ask-contract-probe",
    version: "1.0.0",
  });
  let tools: SmithersListedTool[];

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    tools = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  } catch (error: any) {
    throw new SmithersError(
      "ASK_BOOTSTRAP_FAILED",
      `Failed to probe the live Smithers MCP tools: ${error?.message ?? String(error)}`,
      {
        cwd,
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

  const contract = createSmithersAgentContract({
    toolSurface,
    serverName: DEFAULT_SERVER_NAME,
    tools,
  });
  const bootstrap = buildBootstrap(selection, toolSurface);
  const systemPrompt = buildSystemPrompt(contract, bootstrap);

  if (options.dumpPrompt || options.printBootstrap) {
    const sections: string[] = [];
    if (options.printBootstrap) {
      sections.push("[bootstrap]");
      sections.push(formatBootstrap(selection, bootstrap));
    }
    if (options.dumpPrompt) {
      sections.push("[system-prompt]");
      sections.push(systemPrompt);
    }
    process.stdout.write(`${sections.join("\n\n")}\n`);
    return;
  }

  if (!question?.trim()) {
    throw new SmithersError(
      "INVALID_ARGUMENT",
      "A question is required unless you use --list-agents, --dump-prompt, or --print-bootstrap.",
    );
  }

  const { agent, cleanup } = buildAgent(selection, bootstrap, systemPrompt, cwd);

  try {
    await agent.generate({
      prompt: question,
      onStdout: (chunk: string) => process.stdout.write(chunk),
    });
    process.stdout.write("\n");
  } finally {
    cleanup();
  }
}
