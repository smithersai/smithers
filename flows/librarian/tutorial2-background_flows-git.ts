import { spawn } from "node:child_process"
/** Argument arrays only; never checks out, resets, stages, or touches the worktree. */
export const git = (cwd: string, args: readonly string[], input?: string, env: Record<string, string> = {}): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn("git", ["-C", cwd, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] })
  let out = "", error = ""
  child.stdout.setEncoding("utf8").on("data", chunk => { out += chunk })
  child.stderr.setEncoding("utf8").on("data", chunk => { error += chunk })
  child.on("error", reject)
  child.on("close", code => code === 0 ? resolve(out.replace(/\n$/, "")) : reject(new Error(error.trim() || `git exited ${code}`)))
  child.stdin.on("error", () => {})
  child.stdin.end(input)
})
export const sourceRevision = async (root: string) => {
  const head = await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])
  const tree = await git(root, ["rev-parse", `${head}^{tree}`])
  const date = await git(root, ["show", "-s", "--format=%cI", head])
  return { head, tree, date }
}
export const commitEnvironment = (date: string) => ({
  GIT_AUTHOR_NAME: "Smithers Librarian", GIT_AUTHOR_EMAIL: "librarian@smithers.local",
  GIT_COMMITTER_NAME: "Smithers Librarian", GIT_COMMITTER_EMAIL: "librarian@smithers.local",
  GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date
})
