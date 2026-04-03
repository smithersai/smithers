import {
  BaseCliAgent,
  type AgentCliActionKind,
  type AgentCliEvent,
  type BaseCliAgentOptions,
  type CliOutputInterpreter,
  type RunCommandResult,
  pushFlag,
} from "@/agents/BaseCliAgent"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined
}

const TOOL_OUTPUT_MAX_CHARS = 500

function truncate(value: string, maxLength = TOOL_OUTPUT_MAX_CHARS) {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength - 1)}…`
}

function isLikelyRuntimeMetadata(value: string) {
  const lower = value.toLowerCase()
  const markers = [
    "\"mcp_servers\"",
    "\"slash_commands\"",
    "\"permissionmode\"",
    "\"claude_code_version\"",
    "\"apikeysource\"",
    "\"plugins\"",
    "\"skills\"",
  ]

  let matches = 0
  for (const marker of markers) {
    if (lower.includes(marker)) {
      matches += 1
    }
  }

  return matches >= 3
}

function summarizeToolOutput(toolName: string, rawOutput: string | undefined) {
  const output = rawOutput?.trim()
  if (!output) {
    return undefined
  }

  const toolErrorMatch = output.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/i)
  if (toolErrorMatch?.[1]) {
    return `Tool error: ${truncate(toolErrorMatch[1].trim(), 240)}`
  }

  if (isLikelyRuntimeMetadata(output)) {
    return "Tool output omitted (runtime metadata)."
  }

  const normalizedToolName = toolName.toLowerCase()
  if (normalizedToolName.includes("read")) {
    const numberedLines = output.split("\n").filter((line) => /^\s*\d+→/.test(line))
    if (numberedLines.length > 8) {
      return `Read output (${numberedLines.length} lines)`
    }
  }

  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean)
  if (lines.length > 5) {
    const preview = lines.slice(0, 3).join("\n")
    return `${truncate(preview, 300)}\n… (+${lines.length - 3} lines)`
  }

  return truncate(output)
}

function shouldSurfaceUnparsedStdout(line: string) {
  const lower = line.toLowerCase()
  if (line.length > 220) {
    return false
  }

  return (
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("denied") ||
    lower.includes("exception") ||
    lower.includes("timeout")
  )
}

function toolKindForClaude(name: string | undefined): AgentCliActionKind {
  const normalized = (name ?? "").toLowerCase()
  if (!normalized) {
    return "tool"
  }

  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command"
  }

  if (normalized.includes("web")) {
    return "web_search"
  }

  return "tool"
}

export class ClaudeCodeAgent extends BaseCliAgent {
  constructor(options: BaseCliAgentOptions = {}) {
    super(options)
  }

  protected createOutputInterpreter(): CliOutputInterpreter {
    let sessionId: string | undefined
    let didEmitStarted = false
    let didEmitCompleted = false
    let lastAssistantText = ""
    let syntheticCounter = 0
    const nextSyntheticId = (prefix: string) => {
      syntheticCounter += 1
      return `${prefix}-${syntheticCounter}`
    }
    const toolNameByUseId = new Map<string, string>()

    const warningAction = (title: string, message: string, level: "warning" | "error" = "warning"): AgentCliEvent => {
      return {
        type: "action",
        engine: "claude-code",
        phase: "completed",
        entryType: "thought",
        action: {
          id: nextSyntheticId("claude-warning"),
          kind: "warning",
          title,
          detail: {},
        },
        message,
        ok: level !== "error",
        level,
      }
    }

    const parseLine = (line: string): AgentCliEvent[] => {
      const trimmedLine = line.trim()
      if (!trimmedLine) {
        return []
      }

      let payload: unknown
      try {
        payload = JSON.parse(trimmedLine)
      } catch {
        if (!shouldSurfaceUnparsedStdout(trimmedLine)) {
          return []
        }
        return [warningAction("stdout", truncate(trimmedLine, 220), "warning")]
      }

      if (!isRecord(payload)) {
        return []
      }

      const payloadType = asString(payload.type)
      if (!payloadType) {
        return []
      }

      if (payloadType === "system" && asString(payload.subtype) === "init") {
        const parsedSessionId = asString(payload.session_id)
        if (parsedSessionId) {
          sessionId = parsedSessionId
        }

        if (!didEmitStarted) {
          didEmitStarted = true
          return [
            {
              type: "started",
              engine: "claude-code",
              title: "Claude Code",
              resume: sessionId,
              detail: sessionId ? { sessionId } : undefined,
            },
          ]
        }

        return []
      }

      if (payloadType === "assistant" || payloadType === "user") {
        const message = isRecord(payload.message) ? payload.message : null
        const contentBlocks = message && Array.isArray(message.content) ? message.content : []
        const events: AgentCliEvent[] = []

        for (const block of contentBlocks) {
          if (!isRecord(block)) {
            continue
          }

          const blockType = asString(block.type)
          if (!blockType) {
            continue
          }

          if (blockType === "text") {
            const text = asString(block.text)?.trim()
            if (payloadType === "assistant" && text) {
              lastAssistantText = text
              events.push({
                type: "action",
                engine: "claude-code",
                phase: "updated",
                entryType: "message",
                action: {
                  id: nextSyntheticId("claude-text"),
                  kind: "note",
                  title: "assistant",
                  detail: {},
                },
                message: text,
                ok: true,
                level: "info",
              })
            }
            continue
          }

          if (blockType === "tool_use") {
            const toolUseId = asString(block.id)
            const toolName = asString(block.name) ?? "tool"
            if (!toolUseId) {
              continue
            }

            toolNameByUseId.set(toolUseId, toolName)
            events.push({
              type: "action",
              engine: "claude-code",
              phase: "started",
              entryType: "thought",
              action: {
                id: toolUseId,
                kind: toolKindForClaude(toolName),
                title: toolName,
                detail: isRecord(block.input)
                  ? {
                      input: block.input,
                    }
                  : {},
              },
              message: `Running ${toolName}`,
              level: "info",
            })
            continue
          }

          if (blockType === "tool_result") {
            const toolUseId = asString(block.tool_use_id)
            if (!toolUseId) {
              continue
            }
            const toolName = toolNameByUseId.get(toolUseId) ?? "tool"
            const toolResultContent = block.content
            const resultSummary =
              typeof toolResultContent === "string"
                ? toolResultContent
                : Array.isArray(toolResultContent)
                ? toolResultContent
                    .map((entry) => (isRecord(entry) ? asString(entry.text) : undefined))
                    .filter((entry): entry is string => Boolean(entry))
                    .join("\n")
                : undefined
            const isToolError = block.is_error === true
            const summarizedMessage = summarizeToolOutput(toolName, resultSummary)

            events.push({
              type: "action",
              engine: "claude-code",
              phase: "completed",
              entryType: "thought",
              action: {
                id: toolUseId,
                kind: toolKindForClaude(toolName),
                title: toolName,
                detail: {},
              },
              message: summarizedMessage,
              ok: !isToolError,
              level: isToolError ? "warning" : "info",
            })
            continue
          }
        }

        return events
      }

      if (payloadType === "result") {
        if (didEmitCompleted) {
          return []
        }

        const denials = Array.isArray(payload.permission_denials) ? payload.permission_denials : []
        const events: AgentCliEvent[] = denials
          .map((denial) => {
            if (!isRecord(denial)) {
              return null
            }
            const toolName = asString(denial.tool_name) ?? "tool"
            return warningAction(
              `permission denied: ${toolName}`,
              `Permission denied for ${toolName}`,
              "warning"
            )
          })
          .filter((event): event is AgentCliEvent => Boolean(event))

        const subtype = asString(payload.subtype) ?? "success"
        const isError = payload.is_error === true || subtype === "error"
        const resultText = asString(payload.result)
        const resultError = asString(payload.error)

        didEmitCompleted = true
        events.push({
          type: "completed",
          engine: "claude-code",
          ok: !isError,
          answer: !isError ? resultText || lastAssistantText || undefined : undefined,
          error: isError ? resultError || "Claude run failed" : undefined,
          resume: asString(payload.session_id) ?? sessionId,
          usage: isRecord(payload.usage) ? payload.usage : undefined,
        })
        return events
      }

      return []
    }

    return {
      onStdoutLine: parseLine,
      onStderrLine: (line: string): AgentCliEvent[] => {
        const trimmedLine = line.trim()
        if (!trimmedLine) {
          return []
        }
        return [warningAction("stderr", truncate(trimmedLine, 220), "warning")]
      },
      onExit: (result: RunCommandResult): AgentCliEvent[] => {
        if (didEmitCompleted) {
          return []
        }

        didEmitCompleted = true
        const isSuccess = (result.exitCode ?? 0) === 0
        return [
          {
            type: "completed",
            engine: "claude-code",
            ok: isSuccess,
            answer: isSuccess ? lastAssistantText || undefined : undefined,
            error: isSuccess ? undefined : `Claude exited with code ${result.exitCode ?? -1}`,
            resume: sessionId,
          },
        ]
      },
    }
  }

  protected async buildCommand(params: { prompt: string; cwd: string }) {
    const args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
    ]

    if (this.yolo) {
      args.push(
        "--allow-dangerously-skip-permissions",
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions"
      )
    }

    pushFlag(args, "--model", this.model)
    pushFlag(args, "--system-prompt", this.systemPrompt)

    if (this.extraArgs?.length) {
      args.push(...this.extraArgs)
    }

    args.push(params.prompt)

    return {
      command: "claude",
      args,
    }
  }
}
