import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git, assertChangeBase, verifyChangeCommit, tutorialChangeRoute } from "./tutorial2-agent_change"
import { checkInputDigest, type Plan, type Result, type Revision } from "../../../../../flows/coding/schema"
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const fixture = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tutorial2-agent_change-")); dirs.push(cwd)
  await git(cwd, "init", "-b", "main"); await git(cwd, "config", "user.email", "test@example.invalid"); await git(cwd, "config", "user.name", "Test")
  await writeFile(join(cwd, "README.md"), "# Fixture\n")
  await git(cwd, "add", "README.md"); await git(cwd, "commit", "-m", "Initial")
  const base = await git(cwd, "rev-parse", "HEAD")
  const revision = (sha: string, parent: string[]): Revision => ({ commitId: sha, changeId: sha, treeId: "tree", operationId: "op", parentCommitIds: parent })
  const plan: Plan = { prompt: "Document fixture usage", memoryRevision: "1", base: revision(base, []), changes: [{
    id: "docs", title: "Document fixture usage", intent: "README has no usage instructions", implementation: "coding/Implement", implementationDigest: "digest",
    atoms: [{ changeId: null, message: "Document usage", intent: "Add example", reads: ["README.md"], writes: ["README.md"] }],
    checks: ["fast", "slow"].map(tier => ({ id: tier, target: "docs", flow: "docs/check", flowDigest: "digest", tier: tier as "fast" | "slow", required: true }))
  }] }
  const commit = async () => {
    await writeFile(join(cwd, "README.md"), "# Fixture\nRun the fixture.\n")
    await git(cwd, "add", "README.md"); await git(cwd, "commit", "-m", "Document usage")
    const sha = await git(cwd, "rev-parse", "HEAD"), head = revision(sha, [base])
    const implementation = { change: "docs", parent: plan.base, head, atoms: [head], reads: ["README.md"], writes: ["README.md"] }
    const result: Result = { status: "validated", findings: [], changes: [{ implementation, receipts: plan.changes[0]!.checks.map(check => ({
      checkId: check.id, target: check.target, tier: check.tier, change: "docs", commitId: sha, treeId: head.treeId,
      inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "Checked", findings: []
    })) }] }
    return { sha, result }
  }
  return { cwd, base, plan, commit }
}
test("preflight precedes writes and receipt matches one actual commit, parent and files", async () => {
  const { cwd, base, plan, commit } = await fixture()
  await assertChangeBase(cwd, plan)
  const { sha, result } = await commit()
  expect(await verifyChangeCommit(cwd, "owner/repo", "run-1", plan, result)).toEqual({ repo: "owner/repo", runId: "run-1", base, sha, parent: base, subject: "Document usage", files: ["README.md"] })
  await expect(assertChangeBase(cwd, plan)).rejects.toThrow("HEAD moved")
  expect(await git(cwd, "remote")).toBe("")
})
test("wrong files, failed check, dirty tree and moved HEAD refuse completion", async () => {
  const { cwd, plan, commit } = await fixture(), { result } = await commit()
  const wrong = { ...result, changes: [{ ...result.changes[0]!, implementation: { ...result.changes[0]!.implementation, writes: ["other.ts"] } }] }
  await expect(verifyChangeCommit(cwd, "o/r", "run", plan, wrong)).rejects.toThrow()
  const failed = { ...result, status: "changes-requested" as const }
  await expect(verifyChangeCommit(cwd, "o/r", "run", plan, failed)).rejects.toThrow()
  await writeFile(join(cwd, "extra"), "extra")
  await expect(verifyChangeCommit(cwd, "o/r", "run", plan, result)).rejects.toThrow()
  await git(cwd, "add", "extra"); await git(cwd, "commit", "-m", "Concurrent change")
  await expect(verifyChangeCommit(cwd, "o/r", "run", plan, result)).rejects.toThrow()
})
test("suggestion inspects real files and never executes before persisted review", async () => {
  const { cwd, base, plan } = await fixture()
  const route = tutorialChangeRoute({ resolveRepo: async () => cwd, suggest: async input => {
    expect(input.head).toBe(base); expect(input.files).toContainEqual({ path: "README.md", content: "# Fixture" }); return plan
  }, result: async () => { throw new Error("Must not execute") } })
  const response = await route(new Request("http://local/api/tutorial/change/plan", { method: "POST", body: JSON.stringify({ repo: "owner/repo" }) }))
  expect(response.status).toBe(200); expect(await response.json()).toEqual(plan)
  expect(await git(cwd, "rev-parse", "HEAD")).toBe(base)
  expect(await git(cwd, "status", "--porcelain")).toBe("")
})
