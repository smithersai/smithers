import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ClaudeCodeAgent } from "@smithers/agents/ClaudeCodeAgent";
import { CodexAgent } from "@smithers/agents/CodexAgent";
import { GeminiAgent } from "@smithers/agents/GeminiAgent";
import { KimiAgent } from "@smithers/agents/KimiAgent";
import { PiAgent } from "@smithers/agents/PiAgent";
import { SmithersError } from "@smithers/errors";
import { createSmithersAgentContract, renderSmithersAgentPromptGuidance, } from "@smithers/agents/agent-contract";
import { detectAvailableAgents, } from "./agent-detection.js";
/**
 * @typedef {typeof ASK_AGENT_IDS[number]} AskAgentId
 */
/**
 * @typedef {{ agent?: AskAgentId; listAgents?: boolean; dumpPrompt?: boolean; toolSurface?: SmithersToolSurface; noMcp?: boolean; printBootstrap?: boolean; }} AskOptions
 */
/** @typedef {import("@smithers/agents/agent-contract").SmithersToolSurface} SmithersToolSurface */

const ASK_AGENT_IDS = ["claude", "codex", "kimi", "gemini", "pi"];
const DEFAULT_SERVER_NAME = "smithers";
/**
 * @param {AgentAvailability["id"]} value
 * @returns {value is AskAgentId}
 */
function isAskAgentId(value) {
    return ASK_AGENT_IDS.includes(value);
}
/**
 * @param {AgentAvailability} availability
 * @returns {availability is AskSupportedAvailability}
 */
function isSupportedAvailability(availability) {
    return isAskAgentId(availability.id);
}
/**
 * @param {AskAgentId} agentId
 * @returns {AskBootstrapMode}
 */
function resolveBootstrapMode(agentId, noMcp = false) {
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
/**
 * @param {AskBootstrapMode} mode
 */
function bootstrapRank(mode) {
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
/**
 * @param {SmithersToolSurface} [toolSurface]
 * @returns {{ command: string; args: string[] }}
 */
function buildSmithersMcpLaunchSpec(toolSurface = "semantic") {
    return {
        command: process.execPath,
        args: [
            "run",
            resolve(dirname(fileURLToPath(import.meta.url)), "index.js"),
            "--mcp",
            "--surface",
            toolSurface,
        ],
    };
}
/**
 * @param {SmithersToolSurface} toolSurface
 */
function buildJsonMcpConfig(toolSurface, serverName = DEFAULT_SERVER_NAME) {
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
/**
 * @param {SmithersToolSurface} [toolSurface]
 */
function buildSmithersMcpConfigFile(toolSurface = "semantic", serverName = DEFAULT_SERVER_NAME) {
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
/**
 * @param {SmithersToolSurface} toolSurface
 */
function buildCodexConfigOverrides(toolSurface, serverName = DEFAULT_SERVER_NAME) {
    const launchSpec = buildSmithersMcpLaunchSpec(toolSurface);
    return [
        `mcp_servers.${serverName}.command=${JSON.stringify(launchSpec.command)}`,
        `mcp_servers.${serverName}.args=${JSON.stringify(launchSpec.args)}`,
    ];
}
/**
 * @param {AskSelection} selection
 * @param {SmithersToolSurface} toolSurface
 * @returns {AskBootstrap}
 */
function buildBootstrap(selection, toolSurface) {
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
                note: "Gemini can only allow-list preconfigured MCP servers. Configure the local Smithers server under the same name before relying on MCP.",
            };
        case "prompt-only":
            return {
                mode: "prompt-only",
                serverName: DEFAULT_SERVER_NAME,
                toolSurface,
                note: selection.availability.id === "pi"
                    ? "PI falls back to prompt-only bootstrap for smithers ask."
                    : "MCP bootstrap is disabled for this run.",
            };
    }
}
/**
 * @param {AskSupportedAvailability} left
 * @param {AskSupportedAvailability} right
 */
function compareAgents(left, right, noMcp = false) {
    const leftBootstrap = resolveBootstrapMode(left.id, noMcp);
    const rightBootstrap = resolveBootstrapMode(right.id, noMcp);
    const bootstrapDelta = bootstrapRank(rightBootstrap) - bootstrapRank(leftBootstrap);
    if (bootstrapDelta !== 0) {
        return bootstrapDelta;
    }
    if (right.score !== left.score) {
        return right.score - left.score;
    }
    return ASK_AGENT_IDS.indexOf(left.id) - ASK_AGENT_IDS.indexOf(right.id);
}
/**
 * @param {AgentAvailability} agent
 */
function formatAgentChecks(agent) {
    return agent.checks.join(", ");
}
/**
 * @param {AgentAvailability[]} agents
 */
function noUsableAgentError(agents) {
    return new SmithersError("NO_USABLE_AGENTS", `No usable agents detected. Checked: ${agents
        .map((agent) => `${agent.id} => ${formatAgentChecks(agent)}`)
        .join(" | ")}`);
}
/**
 * @param {AgentAvailability[]} agents
 * @param {AskOptions} options
 * @returns {AskSelection}
 */
function selectAgent(agents, options) {
    const supported = agents.filter(isSupportedAvailability);
    if (options.agent) {
        const explicit = supported.find((agent) => agent.id === options.agent);
        if (!explicit) {
            throw new SmithersError("CLI_AGENT_UNSUPPORTED", `Agent "${options.agent}" is not supported for \`smithers ask\`.`, { agentId: options.agent });
        }
        if (!explicit.usable) {
            throw new SmithersError("NO_USABLE_AGENTS", `Agent "${explicit.id}" is not usable. Checked: ${formatAgentChecks(explicit)}`, { agentId: explicit.id });
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
    const best = [...usable].sort((left, right) => compareAgents(left, right, options.noMcp))[0];
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
/**
 * @param {SmithersAgentContract} contract
 * @param {AskBootstrap} bootstrap
 */
function buildSystemPrompt(contract, bootstrap) {
    const lines = [
        "You are an autonomous AI agent operating inside the Smithers repository and control plane.",
        bootstrap.mode === "prompt-only"
            ? "MCP is disabled or unavailable for this run. Use the local Smithers repo and CLI directly when shell access is needed."
            : "Prefer the live Smithers MCP tools over shell commands whenever they can answer the request.",
        bootstrap.mode === "prompt-only"
            ? renderSmithersAgentPromptGuidance(contract, { available: false })
            : contract.promptGuidance,
        "If you need repository documentation, read local files in this checkout, starting with docs/llms-full.txt.",
        "Use `smithers` or `bun run src/index.js --help` to inspect the current CLI surface when you need shell fallbacks.",
        "Be concise and act directly.",
    ];
    return lines.join("\n\n");
}
/**
 * @param {AskSelection} selection
 * @param {AskBootstrap} bootstrap
 */
function formatBootstrap(selection, bootstrap) {
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
            lines.push(`allowedMcpServerNames: ${bootstrap.allowedMcpServerNames.join(", ")}`);
            lines.push(`note: ${bootstrap.note}`);
            break;
        case "prompt-only":
            lines.push(`note: ${bootstrap.note}`);
            break;
    }
    return lines.join("\n");
}
/**
 * @param {AgentAvailability[]} agents
 * @param {AskOptions} options
 * @param {AskAgentId} [selectedAgentId]
 */
function formatAgentList(agents, options, selectedAgentId) {
    const supported = agents.filter(isSupportedAvailability);
    return supported
        .sort((left, right) => compareAgents(left, right, options.noMcp))
        .map((agent) => {
        const marker = agent.id === selectedAgentId ? "*" : " ";
        return `${marker} ${agent.id}  usable=${agent.usable ? "yes" : "no"}  status=${agent.status}  bootstrap=${resolveBootstrapMode(agent.id, options.noMcp)}`;
    })
        .join("\n");
}
/**
 * @param {AskSelection} selection
 * @param {AskBootstrap} bootstrap
 * @param {string} systemPrompt
 * @param {string} cwd
 * @returns {{ agent: BaseCliAgent; cleanup: () => void }}
 */
function buildAgent(selection, bootstrap, systemPrompt, cwd) {
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
                    cleanup() { },
                };
            }
            const mcpConfig = buildSmithersMcpConfigFile(bootstrap.toolSurface, bootstrap.serverName);
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
                    cleanup() { },
                };
            }
            const mcpConfig = buildSmithersMcpConfigFile(bootstrap.toolSurface, bootstrap.serverName);
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
                    allowedMcpServerNames: bootstrap.mode === "mcp-allow-list"
                        ? bootstrap.allowedMcpServerNames
                        : undefined,
                    systemPrompt,
                    approvalMode: "yolo",
                }),
                cleanup() { },
            };
        case "codex":
            return {
                agent: new CodexAgent({
                    cwd,
                    model: "gpt-5.3-codex",
                    config: bootstrap.mode === "mcp-config-inline"
                        ? bootstrap.configOverrides
                        : undefined,
                    systemPrompt,
                    fullAuto: true,
                    skipGitRepoCheck: true,
                }),
                cleanup() { },
            };
        case "pi":
            return {
                agent: new PiAgent({
                    cwd,
                    provider: "openai",
                    model: "gpt-5.3-codex",
                    systemPrompt,
                }),
                cleanup() { },
            };
    }
}
/**
 * @param {string | undefined} question
 * @param {string} cwd
 * @param {AskOptions} [options]
 * @returns {Promise<void>}
 */
export async function ask(question, cwd, options = {}) {
    const agents = detectAvailableAgents();
    if (options.listAgents) {
        let selectedAgentId;
        try {
            selectedAgentId = selectAgent(agents, options).availability.id;
        }
        catch { }
        process.stdout.write(`${formatAgentList(agents, options, selectedAgentId)}\n`);
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
    let tools;
    try {
        await client.connect(transport);
        const listed = await client.listTools();
        tools = listed.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
        }));
    }
    catch (error) {
        throw new SmithersError("ASK_BOOTSTRAP_FAILED", `Failed to probe the live Smithers MCP tools: ${error?.message ?? String(error)}`, {
            cwd,
            toolSurface,
            command: launchSpec.command,
            args: launchSpec.args,
        });
    }
    finally {
        try {
            await client.close();
        }
        catch { }
        try {
            await transport.close();
        }
        catch { }
    }
    const contract = createSmithersAgentContract({
        toolSurface,
        serverName: DEFAULT_SERVER_NAME,
        tools,
    });
    const bootstrap = buildBootstrap(selection, toolSurface);
    const systemPrompt = buildSystemPrompt(contract, bootstrap);
    if (options.dumpPrompt || options.printBootstrap) {
        const sections = [];
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
        throw new SmithersError("INVALID_ARGUMENT", "A question is required unless you use --list-agents, --dump-prompt, or --print-bootstrap.");
    }
    const { agent, cleanup } = buildAgent(selection, bootstrap, systemPrompt, cwd);
    try {
        await agent.generate({
            prompt: question,
            onStdout: (chunk) => process.stdout.write(chunk),
        });
        process.stdout.write("\n");
    }
    finally {
        cleanup();
    }
}
