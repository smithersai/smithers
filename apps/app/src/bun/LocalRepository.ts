import { constants } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { basename } from "node:path"
import type {
  InspectLocalRepositoryResult,
  LocalRepositoryInspection,
  RepositoryAccess
} from "@smthrs/rpc/NativeRepository"
import { sanitizeRemoteUrl } from "./sanitizeRemoteUrl"

const git = async (
  directory: string,
  args: ReadonlyArray<string>
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const process = Bun.spawn(["git", "-C", directory, ...args], {
    env: { ...(Bun.env as Record<string, string | undefined>), GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

const optionalGitValue = async (
  directory: string,
  args: ReadonlyArray<string>
): Promise<string | null> => {
  const result = await git(directory, args)
  return result.exitCode === 0 && result.stdout !== "" ? result.stdout : null
}

const permissionError = (accessMode: RepositoryAccess): InspectLocalRepositoryResult => ({
  status: "error",
  code: "permission-denied",
  message: accessMode === "read-write"
    ? "Smithers cannot read and write this repository. Choose read-only access or update its filesystem permissions."
    : "Smithers cannot read this repository. Update its filesystem permissions and try again."
})

export const inspectLocalRepository = async (
  selectedPath: string,
  accessMode: RepositoryAccess
): Promise<InspectLocalRepositoryResult> => {
  let selectedDirectory: string
  try {
    selectedDirectory = await realpath(selectedPath)
    if (!(await stat(selectedDirectory)).isDirectory()) {
      return {
        status: "error",
        code: "not-a-directory",
        message: "Choose a repository folder, not a file."
      }
    }
    await access(
      selectedDirectory,
      accessMode === "read-write" ? constants.R_OK | constants.W_OK : constants.R_OK
    )
  } catch {
    return permissionError(accessMode)
  }

  const rootResult = await git(selectedDirectory, ["rev-parse", "--show-toplevel"])
  if (rootResult.exitCode !== 0 || rootResult.stdout === "") {
    return {
      status: "error",
      code: "not-a-repository",
      message: "That folder is not inside a Git repository."
    }
  }

  try {
    const root = await realpath(rootResult.stdout)
    await access(root, accessMode === "read-write" ? constants.R_OK | constants.W_OK : constants.R_OK)
    const [head, branch, remoteUrl] = await Promise.all([
      optionalGitValue(root, ["rev-parse", "--verify", "HEAD"]),
      optionalGitValue(root, ["branch", "--show-current"]),
      optionalGitValue(root, ["remote", "get-url", "origin"])
    ])
    const repository: LocalRepositoryInspection = {
      root,
      name: basename(root),
      head,
      branch,
      remoteUrl: sanitizeRemoteUrl(remoteUrl)
    }
    return { status: "connected", repository }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES") return permissionError(accessMode)
    return {
      status: "error",
      code: "inspection-failed",
      message: "Smithers could not inspect this repository. Check that Git is installed and try again."
    }
  }
}
