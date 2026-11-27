#!/usr/bin/env node
/**
 * Publishes `.uphill/report.json` (plus optional `.agents/uphill/rules.md`) to a repository's
 * Smithers Cloud `uphill` feed (`POST /api/repos/<owner>/<name>/feeds`), making the Lighthouse
 * scorecard appear live in the repository's Uphill tab.
 *
 * Usage:
 *   SMITHERS_URL=https://smithers.sh SMITHERS_FEED_KEY=... node apps/mvp/scripts/publish-uphill-feed.mjs owner/repo
 */
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const repo = process.argv[2] ?? process.env.GITHUB_REPOSITORY
const baseUrl = (process.env.SMITHERS_URL ?? "https://smithers.sh").replace(/\/+$/, "")
const feedKey = process.env.SMITHERS_FEED_KEY
const reportPath = resolve(process.argv[3] ?? ".uphill/report.json")
const rulesPath = resolve(".agents/uphill/rules.md")
const visibility = process.env.SMITHERS_UPHILL_VISIBILITY === "maintainers" ? "maintainers" : "public"

if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
  console.error("Usage: publish-uphill-feed.mjs <owner/repo> [report.json]")
  process.exit(2)
}
if (!feedKey) {
  console.error("SMITHERS_FEED_KEY is required")
  process.exit(2)
}
if (!existsSync(reportPath)) {
  console.error(`Report not found: ${reportPath} (run uphill first)`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, "utf8"))
const rules = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : null

let commit = process.env.GITHUB_SHA ?? null
let branch = process.env.GITHUB_REF_NAME ?? null
if (!commit) {
  try {
    commit = execSync("jj --no-pager log -r @- -n 1 --no-graph -T commit_id", { encoding: "utf8" }).trim() || null
  } catch {
    commit = null
  }
}

const [owner, name] = repo.split("/")
const url = `${baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/feeds`
const payload = {
  documents: [
    {
      name: "uphill",
      visibility,
      body: {
        report,
        commit,
        branch,
        updatedAt: new Date().toISOString(),
        rules,
      },
    },
  ],
}

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${feedKey}`,
  },
  body: JSON.stringify(payload),
})

if (!response.ok) {
  const text = await response.text().catch(() => "")
  console.error(`Failed to publish uphill feed (${response.status}): ${text}`)
  process.exit(1)
}

console.log(`Published uphill report for ${repo} to ${url}`)
