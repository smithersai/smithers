import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAvailableAgents, type AgentAvailability } from "./agent-detection";
import { ClaudeCodeAgent } from "../agents/ClaudeCodeAgent";
import { CodexAgent } from "../agents/CodexAgent";
import { GeminiAgent } from "../agents/GeminiAgent";
import { KimiAgent } from "../agents/KimiAgent";
import type { BaseCliAgent } from "../agents/BaseCliAgent";
import { SmithersError } from "../utils/errors";

const SMITHERS_MCP_URL = "https://smithers.sh/mcp";
const SMITHERS_REPO = "https://github.com/anthropics/smithers.git";

const MCP_SERVER_NAME = "smithers-docs";

const LOCAL_MCP_SERVER_NAME = "smithers-orchestrator";

const SYSTEM_PROMPT = `You are an autonomous AI Agent embedded inside the Smithers orchestrator control plane TUI.

You have access to TWO MCP servers:
1. "${MCP_SERVER_NAME}" (Remote): Contains Smithers documentation to help you answer questions about the framework.
2. "${LOCAL_MCP_SERVER_NAME}" (Local): Directly bridges to the active orchestrator sandbox. You can use tools like \`smithers_runs_list\`, \`smithers_workflow_up\`, \`smithers_cancel\`, etc., to natively view and manage active workflows unconditionally on the user's behalf.

If the user asks you to start a workflow, query the local tools to find and launch it. If they ask for run statuses, use the tools to fetch it. Be highly autonomous.

If the remote MCP tools cannot answer a documentation request, execute a bash fallback:
  git clone ${SMITHERS_REPO} /tmp/smithers-docs
Then read the relevant files.

Be concise and act as a strict orchestrator proxy.`;

/** System prompt for agents that don't support MCP — instructs them to clone and run bash instead. */
const FALLBACK_SYSTEM_PROMPT = `You are an autonomous AI Agent embedded inside the Smithers orchestrator control plane.

To answer docs questions, clone the repo:
  git clone ${SMITHERS_REPO} /tmp/smithers-docs

To interact with Smithers workflows, run the \`bun run src/cli/index.ts\` CLI directly in bash. Use \`--help\` to discover commands like \`up\`, \`ps\`, \`cancel\`.

Be concise and autonomous.`;

function pickBestAgent(agents: AgentAvailability[]): AgentAvailability | undefined {
  return agents
    .filter((a) => a.usable)
    .sort((a, b) => b.score - a.score)[0];
}

function buildMcpConfigFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "smithers-ask-"));
  const configPath = join(dir, "mcp.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [LOCAL_MCP_SERVER_NAME]: {
          command: "bun",
          args: ["run", "src/cli/index.ts", "--mcp"],
        }
      },
    }),
  );
  return configPath;
}

function buildAgent(best: AgentAvailability, mcpConfigPath: string): BaseCliAgent {
  switch (best.id) {
    case "claude":
      return new ClaudeCodeAgent({
        model: "claude-sonnet-4-20250514",
        mcpConfig: [mcpConfigPath],
        systemPrompt: SYSTEM_PROMPT,
        dangerouslySkipPermissions: true,
      });
    case "kimi":
      return new KimiAgent({
        model: "kimi-latest",
        mcpConfigFile: [mcpConfigPath],
        systemPrompt: SYSTEM_PROMPT,
      });
    case "gemini":
      // Gemini only supports --allowed-mcp-server-names to filter pre-configured
      // servers. It cannot configure new MCP servers via CLI flags, so we allow
      // the smithers-docs server name and rely on the user having it configured
      // in their gemini settings. The system prompt includes the clone fallback.
      return new GeminiAgent({
        model: "gemini-3.1-pro-preview",
        allowedMcpServerNames: [MCP_SERVER_NAME, LOCAL_MCP_SERVER_NAME],
        systemPrompt: SYSTEM_PROMPT,
        approvalMode: "yolo",
      });
    case "codex":
      // Codex has no MCP support — fall back to clone-based approach.
      return new CodexAgent({
        model: "gpt-5.3-codex",
        systemPrompt: FALLBACK_SYSTEM_PROMPT,
        fullAuto: true,
      });
    case "pi":
      // Pi has no MCP support — fall back to clone-based approach.
      throw new SmithersError(
        "CLI_AGENT_UNSUPPORTED",
        `Agent "pi" does not support MCP servers. Install claude, kimi, or gemini CLI for best results.`,
        { agentId: best.id },
      );
    default:
      throw new SmithersError(
        "CLI_AGENT_UNSUPPORTED",
        `Agent "${best.id}" is not supported for \`smithers ask\`.`,
        { agentId: best.id },
      );
  }
}

export async function ask(question: string, _cwd: string): Promise<void> {
  const agents = detectAvailableAgents();
  const best = pickBestAgent(agents);

  if (!best) {
    process.stderr.write(
      "No usable agents detected. Install claude, codex, gemini, or kimi CLI to use `smithers ask`.\n",
    );
    process.exit(1);
  }

  const mcpConfigPath = buildMcpConfigFile();

  try {
    const agent = buildAgent(best, mcpConfigPath);

    await agent.generate({
      prompt: question,
      onStdout: (chunk: string) => process.stdout.write(chunk),
    });
    process.stdout.write("\n");
  } finally {
    try {
      rmSync(mcpConfigPath, { recursive: true, force: true });
    } catch {}
  }
}
