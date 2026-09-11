import { Schema } from "effect"
import { Plan, Result, receiptMatches } from "../../../../../flows/coding/schema"
import { validateTutorialPlan, type ChangeReceipt } from "../../mainview/cards/tutorial2-agent_change-contract"

/** Host resolves repository authority and existing agent/runtime services, never a browser path. */
export interface TutorialChangeHost {
  resolveRepo(repo: string): Promise<string>
  suggest(input: { repo: string; head: string; files: Array<{ path: string; content: string }>; feature?: string }): Promise<unknown>
  result(repo: string, runId: string): Promise<unknown>
}
export const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })
  const [out, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(error.trim() || "Git could not inspect the repository.")
  return out.trimEnd()
}
export const assertChangeBase = async (cwd: string, plan: Plan) => {
  validateTutorialPlan(plan)
  if (await git(cwd, "rev-parse", "HEAD") !== plan.base.commitId) throw new Error("HEAD moved; request a new plan.")
  if (await git(cwd, "status", "--porcelain")) throw new Error("The repository has uncommitted changes; finish them before starting this change.")
}
export const verifyChangeCommit = async (cwd: string, repo: string, runId: string, plan: Plan, rawResult: unknown): Promise<ChangeReceipt> => {
  validateTutorialPlan(plan)
  const result = Schema.decodeUnknownSync(Result)(rawResult)
  if (result.status !== "validated" || result.changes.length !== 1) throw new Error("The change has not passed its checks.")
  const implementation = result.changes[0]!.implementation
  if (result.findings.length || plan.changes[0]!.checks.some(check => check.required && check.tier !== "delivery" &&
    !result.changes[0]!.receipts.some(receipt => receipt.status === "passed" && receiptMatches(implementation, check, receipt)))) throw new Error("Required checks have no matching successful receipts.")
  const sha = implementation.head.commitId
  if (!/^[a-f0-9]{40,64}$/.test(sha) || implementation.atoms.length !== 1 || implementation.parent.commitId !== plan.base.commitId || implementation.change !== plan.changes[0]!.id) throw new Error("The result does not match the planned commit.")
  const [head, parents, subject, paths, count, status] = await Promise.all([
    git(cwd, "rev-parse", "HEAD"), git(cwd, "show", "-s", "--format=%P", sha), git(cwd, "show", "-s", "--format=%s", sha),
    git(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha), git(cwd, "rev-list", "--count", `${plan.base.commitId}..${sha}`), git(cwd, "status", "--porcelain")
  ])
  const files = paths.split("\0").filter(Boolean).sort()
  if (head !== sha || parents !== plan.base.commitId || count !== "1" || status || files.length === 0 || JSON.stringify(files) !== JSON.stringify([...new Set(implementation.writes)].sort())) throw new Error("The actual commit, parent, or changed files differ from the run receipt.")
  return { repo, runId, base: plan.base.commitId, sha, parent: parents, subject, files }
}

/** Mount behind the host's existing authenticated/CSRF-protected /api router. */
export const tutorialChangeRoute = (host: TutorialChangeHost) => async (request: Request): Promise<Response> => {
  try {
    if (request.method !== "POST") return Response.json({ message: "POST required" }, { status: 405 })
    const input = await request.json() as { repo?: unknown; feature?: unknown; plan?: unknown; runId?: unknown }
    if (typeof input.repo !== "string" || !input.repo) throw new Error("Choose a repository.")
    const cwd = await host.resolveRepo(input.repo)
    const verb = new URL(request.url).pathname.split("/").at(-1)
    if (verb === "plan") {
      const head = await git(cwd, "rev-parse", "HEAD")
      const paths = (await git(cwd, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")
        .filter(path => /(?:README\.md|package\.json|\.(?:ts|tsx|rs|py|go))$/.test(path)).slice(0, 24)
      const files = await Promise.all(paths.map(async path => ({ path, content: (await git(cwd, "show", `${head}:${path}`)).slice(0, 12000) })))
      const plan = validateTutorialPlan(Schema.decodeUnknownSync(Plan)(await host.suggest({ repo: input.repo, head, files, ...(typeof input.feature === "string" ? { feature: input.feature } : {}) })))
      if (plan.base.commitId !== head) throw new Error("The suggested plan changed the captured HEAD.")
      await assertChangeBase(cwd, plan)
      return Response.json(plan)
    }
    const plan = Schema.decodeUnknownSync(Plan)(input.plan)
    if (verb === "preflight") { await assertChangeBase(cwd, plan); return Response.json({ ready: true }) }
    if (verb === "receipt" && typeof input.runId === "string") return Response.json(await verifyChangeCommit(cwd, input.repo, input.runId, plan, await host.result(input.repo, input.runId)))
    return Response.json({ message: "Unknown change action." }, { status: 404 })
  } catch (error) { return Response.json({ message: error instanceof Error ? error.message : String(error) }, { status: 409 }) }
}
