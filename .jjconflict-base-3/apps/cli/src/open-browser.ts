type OpenResult =
  | { ok: true }
  | {
      ok: false
      error: string
    }

function getOpenCommand(url: string) {
  if (process.platform === "darwin") {
    return ["open", url]
  }

  if (process.platform === "win32") {
    return ["cmd", "/c", "start", "", url]
  }

  return ["xdg-open", url]
}

export async function openInBrowser(url: string): Promise<OpenResult> {
  const command = getOpenCommand(url)

  try {
    const processHandle = Bun.spawn(command, {
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    })

    const exitCode = await processHandle.exited
    if (exitCode === 0) {
      return { ok: true }
    }

    const errorOutput = await new Response(processHandle.stderr).text()
    const trimmedError = errorOutput.trim()

    return {
      ok: false,
      error: trimmedError.length > 0 ? trimmedError : `open command exited with code ${exitCode}`,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
