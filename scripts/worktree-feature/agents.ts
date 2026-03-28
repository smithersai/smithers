import { ToolLoopAgent as Agent, stepCountIs, type ToolSet } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { ClaudeCodeAgent, CodexAgent } from "../../src/index.ts";
import { tools as smithersTools } from "../../src/tools/index.ts";
import { SYSTEM_PROMPT } from "./system-prompt";

const tools = smithersTools as ToolSet;

const USE_CLI =
  process.env.USE_CLI_AGENTS !== "0" &&
  process.env.USE_CLI_AGENTS !== "false";

const UNSAFE = process.env.SMITHERS_UNSAFE === "1";

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

// --- Claude ---

const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-4-6";

const claudeApi = new Agent({
  model: anthropic(CLAUDE_MODEL),
  tools,
  instructions: SYSTEM_PROMPT,
  stopWhen: stepCountIs(100),
  maxOutputTokens: 8192,
});

const claudeCli = new ClaudeCodeAgent({
  model: CLAUDE_MODEL,
  systemPrompt: SYSTEM_PROMPT,
  dangerouslySkipPermissions: UNSAFE,
  timeoutMs: 30 * 60 * 1000,
});

export const claude = USE_CLI ? claudeCli : claudeApi;

// --- Codex ---

const CODEX_MODEL = process.env.CODEX_MODEL ?? "gpt-5.3-codex";

const codexApi = new Agent({
  model: openai(CODEX_MODEL),
  tools,
  instructions: SYSTEM_PROMPT,
  stopWhen: stepCountIs(100),
  maxOutputTokens: 8192,
});

const codexCli = new CodexAgent({
  model: CODEX_MODEL,
  systemPrompt: SYSTEM_PROMPT,
  yolo: UNSAFE,
  cwd: REPO_ROOT,
  config: { model_reasoning_effort: "high" },
  timeoutMs: 30 * 60 * 1000,
});

export const codex = USE_CLI ? codexCli : codexApi;
