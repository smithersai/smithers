import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { fallbackReport, validateReport } from "./github-triage.mjs"

const documentedReports = (kind) => {
  const source = readFileSync(new URL(`../flows/${kind}-triage/flow.mdx`, import.meta.url), "utf8")
  const examples = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]))
  assert.ok(examples.length > 0, `flows/${kind}-triage/flow.mdx documents no report example`)
  return examples
}

describe("GitHub triage report contract", () => {
  it("accepts a reproduced issue and rejects contradictory status", () => {
    const report = {
      kind: "issue",
      summary: "The timeout is reproducible.",
      comment: "Run the focused test.",
      labels: ["kind:bug", "status:reproduced"],
      reproduction: { status: "reproduced", details: "pnpm test timeout.test.ts fails" }
    }
    assert.ok(validateReport(report, "issue"))
    assert.equal(validateReport({ ...report, labels: ["kind:bug"] }, "issue"), null)
  })

  it("requires PR readiness to agree with its checks", () => {
    const report = {
      kind: "pr",
      summary: "Ready for review.",
      comment: "The scope, tests, and docs are ready.",
      labels: ["status:ready-for-review"],
      checks: { description: "pass", tests: "pass", docs: "not-applicable", size: "pass" }
    }
    assert.ok(validateReport(report, "pr"))
    report.checks.tests = "needs-work"
    assert.equal(validateReport(report, "pr"), null)
  })

  it("asks the issue opener for concrete reproduction evidence on failure", () => {
    const report = fallbackReport("issue", "missing report")
    assert.equal(report.reproduction.status, "needs-author")
    assert.match(report.comment, /exact Smithers version/)
    assert.match(report.comment, /smallest command or flow/)
  })

  it("rejects unknown labels and oversized comments", () => {
    const base = fallbackReport("issue", "invalid")
    assert.equal(validateReport({ ...base, labels: ["security:trusted"] }, "issue"), null)
    assert.equal(validateReport({ ...base, comment: "x".repeat(60_001) }, "issue"), null)
  })

  it("accepts every report example the triage flows document", () => {
    for (const kind of ["issue", "pr"]) {
      for (const example of documentedReports(kind)) {
        assert.ok(validateReport(example, kind), `flows/${kind}-triage/flow.mdx documents a report the publisher rejects`)
      }
    }
  })
})

describe("GitHub triage entry point", () => {
  it("runs main from a checkout path that contains a space", async () => {
    const { spawnSync } = await import("node:child_process")
    const { copyFileSync, mkdirSync, mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const root = mkdtempSync(join(tmpdir(), "smithers triage "))
    try {
      mkdirSync(join(root, "scripts"))
      for (const file of ["github-triage.mjs", "workspace-packages.mjs"]) {
        copyFileSync(new URL(`./${file}`, import.meta.url), join(root, "scripts", file))
      }
      const result = spawnSync(process.execPath, [join(root, "scripts", "github-triage.mjs")], { encoding: "utf8", timeout: 30_000 })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /usage: github-triage\.mjs/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
