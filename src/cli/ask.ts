import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAvailableAgents, type AgentAvailability } from "./agent-detection";
import { ClaudeCodeAgent } from "../agents/ClaudeCodeAgent";
import { CodexAgent } from "../agents/CodexAgent";
import { GeminiAgent } from "../agents/GeminiAgent";
import { KimiAgent } from "../agents/KimiAgent";
import type { BaseCliAgent } from "../agents/BaseCliAgent";

const SMITHERS_MCP_URL = "https://smithers.sh/mcp";
const SMITHERS_REPO = "https://github.com/anthropics/smithers.git";

const MCP_SERVER_NAME = "smithers-docs";

const SYSTEM_PROMPT = `You are a helpful assistant that answers questions about Smithers, a durable AI workflow orchestrator.

You have access to an MCP server ("${MCP_SERVER_NAME}") with Smithers documentation. ALWAYS use the MCP server tools first to answer questions.

If the MCP server tools cannot answer the question or return insufficient information, clone the Smithers repository to get the source code:
  git clone ${SMITHERS_REPO} /tmp/smithers-docs
Then read the relevant source files to answer the question.

Be concise and accurate. Cite documentation or source files when possible.`;

/** System prompt for agents that don't support MCP — instructs them to clone instead. */
const FALLBACK_SYSTEM_PROMPT = `You are a helpful assistant that answers questions about Smithers, a durable AI workflow orchestrator.

To answer questions, clone the Smithers repository and read the source code and documentation:
  git clone ${SMITHERS_REPO} /tmp/smithers-docs
Then read the relevant files (especially the docs/ directory) to answer the question.

Be concise and accurate. Cite documentation or source files when possible.`;

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
        [MCP_SERVER_NAME]: {
          type: "url",
          url: SMITHERS_MCP_URL,
        },
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
        allowedMcpServerNames: [MCP_SERVER_NAME],
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
      throw new Error(
        `Agent "pi" does not support MCP servers. Install claude, kimi, or gemini CLI for best results.`,
      );
    default:
      throw new Error(`Agent "${best.id}" is not supported for \`smithers ask\`.`);
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
