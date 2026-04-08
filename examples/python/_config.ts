/**
 * Shared TS configuration for Python examples.
 *
 * Agents live in TS — Python workflows reference them by string key.
 * Schemas are auto-discovered from Pydantic models in the Python scripts.
 */
import { createPythonWorkflow } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, grep, bash } from "smithers-orchestrator/tools";
import { resolve } from "node:path";

const sdkPath = resolve(import.meta.dir, "../../packages/smithers-py");

/** Helper to create a Python workflow from a script in this directory. */
export function pythonExample(scriptName: string, agents: Record<string, any> = {}) {
  return createPythonWorkflow({
    scriptPath: resolve(import.meta.dir, scriptName),
    agents,
    env: { PYTHONPATH: sdkPath },
    // schemas auto-discovered from Pydantic models in the Python script
  });
}

// ─── Shared agents ──────────────────────────────────────────────────────

export const claude = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: "You are a helpful assistant.",
});

export const researcher = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: "You are a research assistant. Provide concise summaries and key points.",
});

export const writer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: "You are a technical writer. Write clear, engaging content.",
});

export const reviewer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a senior code reviewer. Provide actionable feedback.
Focus on correctness, readability, and potential bugs.`,
});
