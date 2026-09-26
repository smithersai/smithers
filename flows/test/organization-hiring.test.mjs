/**
 * Hiring, delegation, review, retirement, and budgets on the organization
 * host, end to end with scripted seats: the lead hires a researcher (its
 * structured `hire` field, validated against the hiring rules), the host
 * writes it to `Org/Specialists/` with a receipt, hands it its first task,
 * the lead reviews the output and the accepted brief lands in the wiki; the
 * researcher's daily task limit blocks the next task with a visible receipt;
 * retiring it (and everything it hired) refuses every later task. Widened
 * grants, a personal grant, a hire past the lead's depth, and a hire by a
 * retired principal are refused with the rule each breaks, and a restarted
 * host still knows every hire.
 *
 * Run: node --test flows/test/organization-hiring.test.mjs
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { cleanup, host, organization, repository, settled } from "../organization/testing/harness.mjs"

after(cleanup)

const researcher = {
  slug: "researcher",
  name: "Competitor Researcher",
  objective: "Compare what competitors charge and give, with a source and date for every row.",
  responsibilities: ["Collect competitor pricing with sources and dates", "Label every unverified claim"],
  tools: ["wiki-read", "wiki-write"],
  knowledge: ["Org/Roles/"],
  budget: { tokensPerTask: 50000, tasksPerDay: 1 }
}

const specs = {
  "hire-research": researcher,
  "hire-wide": { ...researcher, slug: "wide", tools: ["workspace"] },
  "hire-personal": { ...researcher, slug: "personal", personalAccounts: true },
  "hire-deputy": {
    ...researcher,
    slug: "deputy",
    kind: "helper",
    tools: ["wiki-read"],
    hiring: { maxDepth: 0, maxChildren: 1, maxPersistent: 0 }
  },
  "hire-too-deep": { ...researcher, slug: "sub", kind: "helper", tools: [] },
  "hire-after-retired": { ...researcher, slug: "late", kind: "helper", tools: [] },
  "hire-web-wide": { ...researcher, slug: "webwide", kind: "helper", tools: ["retrieval"], retrieval: { allow: ["example.org"] } }
}

const staffReceipt = (root, key, name) =>
  JSON.parse(readFileSync(join(root, "Org/Runs", key.replaceAll(/[^A-Za-z0-9._-]/g, "-"), `${name}.json`), "utf8"))

const frontmatter = (text) => Object.fromEntries(
  text.split("\n---")[0].split("\n").filter((line) => /^[a-zA-Z]+: /.test(line)).map((line) => {
    const index = line.indexOf(": ")
    return [line.slice(0, index), line.slice(index + 2).trim()]
  })
)

describe("hiring on the organization host", () => {
  it("hires, delegates, reviews, blocks on budget, retires, and refuses what the rules forbid", { timeout: 300_000 }, async () => {
    const root = organization((org) => {
      const lead = join(org, "Roles/lead.md")
      writeFileSync(lead, readFileSync(lead, "utf8")
        .replace("tools: [memory, retrieval, wiki-read, delegate]", "tools: [memory, retrieval, wiki-read, wiki-write, delegate]")
        .replace("  repositories: [example/demo]", "  repositories: [example/demo]\n  retrieval: { allow: [cursor.com, devin.ai] }"))
    })
    const handle = await host(root, repository(), {
      SMITHERS_ORGANIZATION_SCRIPTED_HIRE: JSON.stringify(specs),
      SMITHERS_ORGANIZATION_SCRIPTED_ROLES: JSON.stringify({ lead: "document" })
    })
    await handle.start()
    const start = async (flow, input) => {
      const started = await handle.ops.start(`organization/${flow}`, input, input.key)
      return settled(handle, started.runId)
    }

    // The lead hires a researcher and hands it its first task.
    const hired = await start("hire", {
      key: "hire-research",
      parent: "lead",
      need: "What do competitors give for $20? A sourced brief.",
      task: "Write a sourced pricing brief.",
      acceptance: ["Every row has a source and a date."]
    })
    assert.equal(hired.status, "completed", handle.output())
    const hire = staffReceipt(root, "hire-research", "hire").report
    assert.equal(hire.status, "hired")
    assert.equal(hire.principal, "lead.researcher")
    assert.deepEqual(hire.paths, ["Org/Specialists/lead.researcher.md"])
    assert.equal(hire.delegated, "hire-research.task")
    const profile = frontmatter(readFileSync(join(root, "Org/Specialists/lead.researcher.md"), "utf8"))
    assert.equal(profile.status, "active")
    assert.equal(profile.kind, "specialist")
    assert.equal(profile.hiredBy, "lead")
    assert.equal(profile.reportsTo, "lead")
    assert.match(readFileSync(join(root, "Org/Specialists/lead.researcher.md"), "utf8"), /namespace: agent-lead\.researcher/)

    // Its first task was reviewed by the lead and its brief is in the wiki.
    const first = staffReceipt(root, "hire-research.task", "delegate").report
    assert.equal(first.status, "accepted", JSON.stringify(first))
    assert.deepEqual(first.paths, ["Org/Runs/hire-research.task/lead.researcher.md"])
    const brief = readFileSync(join(root, first.paths[0]), "utf8")
    assert.match(brief, /Cursor Pro \$20\/month/)
    assert.match(brief, /## Review\n\nAccepted by lead: Verified against the pricing page\./)

    // A second task the same day passes its one-task limit: blocked, with the limit in the receipt.
    const again = await start("delegate", {
      key: "brief-2",
      parent: "lead",
      specialist: "lead.researcher",
      objective: "Refresh the brief."
    })
    assert.equal(again.status, "failed")
    const limited = staffReceipt(root, "brief-2", "delegate").report
    assert.equal(limited.status, "blocked")
    assert.equal(limited.summary, "budget: lead.researcher has run its 1 tasks for today")

    // A principal that did not hire it may not delegate to it.
    const foreign = await start("delegate", { key: "foreign", parent: "checker", specialist: "lead.researcher", objective: "Anything." })
    assert.equal(foreign.status, "failed")
    assert.equal(staffReceipt(root, "foreign", "delegate").report.summary, "checker did not hire lead.researcher")

    // Grants the lead lacks, and personal accounts, are refused with the rule broken.
    for (const [key, code] of [["hire-wide", "grants-widen"], ["hire-personal", "hired-personal"]]) {
      const run = await start("hire", { key, parent: "lead", need: "Another hire." })
      assert.equal(run.status, "failed")
      const report = staffReceipt(root, key, "hire").report
      assert.equal(report.status, "refused")
      assert.ok(report.violations.some((violation) => violation.code === code), JSON.stringify(report))
    }
    assert.equal(existsSync(join(root, "Org/Specialists/lead.wide.md")), false)
    assert.equal(existsSync(join(root, "Org/Specialists/lead.personal.md")), false)

    // A web scope outside the lead's (cursor.com, devin.ai) is refused.
    assert.equal((await start("hire", { key: "hire-web-wide", parent: "lead", need: "A web hire." })).status, "failed")
    assert.ok(staffReceipt(root, "hire-web-wide", "hire").report.violations.some((violation) =>
      violation.code === "grants-widen" && violation.message.includes("example.org")))

    // A deputy may hire, but nothing below it: the lead allows one level.
    assert.equal((await start("hire", { key: "hire-deputy", parent: "lead", need: "A deputy." })).status, "completed")
    const tooDeep = await start("hire", { key: "hire-too-deep", parent: "lead.deputy", need: "A sub-hire." })
    assert.equal(tooDeep.status, "failed")
    assert.ok(staffReceipt(root, "hire-too-deep", "hire").report.violations.some((violation) => violation.code === "depth-exceeded"))

    // The host restarts and still knows both hires.
    await handle.stop()
    await handle.start()

    // Retiring the researcher revokes its grants; every later task is refused.
    assert.equal((await start("retire", { key: "retire-research", principal: "lead.researcher" })).status, "completed")
    const retired = frontmatter(readFileSync(join(root, "Org/Specialists/lead.researcher.md"), "utf8"))
    assert.equal(retired.status, "retired")
    assert.match(readFileSync(join(root, "Org/Specialists/lead.researcher.md"), "utf8"), /retiredAt: /)
    const late = await start("delegate", { key: "brief-3", parent: "lead", specialist: "lead.researcher", objective: "One more." })
    assert.equal(late.status, "failed")
    assert.match(staffReceipt(root, "brief-3", "delegate").report.summary, /lead\.researcher is retired/)

    // A retired principal hires nobody: it is refused before any model turn.
    assert.equal((await start("retire", { key: "retire-deputy", principal: "lead.deputy" })).status, "completed")
    const orphan = await start("hire", { key: "hire-after-retired", parent: "lead.deputy", need: "A hire." })
    assert.equal(orphan.status, "failed")
    const refusal = staffReceipt(root, "hire-after-retired", "hire").report
    assert.equal(refusal.status, "refused")
    assert.match(refusal.summary, /lead\.deputy is retired/)
    assert.equal(existsSync(join(root, "Org/Specialists/lead.deputy.late.md")), false)

    // A core role is not retired by the flow.
    assert.equal((await start("retire", { key: "retire-lead", principal: "lead" })).status, "failed")
    await handle.stop()
  })
})
