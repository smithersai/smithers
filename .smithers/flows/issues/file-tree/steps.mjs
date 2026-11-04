// The `issues/file-tree` flow's steps (flow.ts). `verify` checks the plan and the machine tokens. `step` makes exactly one
// attempt at one stage of one row and answers what happened; it never waits and never retries. The flow sleeps on the
// engine's durable timer between attempts. GitHub's pace is the server's: `github/MachineDispatch` holds every write to its
// send slots, so this flow submits one write and watches it settle (docs/features/machine-tokens.md).
//
// Stages, one recorded action per attempt:
//   create  submit `issue/create`, then watch it. The write id is derived from the row's key, so a resubmitted write is
//           the same write, and the server's marker search finds an issue a lost answer made, closed included. A
//           same-title issue is never a receipt.
//   link    submit `issue/relate` under the row's parent, and watch it. Another parent is an exception, never replaced.
//   work    post the row's work links.
// A token never enters a payload or a result: tokens are read from the file $SMITHERS_ISSUE_TOKENS names.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { contentProblem } from "../../../../apps/mvp/src/features/issues/publicContent.mjs"
import { clean } from "../../../../apps/mvp/ops/issues/scrub.mjs"
import { refuseUncheckedTls } from "../../../../apps/mvp/ops/tls.mjs"
import {
  bodyWithMarker,
  markerOf,
  MAX_DEPTH,
  MAX_SUB_ISSUES,
  privateReposOf,
  Refused,
  repoOf,
  scrubbed,
  tokenFor,
  clientOf,
  findMatch,
  identityOf,
  laneFor,
  scopedWriteId,
  shapeReaderOf,
} from "../../../../apps/mvp/ops/issues/track.mjs"

export const STAGES = ["create", "link", "work"]
/** How long a pending write is left between looks. */
const WATCH_MS = 5_000
/** How long a server outage is left, with no wait of its own. */
const OUTAGE_MS = 60_000

/** An ISO 8601 UTC time, as the importer writes one. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

/** A plan file's rows and the hash that pins them, so a plan edited mid-run is refused, not half-filed. */
export const readPlan = (path, read = (p) => readFileSync(p, "utf8")) => {
  const text = read(path)
  // A line that doesn't parse is named by its number only: JSON.parse quotes the text, which can be anything.
  const rows = text.split("\n").map((line, index) => ({ line, index })).filter(({ line }) => line.trim() !== "").map(({ line, index }) => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Refused("plan", `the plan's line ${index + 1} is not JSON`, 2)
    }
  })
  return { sha: createHash("sha256").update(text).digest("hex"), rows }
}

/** The rows to file, in the plan's order: nodes (shallowest first), issues, then queue links. A node's body is its `about`. */
export const fileRows = (rows) => [
  ...rows
    .filter((row) => row.type === "node")
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (a.row.depth ?? 0) - (b.row.depth ?? 0) || a.index - b.index)
    .map(({ row }) => ({ ...row, body: row.about ?? "", links: [] })),
  ...rows.filter((row) => row.type === "issue"),
  ...rows.filter((row) => row.type === "queue-link"),
]

/**
 * Refuses a plan the flow must not file: dropped rows not acknowledged with exactly `acceptDropped`, a depth past
 * GitHub's eight levels, a node with more than 100 children, a parent that is not a node of the plan, a key twice, or
 * a row of another owner than the tree's. Returns `{ total, repos }` or throws `Refused` naming each problem.
 */
export const validatePlan = (rows, acceptDropped = 0) => {
  const problems = []
  const summary = rows.find((row) => row.type === "summary")
  const dropped = rows.filter((row) => row.type === "dropped").length
  if (summary === undefined) problems.push("the plan has no summary row")
  // A time goes out with every work link: it is a timestamp or the plan is refused, never quoted.
  if (summary !== undefined && summary.at !== undefined && !TIMESTAMP.test(String(summary.at))) problems.push("the summary's time is not a timestamp")
  if (dropped !== acceptDropped) problems.push(`the plan dropped ${dropped} rows; pass acceptDropped ${dropped} once you have read them`)
  const filed = fileRows(rows)
  const nodes = new Set(filed.filter((row) => row.type === "node").map((row) => row.key))
  const root = filed.find((row) => row.type === "node" && row.parent === undefined)
  if (root === undefined) problems.push("the plan has no root node")
  const owner = root === undefined ? undefined : repoOf(root.repo).owner.toLowerCase()
  const children = new Map()
  const keys = new Set()
  // Problems name a row by its place in the plan, never by what it says: a plan is data, and a refusal is kept.
  for (const [place, row] of filed.entries()) {
    const at = `row ${place + 1}`
    if (keys.has(row.key)) problems.push(`${at}: its key appears twice`)
    // A key goes into the run's records and the issue's marker: it is public content, or the plan is refused.
    if (typeof row.key !== "string" || contentProblem(row.key) !== undefined || !clean(row.key, { kind: "exact", ...options() }).ok) problems.push(`${at}: its key is not public content`)
    if (row.parent !== undefined && (typeof row.parent !== "string" || contentProblem(row.parent) !== undefined)) problems.push(`${at}: its parent is not public content`)
    if ([...(row.links ?? []), ...(row.link === undefined ? [] : [row.link])].some((link) => link.at !== undefined && !TIMESTAMP.test(String(link.at)))) {
      problems.push(`${at}: a link's time is not a timestamp`)
    }
    keys.add(row.key)
    if ((row.depth ?? 0) > MAX_DEPTH) problems.push(`${at}: past level ${MAX_DEPTH}`)
    if (owner !== undefined && repoOf(row.repo).owner.toLowerCase() !== owner) problems.push(`${at}: on another owner than the tree's`)
    if (row.parent === undefined) continue
    if (!nodes.has(row.parent)) problems.push(`${at}: its parent is not a node of the plan`)
    children.set(row.parent, (children.get(row.parent) ?? 0) + 1)
  }
  for (const [parent, count] of children) {
    if (count > MAX_SUB_ISSUES) problems.push(`row ${filed.findIndex((row) => row.key === parent) + 1}: ${count} children, past ${MAX_SUB_ISSUES}`)
  }
  if (summary !== undefined && summary.maxDepth > MAX_DEPTH) problems.push(`the summary's maxDepth ${summary.maxDepth} is past ${MAX_DEPTH}`)
  if (problems.length > 0) throw new Refused("plan", `the plan is refused: ${problems.slice(0, 20).join("; ")}`, 2)
  return { total: filed.length, repos: [...new Set(filed.map((row) => row.repo))].sort() }
}

/** One request with the repository's machine token, or a dry run's made-up answer. */
const request = async (cursor, repo, { method = "GET", path, body, dry }) => {
  if (cursor.dryRun) return { status: method === "GET" ? 200 : 202, headers: new Headers(), answer: dry }
  refuseUncheckedTls(process.env)
  const { owner, name } = repoOf(repo)
  const headers = { authorization: `Bearer ${tokenFor(repo)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }
  let response
  try {
    response = await fetch(`${cursor.origin}/api/repos/${owner}/${name}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  } catch {
    // A fetch error can quote the request's headers, the token among them, and the run keeps its errors.
    throw new Refused("unavailable", `the request to ${cursor.origin} failed`, 4)
  }
  return { status: response.status, headers: response.headers, answer: await response.json().catch(() => undefined) }
}

/** Checks the plan, and before a real run that every repository's token is live: an unknown write id answers 404. */
export const verify = async ({ plan, acceptDropped, dryRun, origin }) => {
  const { sha, rows } = readPlan(plan)
  const { total, repos } = validatePlan(rows, acceptDropped)
  if (!dryRun) {
    for (const repo of repos) {
      const { status } = await request({ dryRun, origin }, repo, { path: "/writes/00000000-0000-4000-8000-000000000000" })
      if (status !== 404) throw new Refused("identity", `the machine token for ${repo} is not live: HTTP ${status}`, 3)
    }
  }
  return { sha, total }
}

const outcome = (fields) => ({ number: null, submitted: false, kind: "ok", waitMs: 0, done: true, exception: null, nodeKey: null, ...fields })
const options = () => ({ privateRepos: privateReposOf(process.env.SMITHERS_PRIVATE_REPOS_FILE) })

/** What the server's wait, an outage or a refusal means for this attempt: the same stage again later, or an exception. */
const notOk = ({ status, headers, answer }, fields) => {
  const retryAfter = Number(headers.get("retry-after"))
  if (status === 429 || status >= 500) return outcome({ ...fields, done: false, waitMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : OUTAGE_MS })
  return outcome({ ...fields, kind: "refused", exception: `refused: HTTP ${status}${typeof answer?.code === "string" ? ` ${answer.code}` : ""}` })
}

/** Submits `body` once, then watches it across attempts. `fields` carries what the row keeps meanwhile. */
const submitOrWatch = async (cursor, repo, writeId, body, fields, onDone) => {
  if (!cursor.submitted) {
    const sent = await request(cursor, repo, { method: "POST", path: "/writes", body: { writeId, ...body }, dry: { writeId } })
    if (sent.status !== 200 && sent.status !== 202) return notOk(sent, fields)
    return outcome({ ...fields, submitted: true, done: false, waitMs: 0 })
  }
  const looked = await request(cursor, repo, { path: `/writes/${writeId}`, dry: { status: "done", number: 1_000_000 + cursor.index, failure: null } })
  if (looked.status !== 200) return notOk(looked, { ...fields, submitted: true })
  if (looked.answer.status === "pending") return outcome({ ...fields, submitted: true, done: false, waitMs: WATCH_MS })
  if (looked.answer.status !== "done") return outcome({ ...fields, kind: "refused", exception: `${looked.answer.failure ?? looked.answer.status}` })
  return onDone(looked.answer)
}

/** The issues of `repo` as smithers.sh's shape sends them, read once per process and then for changes only. */
const shapes = new Map()
const issuesOf = (origin, repo) => {
  const key = `${origin} ${repo}`
  if (!shapes.has(key)) shapes.set(key, shapeReaderOf(clientOf({ origin, dryRun: false }), repoOf(repo)))
  return shapes.get(key).rows()
}

/** One attempt at `cursor.stage` of row `cursor.index`. `done` false asks for the same stage again after `waitMs`. */
export const step = async (cursor) => {
  const { sha, rows } = readPlan(cursor.plan)
  if (sha !== cursor.sha) throw new Refused("plan", "the plan changed since the run validated it", 2)
  const all = fileRows(rows)
  const result = await stepRow(cursor, all, rows)
  // Only a future link needs a created node's number. Keep the current row's
  // parent through every submit/watch retry, and retain null for failed parents.
  // In particular, never carry leaf-node receipts into every later handoff.
  const needed = new Set(all.slice(cursor.index).map((row) => row.parent).filter((key) => key !== undefined))
  const candidates = new Set([...Object.keys(cursor.nodes), ...(result.nodeKey === null ? [] : [result.nodeKey])])
  const forgetNodes = [...candidates].filter((key) => !needed.has(key))
  return forgetNodes.length === 0 ? result : { ...result, forgetNodes }
}

/** Runs the current stage; `step` adds its live-parent projection to the recorded outcome. */
const stepRow = async (cursor, all, rows) => {
  const row = all[cursor.index]
  const at = rows.find((r) => r.type === "summary")?.at ?? new Date(0).toISOString()
  const postLinks = async (repo, number, links, fields) => {
    const posted = await request(cursor, repo, { method: "POST", path: `/issues/${number}/links`, body: { links: links.map((link) => ({ ...link, at: link.at ?? at })) } })
    return posted.status === 200 || (cursor.dryRun && posted.status === 202) ? outcome(fields) : notOk(posted, fields)
  }
  if (row.type === "queue-link") {
    const { links } = scrubbedOrException({ links: [row.link] })
    if (links === undefined) return outcome({ exception: "scrub: the link" })
    return postLinks(row.repo, row.issue, links, { kind: "queue-linked" })
  }
  const clean = scrubbedOrException({ title: row.title, body: bodyWithMarker(row.body ?? "", markerOf({ key: row.key, labels: row.labels ?? [] })), labels: row.labels ?? [], links: row.links ?? [] })
  if (clean.exception !== undefined) return outcome({ exception: clean.exception })
  const nodeKey = row.type === "node" ? row.key : null
  const identity = identityOf(cursor.dryRun, laneFor, row.repo)
  if (cursor.stage === "create") {
    // An issue with this key's marker already, closed included, is this row's: filed by another lane or an earlier
    // plan. Never a title.
    if (!cursor.submitted && !cursor.dryRun) {
      const found = findMatch(await issuesOf(cursor.origin, row.repo), { key: row.key })
      if (found !== undefined) return outcome({ number: found.number, nodeKey })
    }
    const body = { op: "issue/create", title: clean.title, body: clean.body, ...(clean.labels.length === 0 ? {} : { labels: clean.labels }) }
    return submitOrWatch(cursor, row.repo, scopedWriteId(identity, "issue/create", row.repo, row.key), body, { nodeKey }, (write) => outcome({ number: write.number, nodeKey }))
  }
  const number = cursor.number
  if (number === null) return outcome({})
  if (cursor.stage === "link") {
    if (row.parent === undefined) return outcome({ number })
    const parentRow = all.find((other) => other.key === row.parent)
    const parentNumber = cursor.nodes[row.parent]
    if (parentRow === undefined || parentNumber === undefined || parentNumber === null) return outcome({ number, exception: "no parent: the row's parent has no issue" })
    const body = { op: "issue/relate", number, parent: { repo: parentRow.repo, number: parentNumber } }
    return submitOrWatch(cursor, row.repo, scopedWriteId(identity, "issue/relate", row.repo, row.key), body, { number }, () => outcome({ number }))
  }
  // Every link, 50 to a request. Posting links is idempotent, so an attempt cut off part way posts them all again.
  for (let first = 0; first < clean.links.length; first += 50) {
    const posted = await postLinks(row.repo, number, clean.links.slice(first, first + 50), { number })
    if (!posted.done || posted.exception !== null) return posted
  }
  return outcome({ number })
}

/** A record cleaned, or `{ exception }` naming the rule that refused it. */
const scrubbedOrException = (record) => {
  try {
    return scrubbed(record, options())
  } catch (error) {
    if (error instanceof Refused) return { exception: `${error.code}: ${error.message}` }
    throw error
  }
}
