/**
 * A state directory moved while a run is parked still resumes it: the
 * host's flow catalog keeps the identity it was first started with, so a
 * backup restored to another directory answers the gate and lands.
 *
 * Real local microVMs and scripted seats, as in `organization-host.test.mjs`.
 *
 * Run: node --test flows/test/organization-host-relocate.test.mjs
 */
import assert from "node:assert/strict"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  branches,
  cleanup,
  git,
  host,
  line,
  organization,
  receipt,
  repository,
  run,
  settled,
  unbootable
} from "../organization/testing/harness.mjs"

const missing = unbootable()

after(cleanup)

describe("a relocated organization host", { skip: missing === undefined ? false : `skipped: ${missing}` }, () => {
  it("resumes a run parked at a gate after its state directory moved", { timeout: 420_000 }, async () => {
    const repo = repository()
    const main = git(repo, "rev-parse", "main")
    const root = organization((org) => writeFileSync(join(org, "Policy/Gates.md"), [
      "---",
      "revision: e2e-relocate",
      "gates:",
      "  - at: { boundary: external-write, target: organization/apply-change }",
      "    spec: { _tag: Approval, id: land, approver: owner, prompt: \"Land this change?\" }",
      "---",
      "",
      "# Gates",
      ""
    ].join("\n")))
    const before = await host(root, repo)
    await before.start()
    const runId = /^started (\S+)$/.exec(run(before, "submit", "Add a line to README.md", "--key", "e2e-relocate"))?.[1]
    assert.ok(runId)
    assert.equal((await settled(before, runId, ["waiting-approval", "completed", "failed"])).status, "waiting-approval", before.output())
    const identity = readFileSync(join(before.stateDir, "catalog", "intake.json"), "utf8")
    await before.stop()

    // Restore the state directory somewhere else, as a backup would be.
    const after = await host(root, repo)
    rmSync(after.stateDir, { recursive: true, force: true })
    renameSync(before.stateDir, after.stateDir)
    await after.start()
    assert.equal(readFileSync(join(after.stateDir, "catalog", "intake.json"), "utf8"), identity)
    const resumed = await settled(after, runId, ["waiting-approval", "completed", "failed"])
    assert.equal(resumed.status, "waiting-approval", after.output())

    assert.equal(run(after, "answer", "land", "approve"), `approved land for ${runId}`)
    assert.equal((await settled(after, runId)).status, "completed", after.output())
    const report = receipt(root, "cli:e2e-relocate").report
    assert.equal(report.status, "landed")
    assert.deepEqual(branches(repo), [report.applied.branch])
    assert.equal(git(repo, "show", `${report.applied.branch}:README.md`), `# Demo\n${line}`)
    assert.equal(git(repo, "rev-parse", "main"), main)
    await after.stop()
  })
})
