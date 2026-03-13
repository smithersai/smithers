import { statSync } from "node:fs"
import { spawnSync } from "node:child_process"

import { HttpError } from "@/utils/http-error"

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type CommandRunner = (command: string, args: string[]) => CommandResult

type WorkflowOpenOptions = {
  platform?: NodeJS.Platform
  runCommand?: CommandRunner
}

function defaultRunCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = "status" in result ? (result.status ?? 1) : (result.exitCode ?? 1)
  const effectiveExitCode = exitCode === null ? 1 : exitCode

  return {
    exitCode: effectiveExitCode,
    stdout: result.stdout?.toString().trim() ?? "",
    stderr: result.stderr?.toString().trim() ?? "",
  }
}

function toCommandError(action: string, command: string, result: CommandResult) {
  const rawMessage = result.stderr || result.stdout
  const detail = rawMessage ? `: ${rawMessage}` : ""
  return `Failed to ${action} using command ${command}${detail}`
}

function escapeAppleScriptString(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function openFolderCommand(directoryPath: string, platform: NodeJS.Platform) {
  if (platform === "darwin") {
    return {
      command: "open",
      args: [directoryPath],
    }
  }

  if (platform === "win32") {
    return {
      command: "explorer",
      args: [directoryPath],
    }
  }

  return {
    command: "xdg-open",
    args: [directoryPath],
  }
}

function openTerminalCommands(directoryPath: string, platform: NodeJS.Platform) {
  if (platform === "darwin") {
    const escapedPath = escapeAppleScriptString(directoryPath)
    return [
      {
        command: "osascript",
        args: [
          "-e",
          `tell application "Terminal"\nactivate\ndo script "cd \\"${escapedPath}\\""\nend tell`,
        ],
      },
    ]
  }

  if (platform === "win32") {
    return [
      {
        command: "cmd",
        args: ["/c", "start", "", "/D", directoryPath, "cmd"],
      },
    ]
  }

  return [
    {
      command: "x-terminal-emulator",
      args: ["--working-directory", directoryPath],
    },
    {
      command: "gnome-terminal",
      args: ["--working-directory", directoryPath],
    },
    {
      command: "konsole",
      args: ["--workdir", directoryPath],
    },
  ]
}

function assertWorkflowDirectoryExists(workflowDirectoryPath: string) {
  const workflowDirectoryInfo = statSync(workflowDirectoryPath)
  if (!workflowDirectoryInfo.isDirectory()) {
    throw new HttpError(400, `Workflow path is not a directory: ${workflowDirectoryPath}`)
  }
}

export function openWorkflowFolder(
  workflowDirectoryPath: string,
  options: WorkflowOpenOptions = {}
) {
  const runCommand = options.runCommand ?? defaultRunCommand
  const platform = options.platform ?? process.platform

  assertWorkflowDirectoryExists(workflowDirectoryPath)

  const { command, args } = openFolderCommand(workflowDirectoryPath, platform)
  const result = runCommand(command, args)
  if (result.exitCode !== 0) {
    throw new HttpError(500, toCommandError("open workflow folder", command, result))
  }
}

export function openWorkflowTerminal(
  workflowDirectoryPath: string,
  options: WorkflowOpenOptions = {}
) {
  const runCommand = options.runCommand ?? defaultRunCommand
  const platform = options.platform ?? process.platform

  assertWorkflowDirectoryExists(workflowDirectoryPath)

  const commands = openTerminalCommands(workflowDirectoryPath, platform)
  let lastError: CommandResult | null = null

  for (const { command, args } of commands) {
    const result = runCommand(command, args)
    lastError = result
    if (result.exitCode === 0) {
      return
    }
  }

  if (lastError === null) {
    throw new HttpError(500, "No terminal command available for this platform")
  }

  throw new HttpError(500, toCommandError("open workflow terminal", commands[0]!.command, lastError))
}
