#!/usr/bin/env node
// Files an import plan (import.mjs) as issues: paced, resumable, and in the plan's order (the tree's nodes, then the
// agents' drafts and the queue, then the findings).
//
//   node ops/issues/file.mjs --plan <plan.jsonl> --state <state.jsonl> [--limit <n>] [--dry-run] [--identity <file>]
//
// Each row goes through four stages, each recorded in the state file (mode 600, one JSON line per stage done) the
// moment it is done: `created` (with its number; `sent` first, with its write id, so a lost answer is found again by
// its write id and `key:` marker rather than created twice), `attached` (a GitHub sub-issue of its parent, which the
// plan files first), `labeled` (with any labels it could not create), and `linked` (its work links). A rerun skips
// every stage the state file says is done; the `key:` marker search in `ensureIssue` is the backstop when the state
// file is lost. Pacing, rate limits, the scrub and the identity checks are track.mjs's.
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { applyLabels, attach, bodyWithMarker, clientOf, ensureIssue, identityOf, markerOf, postLinks, privateReposOf, Refused, repoOf, scrubbed, shapeReaderOf, verifyIdentity } from "./track.mjs"

/** The state file's stages per key: `{ number, stages: Set }`. */
export const readState = (text) => {
  const state = new Map()
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    const row = JSON.parse(line)
    const entry = state.get(row.key) ?? { number: null, stages: new Set() }
    if (typeof row.number === "number") entry.number = row.number
    entry.stages.add(row.stage)
    state.set(row.key, entry)
  }
  return state
}

/** The rows to file, in the plan's order: nodes, then issues. A node's body is its `about`. */
export const rowsOf = (plan) =>
  plan
    .filter((row) => row.type === "node" || row.type === "issue")
    .map((row) => (row.type === "node" ? { ...row, body: row.about ?? "", links: [] } : row))

/**
 * Files `rows`. `record(entry)` appends one state line. Returns counts per stage done in this run and the refusals,
 * by key. A row whose parent has no number yet waits for a later run (`waiting`).
 */
export const fileAll = async (client, rows, { state, record, limit = Infinity, options = {}, sleep }) => {
  const readers = new Map()
  const labelCache = new Map()
  const parentCache = new Map()
  const done = { created: 0, reused: 0, attached: 0, labeled: 0, linked: 0, waiting: 0 }
  const refused = []
  const numberOf = (key) => state.get(key)?.number ?? null
  const byKey = new Map(rows.map((row) => [row.key, row]))
  let handled = 0
  let dryNumber = 1_000_000
  for (const row of rows) {
    if (handled >= limit) break
    const entry = state.get(row.key) ?? { number: null, stages: new Set() }
    state.set(row.key, entry)
    if (["created", "attached", "labeled", "linked"].every((stage) => entry.stages.has(stage))) continue
    handled++
    try {
      const { owner, name } = repoOf(row.repo)
      const clean = scrubbed({ title: row.title, body: bodyWithMarker(row.body ?? "", markerOf({ key: row.key, labels: row.labels ?? [] })), labels: row.labels ?? [], links: row.links ?? [] }, options)
      if (!entry.stages.has("created")) {
        const reader = readers.get(row.repo) ?? readers.set(row.repo, shapeReaderOf(client, { owner, name })).get(row.repo)
        record({ key: row.key, stage: "sent" })
        const found = await ensureIssue(client, { repo: row.repo, title: clean.title, body: clean.body, key: row.key, reader, sleep })
        // A dry run numbers nothing; it stands in a distinct number per row so the tree's walk stays a tree.
        entry.number = found.number ?? (client.dryRun ? dryNumber++ : null)
        entry.stages.add("created")
        record({ key: row.key, stage: "created", number: found.number, reused: found.reused })
        done[found.reused ? "reused" : "created"]++
      }
      const number = entry.number ?? "<number>"
      if (!entry.stages.has("attached")) {
        if (row.parent === undefined) {
          entry.stages.add("attached")
          record({ key: row.key, stage: "attached", parent: null })
        } else {
          const parentNumber = numberOf(row.parent)
          const parentRow = byKey.get(row.parent)
          if ((parentNumber === null && !client.dryRun) || parentRow === undefined) {
            done.waiting++
          } else {
            const parent = { ...repoOf(parentRow.repo), number: parentNumber ?? 0 }
            const placed = await attach(client, { child: { owner, name, number: entry.number ?? 0 }, parent, cache: parentCache })
            entry.stages.add("attached")
            record({ key: row.key, stage: "attached", parent: placed.parent, noop: placed.noop === true })
            done.attached++
          }
        }
      }
      if (!entry.stages.has("labeled")) {
        const applied = await applyLabels(client, { owner, name, number, labels: clean.labels, cache: labelCache })
        entry.stages.add("labeled")
        record({ key: row.key, stage: "labeled", missingLabels: applied.missingLabels })
        done.labeled++
      }
      if (!entry.stages.has("linked")) {
        const at = new Date().toISOString()
        for (let start = 0; start < clean.links.length; start += 50) {
          await postLinks(client, { repo: row.repo, issue: number, links: clean.links.slice(start, start + 50).map((link) => ({ ...link, at: link.at ?? at })) }, options)
        }
        entry.stages.add("linked")
        record({ key: row.key, stage: "linked", links: clean.links.length })
        done.linked++
      }
    } catch (error) {
      if (!(error instanceof Refused) || error.code === "identity") throw error
      refused.push({ key: row.key, code: error.code, message: error.message })
    }
  }
  return { done, refused }
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      state: { type: "string" },
      origin: { type: "string", default: "https://smithers.sh" },
      identity: { type: "string" },
      "private-repos": { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  })
  if (values.plan === undefined || values.state === undefined) throw new Refused("invalid", "--plan and --state are required", 1)
  const dryRun = values["dry-run"]
  let identity
  try {
    identity = identityOf(values.identity ?? process.env.SMITHERS_ISSUE_IDENTITY)
  } catch (error) {
    if (!dryRun) throw error
  }
  const client = clientOf({ origin: values.origin, identity, dryRun })
  await verifyIdentity(client, identity, ["cookie", "githubToken"])
  const plan = readFileSync(values.plan, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
  const state = existsSync(values.state) ? readState(readFileSync(values.state, "utf8")) : new Map()
  const record = dryRun ? () => {} : (entry) => appendFileSync(values.state, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, { mode: 0o600 })
  const options = { privateRepos: privateReposOf(values["private-repos"] ?? process.env.SMITHERS_PRIVATE_REPOS_FILE) }
  const result = await fileAll(client, rowsOf(plan), { state, record, limit: values.limit === undefined ? Infinity : Number(values.limit), options })
  // A dry run's requests, counted by method and path shape (numbers as N), since a plan makes thousands.
  const requests = {}
  for (const r of client.requests) {
    const shape = `${r.method} ${r.url.replace(/^https:\/\/[^/]+/, "").replace(/\?.*$/, "").replace(/\d+|<number>|<id of the child>/g, "N")}`
    requests[shape] = (requests[shape] ?? 0) + 1
  }
  process.stdout.write(`${JSON.stringify({ dryRun, author: identity?.login ?? null, ...result, ...(dryRun ? { requests } : {}) }, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = error instanceof Refused ? error.exit : 1
  })
}
