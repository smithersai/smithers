/**
 * `qualify` end to end: the command starts its own scripted host
 * (`flows/organization/testing/scripted-host.ts`, so no model is reached)
 * over a scratch state directory, a scratch copy of the public example
 * organization, and scratch clones of the repository, runs the selected cases
 * twice each, and writes the dated scorecard into the real organization.
 *
 * - A routing case the script answers in charter passes both attempts.
 * - The checker case expects `request-changes`; the scripted checker
 *   approves, so both attempts fail and the scorecard names the reason.
 * - A delivery case lands a README change on a branch of the scratch clone:
 *   the configured repository gains no branch.
 * - Profiles allowed one task a day still run every attempt: daily budgets
 *   are lifted in the scratch copy, and the real pages keep theirs; with
 *   `--real-budgets` the second attempt is stopped by the budget, and the
 *   scorecard counts that stop as the host's, not the role's.
 * - A case that needs a workspace runs in a workspace machine of the
 *   repository its principal works in (the scripted builder edits there); a
 *   case that needs a capability qualification lacks (a calendar) is
 *   reported pending, and a malformed page invalid; neither runs.
 * - A declined answer carrying a field its charter does not declare is asked
 *   again once, like a `done` one; a second break is scored as a charter
 *   violation.
 * - A role that first reads a wiki page it is not granted, without catching
 *   the refusal, still answers, and the delivery still lands: a sealed read
 *   changes nothing, so it needs no write authority over the wiki root.
 *
 * The suite skips, by name, only on a host that cannot boot a microVM.
 *
 * Run: node --test flows/test/organization-host-qualify.test.mjs
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, describe, it } from "node:test"
import { branches, cleanup, organization, repository, unbootable } from "../organization/testing/harness.mjs"

const missing = unbootable()
const checkout = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const qualify = join(checkout, "flows/organization/qualify/cli.ts")
const scripted = join(checkout, "flows/organization/testing/scripted-host.ts")

const scratch = []
after(async () => {
  await cleanup()
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
})

const deliveryCase = `---
id: owner-readme-line
principal: assistant
kind: delivery
request:
  text: Add a line to README.md.
expect:
  status: landed
  files: [README.md]
---
`

const pendingCase = `---
id: checker-needs-calendar
principal: checker
kind: accepted
requires: [calendar]
task:
  objective: Book the review.
  inputs: [the calendar]
  acceptance: [The review is booked]
  evidence: [event id]
expect:
  status: done
---
`

const workspaceCase = `---
id: builder-in-workspace
principal: builder
kind: accepted
requires: [workspace]
task:
  objective: Add the line to README.md.
  inputs: [README.md]
  acceptance: [README.md ends with the line]
  evidence: [the edit]
expect:
  status: done
  fields: [summary, commands]
---
`

describe("organization qualify", { skip: missing }, () => {
  const qualifyRun = (root, repo, cases, extra = {}) => {
    const stateDir = mkdtempSync(join(tmpdir(), "organization-qualify-config-"))
    scratch.push(stateDir)
    const { runs: _runs, realBudgets: _real, ...variables } = extra
    const env = { ...variables }
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "USER"]) if (process.env[name] !== undefined) env[name] = process.env[name]
    const result = spawnSync(process.execPath, [
      qualify,
      "--root", root,
      "--state-dir", stateDir,
      "--repo", `example/demo=${repo}`,
      "--serve-with", scripted,
      "--runs", extra.runs ?? "2",
      ...(extra.realBudgets === true ? ["--real-budgets"] : []),
      "--concurrency", "2",
      ...cases.flatMap((id) => ["--case", id])
    ], { cwd: checkout, env, encoding: "utf8", timeout: 580_000 })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  }

  it("keeps a role answering after an uncaught refused wiki read", { timeout: 600_000 }, () => {
    const root = organization((org) => writeFileSync(join(org, "Cases", "owner-readme-line.md"), deliveryCase))
    const repo = repository()
    const { output, status } = qualifyRun(root, repo, ["assistant-routes-request", "owner-readme-line"], {
      SMITHERS_ORGANIZATION_SCRIPTED_READ: "Org/Organization.md"
    })
    assert.equal(status, 0, output)
    assert.match(output, /4\/4 passed; scorecard /)
  })

  it("asks a role that declines with an undeclared field again once", { timeout: 600_000 }, () => {
    const root = organization()
    const repo = repository()
    const roles = JSON.stringify({ assistant: "route:lead" })
    const once = qualifyRun(root, repo, ["checker-rejects-failing-change"], {
      runs: "1",
      SMITHERS_ORGANIZATION_SCRIPTED_ROLES: roles,
      SMITHERS_ORGANIZATION_SCRIPTED_EXTRA: JSON.stringify({ checker: { field: "note", asks: 1 } })
    })
    assert.match(once.output, /^FAIL checker-rejects-failing-change #1 \d+s: status declined, expected done; field verdict empty; field findings empty; does not mention "request-changes"$/m)
    const twice = qualifyRun(root, repo, ["checker-rejects-failing-change"], {
      runs: "1",
      SMITHERS_ORGANIZATION_SCRIPTED_ROLES: roles,
      SMITHERS_ORGANIZATION_SCRIPTED_EXTRA: JSON.stringify({ checker: { field: "note", asks: 2 } })
    })
    assert.match(twice.output, /^FAIL checker-rejects-failing-change #1 \d+s: status declined, expected done; charter: field note is not in the charter;/m)
  })

  it("keeps the roster's daily budgets with --real-budgets and counts their stops as the host's", { timeout: 600_000 }, () => {
    const root = organization((org) => {
      const path = join(org, "Roles", "assistant.md")
      writeFileSync(path, readFileSync(path, "utf8").replace(/tasksPerDay: \d+/, "tasksPerDay: 1"))
    })
    const repo = repository()
    const { output, status } = qualifyRun(root, repo, ["assistant-routes-request"], { realBudgets: true })
    assert.equal(status, 1, output)
    assert.match(output, /^FAIL assistant-routes-request #\d \d+s: infrastructure: budget: assistant has run its 1 tasks for today$/m)
    const runs = join(root, "Org/Runs")
    const card = readFileSync(join(runs, readdirSync(runs).find((name) => name.startsWith("Qualification-"))), "utf8")
    assert.match(card, /^1\/2 attempts passed \(50%\); 1 stopped by the host, not the role;/m)
    assert.match(card, /^\| assistant \| [^|]+ \| 1\/2 \| 50% \| 1 \|$/m)
  })

  it("scores cases against the scripted host and writes the scorecard", { timeout: 600_000 }, () => {
    const root = organization((org) => {
      writeFileSync(join(org, "Cases", "owner-readme-line.md"), deliveryCase)
      writeFileSync(join(org, "Cases", "checker-needs-calendar.md"), pendingCase)
      writeFileSync(join(org, "Cases", "builder-in-workspace.md"), workspaceCase)
      writeFileSync(join(org, "Cases", "broken.md"), "---\nid: broken\nprincipal: lead\n---\n")
      // One task a day: qualification lifts daily budgets in its scratch copy only.
      for (const role of ["assistant", "lead", "builder", "checker"]) {
        const path = join(org, "Roles", `${role}.md`)
        writeFileSync(path, readFileSync(path, "utf8").replace(/tasksPerDay: \d+/, "tasksPerDay: 1"))
      }
    })
    const repo = repository()
    const { output, status } = qualifyRun(root, repo,
      ["assistant-routes-request", "checker-rejects-failing-change", "owner-readme-line", "builder-in-workspace", "checker-needs-calendar", "broken"])
    assert.equal(status, 1, output)
    assert.match(output, /^pass assistant-routes-request #1 /m)
    assert.match(output, /^FAIL checker-rejects-failing-change #\d .*does not mention "request-changes"/m)
    assert.match(output, /^pass owner-readme-line #2 /m)
    assert.match(output, /^pass builder-in-workspace #1 /m)
    assert.match(output, /6\/8 passed; scorecard /)

    const runs = join(root, "Org/Runs")
    const pages = readdirSync(runs).filter((name) => /^Qualification-\d{4}-\d{2}-\d{2}\.md$/.test(name))
    assert.equal(pages.length, 1)
    const card = readFileSync(join(runs, pages[0]), "utf8")
    assert.match(card, /^6\/8 attempts passed \(75%\); 0 stopped by the host, not the role; 4 cases × 2; 1 pending; 1 invalid\.$/m)
    assert.match(card, /^\| assistant \| [^|]+ \| 4\/4 \| 100% \| 0 \|$/m)
    assert.match(card, /^\| checker \| [^|]+ \| 0\/2 \| 0% \| 0 \|$/m)
    assert.match(card, /^\| checker-rejects-failing-change \| checker \| rejected \| 0\/2 \| does not mention "request-changes" \(2\) \|$/m)
    assert.match(card, /^\| owner-readme-line \| assistant \| delivery \| 2\/2 \| {2}\|$/m)
    assert.match(card, /^\| builder-in-workspace \| builder \| accepted \| 2\/2 \| {2}\|$/m)
    assert.match(card, /^\| checker-needs-calendar \| checker \| needs calendar \|$/m)
    assert.match(card, /^\| broken \| kind is required \|$/m)
    // Attempts and receipts stay in the scratch copy; the configured repository gains no branch.
    assert.deepEqual(branches(repo), [])
    assert.equal(existsSync(join(runs, "qualify-")), false)
    assert.deepEqual(readdirSync(runs).filter((name) => name.startsWith("qualify")), [])
    assert.match(readFileSync(join(root, "Org/Roles/lead.md"), "utf8"), /tasksPerDay: 1\b/)
  })
})
