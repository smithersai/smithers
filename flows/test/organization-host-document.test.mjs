/**
 * The organization host's non-code deliveries and workspace endings, end to
 * end over the scripted host (`flows/organization/testing/scripted-host.ts`):
 *
 * - A lead holding `wiki-write` answers a request itself, with no handoff:
 *   its answer is written to the wiki as a document under `Org/Runs/`, the
 *   run completes `answered` with the document in its receipt, and the
 *   repository gains no branch and no machine is left.
 * - The same answer from a lead without `wiki-write` writes nothing and
 *   blocks the delivery, naming the missing grant.
 * - A delivery whose landing an owner declines at its Approval gate fails,
 *   and its builder's and checker's machines, kept while it was parked,
 *   are removed before the run ends.
 * - A lead's `hire` ask runs `organization/hire` as the delivery's child, and
 *   a later contract handing work to that hire runs `organization/delegate`;
 *   a `meeting` ask runs `organization/meetings-book`. Each child's ending is
 *   the delivery's.
 * - A checker holding a workspace reproduces in a machine of its own seeded
 *   with the collected change, the receipt records each configured check,
 *   and no machine is left once the change lands.
 *
 * The suite skips, by name, only on a host that cannot boot a microVM.
 *
 * Run: node --test flows/test/organization-host-document.test.mjs
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import * as Setup from "../organization/setup/microsandbox.ts"
import { branches, cleanup, host, line, organization, receipt, repository, run, settled, unbootable } from "../organization/testing/harness.mjs"

const missing = unbootable()
after(cleanup)

const documentRoles = JSON.stringify({ assistant: "route:lead", lead: "document" })

/** Grants the example lead `wiki-write`. */
const withWikiWrite = (org) => {
  const path = join(org, "Roles/lead.md")
  writeFileSync(path, readFileSync(path, "utf8").replace("tools: [memory, retrieval, wiki-read, delegate]", "tools: [memory, retrieval, wiki-read, wiki-write, delegate]"))
}

/** The machines this host's installation has booted and not removed. */
const machines = async (handle) => {
  const sdk = await Setup.sdkOf(Setup.locate())
  sdk.setDefaultBackend("local")
  const owner = readFileSync(join(handle.stateDir, "installation"), "utf8").trim()
  const found = []
  let cursor
  do {
    const after = cursor
    const page = await sdk.Sandbox.listWith((list) => {
      const scoped = list.label("smithers.provider", "microsandbox").label("smithers.owner", owner)
      return after === undefined ? scoped : scoped.cursor(after)
    })
    found.push(...page.sandboxes)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return found
}

describe("organization host documents and workspace endings", { skip: missing }, () => {
  it("writes a lead's own answer to the wiki as a document", { timeout: 300_000 }, async () => {
    const root = organization(withWikiWrite)
    const repo = repository()
    const handle = await host(root, repo, { SMITHERS_ORGANIZATION_SCRIPTED_ROLES: documentRoles })
    await handle.start()
    const output = run(handle, "submit", "Write the release brief.", "--key", "e2e-brief", "--wait", "--root", root)
    assert.match(output, /completed\nanswered: The brief is written\.\nreceipt Org\/Runs\/cli-e2e-brief\/deliver\.json$/)
    const report = receipt(root, "cli:e2e-brief").report
    assert.equal(report.status, "answered")
    assert.equal(report.document, "Org/Runs/cli-e2e-brief/lead.md")
    const page = readFileSync(join(root, report.document), "utf8")
    assert.match(page, /^# The brief is written\.\n\nlead · done\n\n## acceptance\n\nDrafted in the wiki\.\n/)
    assert.match(page, /\n## Evidence\n\n- note `scripted`: scripted answer\n$/)
    assert.deepEqual(branches(repo), [])
    assert.deepEqual(await machines(handle), [])
    await handle.stop()
  })

  it("blocks a document from a lead that cannot write the wiki", { timeout: 300_000 }, async () => {
    const root = organization()
    const repo = repository()
    const handle = await host(root, repo, { SMITHERS_ORGANIZATION_SCRIPTED_ROLES: documentRoles })
    await handle.start()
    const runId = /^started (\S+)$/.exec(run(handle, "submit", "Write the release brief.", "--key", "e2e-no-grant"))?.[1]
    assert.equal((await settled(handle, runId)).status, "failed", handle.output())
    const report = receipt(root, "cli:e2e-no-grant").report
    assert.equal(report.status, "blocked")
    assert.equal(report.summary, "lead holds no wiki-write")
    assert.equal(existsSync(join(root, "Org/Runs/cli-e2e-no-grant/lead.md")), false)
    await handle.stop()
  })

  it("removes the workspace machine of a delivery whose landing is declined", { timeout: 420_000 }, async () => {
    const root = organization((org) => writeFileSync(join(org, "Policy/Gates.md"), [
      "---",
      "revision: e2e-decline",
      "gates:",
      "  - at: { boundary: external-write, target: organization/apply-change }",
      "    spec: { _tag: Approval, id: land, approver: owner, prompt: \"Land this change?\" }",
      "---",
      "",
      "# Gates",
      ""
    ].join("\n")))
    const repo = repository()
    const handle = await host(root, repo)
    await handle.start()
    const runId = /^started (\S+)$/.exec(run(handle, "submit", "Add a line to README.md", "--key", "e2e-decline"))?.[1]
    assert.equal((await settled(handle, runId, ["waiting-approval", "completed", "failed"])).status, "waiting-approval", handle.output())
    assert.equal((await machines(handle)).length, 2, "the parked run keeps its builder's and its checker's machines")
    assert.equal(run(handle, "answer", "land", "decline"), `declined land for ${runId}`)
    assert.equal((await settled(handle, runId)).status, "failed", handle.output())
    assert.equal(receipt(root, "cli:e2e-decline").report.status, "failed")
    assert.deepEqual(await machines(handle), [], "the declined run removed both machines")
    assert.deepEqual(branches(repo), [])
    await handle.stop()
  })

  it("gives the checker its own machine holding the change, and records the checks", { timeout: 300_000 }, async () => {
    const root = organization()
    const repo = repository()
    const handle = await host(root, repo, { SMITHERS_ORGANIZATION_SCRIPTED_CHECK_SHOWS: "1" })
    await handle.start()
    const runId = /^started (\S+)$/.exec(run(handle, "submit", "Add a line to README.md", "--key", "e2e-own-check"))?.[1]
    assert.equal((await settled(handle, runId)).status, "completed", handle.output())
    const report = receipt(root, "cli:e2e-own-check").report
    assert.equal(report.status, "landed")
    assert.match(report.summary, new RegExp(`^Seen: .*${line}`))
    assert.equal(report.checks.length, 1)
    assert.deepEqual({ ...report.checks[0], durationMs: 0 }, { name: "readme", exitCode: 0, timedOut: false, durationMs: 0, tail: "" })
    assert.deepEqual(await machines(handle), [])
    await handle.stop()
  })

  it("runs a lead's hire, a delegation to its hire, and a meeting ask as child flows", { timeout: 420_000 }, async () => {
    const root = organization((org) => {
      withWikiWrite(org)
      const page = join(org, "Meetings.md")
      writeFileSync(page, readFileSync(page, "utf8")
        .replace("timezone: null", "timezone: America/Los_Angeles")
        .replace("start: null", "start: \"10:00\"")
        .replace("firstDate: null", "firstDate: \"2026-10-02\""))
    })
    const repo = repository()
    const researcher = {
      slug: "researcher",
      name: "Competitor Researcher",
      objective: "Compare what competitors charge and give, with a source and date for every row.",
      responsibilities: ["Collect competitor pricing with sources and dates"],
      tools: ["wiki-read", "wiki-write"],
      knowledge: ["Org/Roles/"]
    }
    const hiring = await host(root, repo, {
      SMITHERS_ORGANIZATION_SCRIPTED_ROLES: JSON.stringify({ assistant: "route:lead", lead: "ask-hire" }),
      SMITHERS_ORGANIZATION_SCRIPTED_HIRE: JSON.stringify({ lead: researcher })
    })
    await hiring.start()
    const hired = /^started (\S+)$/.exec(run(hiring, "submit", "Get a competitor pricing brief.", "--key", "e2e-hire"))?.[1]
    assert.equal((await settled(hiring, hired)).status, "completed", hiring.output())
    const hire = receipt(root, "cli:e2e-hire").report
    assert.equal(hire.status, "answered")
    assert.deepEqual(hire.child, {
      flow: "organization/hire",
      status: "hired",
      summary: hire.summary,
      paths: ["Org/Specialists/lead.researcher.md"]
    })
    await hiring.stop()

    const delegating = await host(root, repo, {
      SMITHERS_ORGANIZATION_SCRIPTED_ROLES: JSON.stringify({ assistant: "route:lead", lead: "contract:lead.researcher,checker" })
    })
    await delegating.start()
    const delegated = /^started (\S+)$/.exec(run(delegating, "submit", "Refresh the pricing brief.", "--key", "e2e-delegate"))?.[1]
    assert.equal((await settled(delegating, delegated)).status, "completed", delegating.output())
    const delegation = receipt(root, "cli:e2e-delegate").report
    assert.equal(delegation.child.flow, "organization/delegate")
    assert.equal(delegation.child.status, "accepted")
    assert.deepEqual(branches(repo), [])
    await delegating.stop()

    const meeting = await host(root, repo, {
      SMITHERS_ORGANIZATION_SCRIPTED_ROLES: JSON.stringify({ assistant: "route:lead", lead: "ask-meeting" })
    })
    await meeting.start()
    const asked = /^started (\S+)$/.exec(run(meeting, "submit", "Settle the launch scope.", "--key", "e2e-meeting"))?.[1]
    await settled(meeting, asked)
    const booking = receipt(root, "cli:e2e-meeting").report
    assert.equal(booking.status, "answered", JSON.stringify(booking))
    assert.equal(booking.child.flow, "organization/meetings-book")
    assert.equal(booking.child.status, "booked")
    assert.match(readFileSync(join(root, "Org/Runs/meetings/bookings.md"), "utf8"), /Decide the launch scope\./)
    await meeting.stop()
  })
})
