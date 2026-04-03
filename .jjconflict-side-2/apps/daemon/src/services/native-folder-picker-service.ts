import { HttpError } from "@/utils/http-error"

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type RunCommand = (command: string[]) => CommandResult

type PickDirectoryOptions = {
  platform?: NodeJS.Platform
  runCommand?: RunCommand
}

function defaultRunCommand(command: string[]): CommandResult {
  const result = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  }
}

function normalizePath(pathValue: string) {
  const trimmedPath = pathValue.trim()
  if (!trimmedPath) {
    return null
  }

  return trimmedPath.endsWith("/") ? trimmedPath.slice(0, -1) : trimmedPath
}

export function pickDirectoryWithNativeDialog(options: PickDirectoryOptions = {}) {
  const platform = options.platform ?? process.platform
  const runCommand = options.runCommand ?? defaultRunCommand

  if (platform !== "darwin") {
    throw new HttpError(
      501,
      `Native folder picker is currently supported only on macOS (current platform: ${platform})`
    )
  }

  const script = 'POSIX path of (choose folder with prompt "Select an existing repository")'
  const selectionResult = runCommand(["osascript", "-e", script])

  if (selectionResult.exitCode !== 0) {
    if (
      selectionResult.stderr.includes("User canceled") ||
      selectionResult.stderr.includes("(-128)")
    ) {
      return null
    }

    throw new HttpError(
      500,
      `Failed to open native folder picker: ${selectionResult.stderr || "Unknown error"}`
    )
  }

  return normalizePath(selectionResult.stdout)
}
