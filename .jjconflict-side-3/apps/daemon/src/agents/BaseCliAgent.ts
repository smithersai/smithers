import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"

export type CliCommandSpec = {
  command: string
  args: string[]
  stdin?: string
  outputFile?: string
  cleanup?: () => Promise<void>
  stdoutBannerPatterns?: RegExp[]
  env?: Record<string, string | undefined>
}

export type BaseCliAgentOptions = {
  model?: string
  systemPrompt?: string
  yolo?: boolean
  extraArgs?: string[]
  timeoutMs?: number
  env?: Record<string, string | undefined>
}

export type RunCommandResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

type AgentOutputChunk = {
  stream: "stdout" | "stderr"
  chunk: string
}

export type AgentCliActionKind =
  | "turn"
  | "command"
  | "tool"
  | "file_change"
  | "web_search"
  | "todo_list"
  | "reasoning"
  | "warning"
  | "note"

export type AgentCliActionPhase = "started" | "updated" | "completed"
export type AgentCliEventLevel = "debug" | "info" | "warning" | "error"

export type AgentCliStartedEvent = {
  type: "started"
  engine: string
  title: string
  resume?: string
  detail?: Record<string, unknown>
}

export type AgentCliActionEvent = {
  type: "action"
  engine: string
  phase: AgentCliActionPhase
  entryType?: "thought" | "message"
  action: {
    id: string
    kind: AgentCliActionKind
    title: string
    detail?: Record<string, unknown>
  }
  message?: string
  ok?: boolean
  level?: AgentCliEventLevel
}

export type AgentCliCompletedEvent = {
  type: "completed"
  engine: string
  ok: boolean
  answer?: string
  error?: string
  resume?: string
  usage?: Record<string, unknown>
}

export type AgentCliEvent = AgentCliStartedEvent | AgentCliActionEvent | AgentCliCompletedEvent

export type CliOutputInterpreter = {
  onStdoutLine?: (line: string) => AgentCliEvent[] | AgentCliEvent | null | undefined
  onStderrLine?: (line: string) => AgentCliEvent[] | AgentCliEvent | null | undefined
  onExit?: (result: RunCommandResult) => AgentCliEvent[] | AgentCliEvent | null | undefined
}

export function pushFlag(
  args: string[],
  flag: string,
  value?: string | number | boolean
) {
  if (value === undefined || value === false) {
    return
  }

  if (value === true) {
    args.push(flag)
    return
  }

  args.push(flag, String(value))
}

export function pushList(args: string[], flag: string, values?: string[]) {
  if (!values?.length) {
    return
  }

  args.push(flag, ...values.map(String))
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string
    input?: string
    timeoutMs?: number
    env?: Record<string, string | undefined>
    onOutput?: (output: AgentOutputChunk) => void
  }
): Promise<RunCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL")
          reject(new Error(`CLI timed out after ${options.timeoutMs}ms`))
        }, options.timeoutMs)
      : null

    const finish = (result: RunCommandResult) => {
      if (settled) {
        return
      }

      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      resolve(result)
    }

    child.stdout?.on("data", (chunk) => {
      const decodedChunk = chunk.toString("utf8")
      stdout += decodedChunk
      options.onOutput?.({ stream: "stdout", chunk: decodedChunk })
    })

    child.stderr?.on("data", (chunk) => {
      const decodedChunk = chunk.toString("utf8")
      stderr += decodedChunk
      options.onOutput?.({ stream: "stderr", chunk: decodedChunk })
    })

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout)
      }
      reject(error)
    })

    child.on("close", (code) => {
      finish({
        stdout,
        stderr,
        exitCode: code,
      })
    })

    if (options.input) {
      child.stdin?.write(options.input)
    }
    child.stdin?.end()
  })
}

export abstract class BaseCliAgent {
  protected readonly model?: string
  protected readonly systemPrompt?: string
  protected readonly yolo: boolean
  protected readonly extraArgs?: string[]
  protected readonly timeoutMs?: number
  protected readonly env?: Record<string, string | undefined>

  constructor(options: BaseCliAgentOptions) {
    this.model = options.model
    this.systemPrompt = options.systemPrompt
    this.yolo = options.yolo ?? true
    this.extraArgs = options.extraArgs
    this.timeoutMs = options.timeoutMs ?? 180_000
    this.env = options.env
  }

  async generate(params: {
    prompt: string
    cwd: string
    onOutput?: (output: AgentOutputChunk) => void
    onEvent?: (event: AgentCliEvent) => void
  }) {
    const commandSpec = await this.buildCommand(params)
    const interpreter = this.createOutputInterpreter()
    let stdoutBuffer = ""
    let stderrBuffer = ""

    const emitEvents = (eventPayload: AgentCliEvent[] | AgentCliEvent | null | undefined) => {
      if (!eventPayload) {
        return
      }

      if (Array.isArray(eventPayload)) {
        for (const event of eventPayload) {
          params.onEvent?.(event)
        }
        return
      }

      params.onEvent?.(eventPayload)
    }

    const flushBufferedLines = (stream: "stdout" | "stderr", includePartial: boolean) => {
      let buffer = stream === "stdout" ? stdoutBuffer : stderrBuffer
      const lines = buffer.split("\n")
      if (!includePartial) {
        buffer = lines.pop() ?? ""
      } else {
        buffer = ""
      }

      for (const line of lines) {
        if (!line) {
          continue
        }
        emitEvents(
          stream === "stdout"
            ? interpreter?.onStdoutLine?.(line)
            : interpreter?.onStderrLine?.(line)
        )
      }

      if (stream === "stdout") {
        stdoutBuffer = includePartial ? "" : buffer
      } else {
        stderrBuffer = includePartial ? "" : buffer
      }
    }

    try {
      const result = await runCommand(commandSpec.command, commandSpec.args, {
        cwd: params.cwd,
        input: commandSpec.stdin,
        timeoutMs: this.timeoutMs,
        env: {
          ...(this.env ?? {}),
          ...(commandSpec.env ?? {}),
        },
        onOutput: (output) => {
          params.onOutput?.(output)

          if (!interpreter) {
            return
          }

          if (output.stream === "stdout") {
            stdoutBuffer += output.chunk
            flushBufferedLines("stdout", false)
            return
          }

          stderrBuffer += output.chunk
          flushBufferedLines("stderr", false)
        },
      })

      flushBufferedLines("stdout", true)
      flushBufferedLines("stderr", true)
      emitEvents(interpreter?.onExit?.(result))

      const stdout = commandSpec.outputFile
        ? await fs.readFile(commandSpec.outputFile, "utf8").catch(() => result.stdout)
        : result.stdout

      if (result.exitCode && result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || stdout.trim() || `CLI exited with code ${result.exitCode}`)
      }

      let cleanedStdout = stdout
      for (const pattern of commandSpec.stdoutBannerPatterns ?? []) {
        cleanedStdout = cleanedStdout.replace(pattern, "")
      }

      return cleanedStdout.trim()
    } finally {
      await commandSpec.cleanup?.().catch(() => undefined)
    }
  }

  protected abstract buildCommand(params: {
    prompt: string
    cwd: string
  }): Promise<CliCommandSpec>

  protected createOutputInterpreter(): CliOutputInterpreter | null {
    return null
  }
}
