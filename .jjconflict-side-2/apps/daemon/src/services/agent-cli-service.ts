import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import type { AgentCli } from "@burns/shared"

import type { AgentCliEvent } from "@/agents/BaseCliAgent"
import { createCliAgent, supportedAgentClis } from "@/agents"
import { HttpError } from "@/utils/http-error"

const WORKSPACE_ENV_FILES = [".env.local", ".env"]

function resolveBinaryPath(command: string) {
  const result = Bun.spawnSync(["which", command], {
    stdout: "pipe",
    stderr: "pipe",
  })

  if (result.exitCode !== 0) {
    return null
  }

  const binaryPath = result.stdout.toString("utf8").trim()
  return binaryPath || null
}

export function listInstalledAgentClis(): AgentCli[] {
  const installedAgents: AgentCli[] = []

  for (const agent of supportedAgentClis) {
    const binaryPath = resolveBinaryPath(agent.command)
    if (!binaryPath) {
      continue
    }

    installedAgents.push({
      ...agent,
      binaryPath,
    })
  }

  return installedAgents
}

function parseEnvFileValue(fileContent: string, key: string) {
  const lines = fileContent.split(/\r?\n/)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const exportPrefix = "export "
    const normalizedLine = line.startsWith(exportPrefix)
      ? line.slice(exportPrefix.length).trim()
      : line

    const separatorIndex = normalizedLine.indexOf("=")
    if (separatorIndex <= 0) {
      continue
    }

    const name = normalizedLine.slice(0, separatorIndex).trim()
    if (name !== key) {
      continue
    }

    let value = normalizedLine.slice(separatorIndex + 1).trim()
    const isQuoted =
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))

    if (isQuoted) {
      value = value.slice(1, -1)
    } else {
      value = value.split(/\s+#/, 1)[0].trim()
    }

    if (!value) {
      return undefined
    }

    return value
  }

  return undefined
}

export function resolveWorkspaceAnthropicApiKey(cwd: string) {
  for (const envFileName of WORKSPACE_ENV_FILES) {
    const envFilePath = path.join(cwd, envFileName)
    if (!existsSync(envFilePath)) {
      continue
    }

    const fileContent = readFileSync(envFilePath, "utf8")
    const key = parseEnvFileValue(fileContent, "ANTHROPIC_API_KEY")
    if (key !== undefined) {
      return key
    }
  }

  return undefined
}

export function runWorkflowGenerationAgent(params: {
  agentId: string
  prompt: string
  cwd: string
  systemPrompt: string
  onOutput?: (output: { stream: "stdout" | "stderr"; chunk: string }) => void
  onEvent?: (event: AgentCliEvent) => void
}) {
  const installedAgent = listInstalledAgentClis().find((agent) => agent.id === params.agentId)

  if (!installedAgent) {
    throw new HttpError(404, `Agent CLI not installed: ${params.agentId}`)
  }

  const workspaceAnthropicApiKey =
    params.agentId === "claude-code"
      ? resolveWorkspaceAnthropicApiKey(params.cwd)
      : undefined

  const agentEnv =
    params.agentId === "claude-code"
      ? {
          // Do not inherit a global shell key for Claude. Use workspace env files only.
          ANTHROPIC_API_KEY: workspaceAnthropicApiKey,
        }
      : undefined

  const agent = createCliAgent(params.agentId, {
    systemPrompt: params.systemPrompt,
    env: agentEnv,
  })

  const run = () =>
    agent.generate({
      prompt: params.prompt,
      cwd: params.cwd,
      onOutput: params.onOutput,
      onEvent: params.onEvent,
    })

  return run().catch(async (error) => {
    const errorMessage =
      error instanceof Error && error.message
        ? error.message.toLowerCase()
        : ""

    const shouldRetryWithoutApiKey =
      params.agentId === "claude-code" &&
      Boolean(workspaceAnthropicApiKey) &&
      errorMessage.includes("credit balance is too low")

    if (!shouldRetryWithoutApiKey) {
      throw error
    }

    const fallbackAgent = createCliAgent(params.agentId, {
      systemPrompt: params.systemPrompt,
      env: {
        ANTHROPIC_API_KEY: undefined,
      },
    })

    return fallbackAgent.generate({
      prompt: params.prompt,
      cwd: params.cwd,
      onOutput: params.onOutput,
      onEvent: params.onEvent,
    })
  })
}
