// The importer's pure parts (import.mjs): one issue record per open item, from the text the collector read. Each
// record is `{ key, kind, repo, title, body, labels, links, parent }`: `key` is `<kind>:<id>`, stable across runs,
// and becomes the body's `key:` marker line, which `track.mjs open` matches to reuse an issue. Tested by
// sources.test.ts with synthetic input only.
import { createHash } from "node:crypto"
import { MIGRATED_REPOS, nodeOfParentText } from "./tree.mjs"

const VIBELANG = "smithersai/vibelang"
const MAX_TITLE = 200
const MAX_BODY = 8000
export const PENDING_URL = "https://github.com/smithersai/vibelang/blob/main/typescript/tsc/internal/vibelangfuzz/testdata/pending"

const short = (text) => createHash("sha1").update(text).digest("hex").slice(0, 12)
const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`)
const oneLine = (text) => clip(String(text).replace(/\s+/g, " ").trim(), MAX_TITLE)
const joinedBody = (lines) => lines.filter((line) => line !== undefined).join("\n").trim()
const body = (lines) => clip(joinedBody(lines), MAX_BODY)
const formatting = (unformatted) => unformatted ? { oneLine: String, body: joinedBody } : { oneLine, body }
/** Format only after the importer has validated the complete per-finding fields. */
export const formatRecord = (record) => ({ ...record, title: oneLine(record.title), body: body([record.body]) })

/** `migrate:<repo>` when a name names an example repository. */
export const migrateLabels = (...names) => {
  const text = names.join(" ").toLowerCase()
  const repo = MIGRATED_REPOS.find((name) => text.includes(name))
  return repo === undefined ? [] : [`migrate:${repo}`]
}

/** A line that says the item is fixed. "fixed, queued" is not: a fix waiting in the queue is still open. */
export const FIXED = /\bFIXED\b|\b(?:fixed|landed|resolved) (?:in|on|as|by)\b|\bwithdrawn\b|\bsuperseded\b|\bno longer (?:reproduces|fails)\b|\ball fixed\b/

// ── Merge-queue entries ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the open queue entries mean for the tree: a queue entry is work, not a problem, so it never files an issue.
 * Open is `queued` and `held`, and a `rejected` entry that is its lane's latest, since nothing replaced it. An entry
 * naming issues (`issues`, from "Fixes #N", "Refs #N" or `--issue N`) gives one `queue` work link per issue, posted
 * once the issues exist. One naming none goes in `unlinked`, kept aside until TODO leaves can hold it.
 */
export const queuePlan = (entries) => {
  const latest = new Map()
  for (const entry of entries) {
    const before = latest.get(entry.lane)
    if (before === undefined || String(entry.at) > String(before.at)) latest.set(entry.lane, entry)
  }
  const open = entries.filter((entry) => entry.state === "queued" || entry.state === "held" || (entry.state === "rejected" && latest.get(entry.lane) === entry))
  const named = (entry) => (Array.isArray(entry.issues) ? entry.issues.filter((number) => Number.isSafeInteger(number) && number > 0) : [])
  return {
    links: open.flatMap((entry) =>
      named(entry).map((issue) => ({
        key: `queue:${entry.id}:${issue}`,
        kind: "queue-link",
        repo: VIBELANG,
        issue,
        link: { kind: "queue", ref: entry.id, label: `${entry.id} (${entry.state})`, state: entry.state === "rejected" ? "failed" : "queued" },
      })),
    ),
    unlinked: open.filter((entry) => named(entry).length === 0).map((entry) => ({
      id: entry.id,
      lane: entry.lane,
      rev: entry.rev ?? null,
      at: entry.at ?? null,
      state: entry.state,
      reason: entry.reason ?? null,
      labels: migrateLabels(entry.lane),
    })),
  }
}

// ── Spec review rounds ────────────────────────────────────────────────────────────────────────────────────────────

/** Sections of a Markdown text that open with a heading matching `heading`: `{ match, text }`. */
const sections = (text, heading) => {
  const lines = text.split("\n")
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const match = heading.exec(lines[i])
    if (match === null) continue
    let end = i + 1
    while (end < lines.length && !/^#{1,3} /.test(lines[end])) end++
    out.push({ match, text: lines.slice(i, end).join("\n"), line: i + 1 })
  }
  return out
}

/** The canonical id of a review finding: `r2-OPUS-2`. */
const findingIds = (label, round) => {
  const ids = []
  let current = round
  for (const match of label.matchAll(/(?:\b[Rr](\d+)\s+)?\b((?:OPUS|ASTRA|FABLE|SOL)-\d+)\b/g)) {
    if (match[1] !== undefined) current = match[1]
    if (current !== undefined) ids.push(`r${current}-${match[2]}`)
  }
  return ids
}

/**
 * Open findings of the latest spec-review round: the round's new findings not marked FIXED, and the rows of each
 * reviewer's "Still open from earlier rounds" table, one record per finding (a row naming two reviewers' ids is one).
 * `files` is `[{ reviewer, round, text }]` of that round.
 */
export const reviewRoundRecords = (files, { unformatted = false } = {}) => {
  const { oneLine, body } = formatting(unformatted)
  const records = new Map()
  const seen = new Map()
  const add = (ids, make) => {
    const known = ids.map((id) => seen.get(id)).find((key) => key !== undefined)
    if (known !== undefined) {
      const record = records.get(known)
      record.body = body([record.body, "", `Also reported as ${ids.join(", ")}.`])
      for (const id of ids) seen.set(id, known)
      return
    }
    const record = make()
    records.set(record.key, record)
    for (const id of ids) seen.set(id, record.key)
  }
  for (const { reviewer, round, text } of files) {
    for (const { match, text: section } of sections(text, /^### ((?:OPUS|ASTRA|FABLE|SOL)-\d+) \[(\w+)\] (.*)$/)) {
      if (FIXED.test(match[3])) continue
      const id = `r${round}-${match[1]}`
      add([id], () => ({
        key: `review:spec:${id}`,
        kind: "review",
        repo: VIBELANG,
        title: oneLine(`Spec review r${round} ${match[1]} [${match[2]}]: ${match[3].replace(/\s+—.*$/, "")}`),
        body: body([`Spec review round ${round}, ${reviewer}: ${match[1]} [${match[2]}].`, "", section.split("\n").slice(1).join("\n"), "", "Fix status: open."]),
        labels: ["review-finding", "spec", `severity:${match[2].toLowerCase()}`],
        links: [{ kind: "review", ref: `spec-review:r${round}:${reviewer}`, label: `spec review r${round} (${reviewer})` }],
        parent: "tree:spec",
      }))
    }
    const table = /## Still open from earlier rounds\n([\s\S]*)$/.exec(text)?.[1] ?? ""
    for (const line of table.split("\n")) {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim())
      if (cells.length < 4 || !/^\d+$/.test(cells[0])) continue
      const [, label, evidence, status] = cells
      const ids = findingIds(label.split(":")[0], undefined)
      if (ids.length === 0) continue
      const severity = /\[(blocker|major|minor)\]/i.exec(label)?.[1]?.toLowerCase()
      const what = label.slice(label.indexOf(":") + 1).trim()
      add(ids, () => ({
        key: `review:spec:${ids[0]}`,
        kind: "review",
        repo: VIBELANG,
        title: oneLine(`Spec review ${ids[0].replace("-", " ")}: ${what}`),
        body: body([
          `Spec review finding ${ids.join(" / ")}, still open in round ${round} (${reviewer}).`,
          "",
          `- finding: ${what}`,
          `- where on main: ${evidence}`,
          `- queue status: ${status}`,
          "",
          "Fix status: open.",
        ]),
        labels: ["review-finding", "spec", ...(severity === undefined ? [] : [`severity:${severity}`])],
        links: [{ kind: "review", ref: `spec-review:r${round}:${reviewer}`, label: `spec review r${round} (${reviewer})` }],
        parent: "tree:spec",
      }))
    }
  }
  return [...records.values()]
}

/** Where a scoped review's findings belong. */
const scopedParent = (scope) => (/doc/.test(scope) ? "tree:docs" : /preview|queue/.test(scope) ? "tree:workflow" : "tree:impl")

/**
 * Open findings of a scoped review (`### RC-1 [major] ...`, `### RD-001 ...`): those that no heading or line naming
 * them marks fixed.
 */
export const scopedRecords = (scope, text, { unformatted = false } = {}) => {
  const { oneLine, body } = formatting(unformatted)
  const records = []
  const done = new Set()
  for (const { match, text: section } of sections(text, /^### ([A-Z]+-\d+)\b\s*(?:\[(\w+)\]|—\s*(\w+)\s*—)?\s*(.*)$/)) {
    const id = match[1]
    if (done.has(id)) continue
    done.add(id)
    const mentions = text.split("\n").filter((line) => new RegExp(`\\b${id}\\b`).test(line))
    if (FIXED.test(section.split("\n")[0]) || mentions.some((line) => FIXED.test(line))) continue
    const severity = (match[2] ?? match[3])?.toLowerCase()
    records.push({
      key: `review:${scope}:${id}`,
      kind: "review",
      repo: VIBELANG,
      title: oneLine(`Review ${scope} ${id}: ${match[4].replace(/^[—-]\s*/, "")}`),
      body: body([`Finding ${id} of the scoped review \`${scope}\`${severity === undefined ? "" : ` [${severity}]`}.`, "", section.split("\n").slice(1).join("\n"), "", "Fix status: open (no line marks it fixed)."]),
      labels: ["review-finding", ...(severity === undefined ? [] : [`severity:${severity}`])],
      links: [{ kind: "review", ref: `review:${scope}`, label: `review ${scope}` }],
      parent: scopedParent(scope),
    })
  }
  return records
}

// ── Example-repo migration findings ───────────────────────────────────────────────────────────────────────────────

/**
 * Open findings of one example repository's migration inbox (`migrate-<repo>.md`): `### <repo>-<n>: title` entries
 * (an addendum, correction or count is part of its finding), and dated `## 2026-10-31: title` entries. A finding is
 * fixed when its own section, or another heading naming its id, says so.
 */
export const migrationRecords = (repo, text, options = {}) => {
  const records = []
  const seen = new Set()
  const headings = text.split("\n").filter((line) => /^#{2,4} /.test(line))
  const idHeading = new RegExp(`^###? (${repo}-\\d+[a-z]?)\\b(.*)$`)
  for (const { match, text: section } of sections(text, idHeading)) {
    const id = match[1]
    const rest = match[2]
    if (seen.has(id) || /addendum|correction|count|root cause|follow-up|update|proof succeeds/i.test(rest.split(":")[0])) continue
    seen.add(id)
    const elsewhere = headings.filter((line) => new RegExp(`\\b${id}\\b(?![\\w-])`).test(line))
    if (FIXED.test(section) || elsewhere.some((line) => FIXED.test(line))) continue
    const title = rest.replace(/^\s*(\([^)]*\))?\s*:?\s*/, "")
    records.push(migrationRecord(repo, id, title, section, options))
  }
  const dated = /^## (?:drive-[\w-]+,\s*)?(20\d\d-\d\d-\d\d)(?:[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|\+00:00)?)?:\s*(.+)$/
  for (const { match, text: section } of sections(text, dated)) {
    const title = match[2]
    if (/^note\b/i.test(title) || FIXED.test(section)) continue
    const id = `${match[1]}-${short(title)}`
    if (seen.has(id)) continue
    seen.add(id)
    records.push(migrationRecord(repo, id, title, section, options))
  }
  return records
}

const migrationRecord = (repo, id, title, section, { unformatted = false } = {}) => {
  const { oneLine, body } = formatting(unformatted)
  return ({
  key: `migrate:${repo}:${id}`,
  kind: "migration",
  repo: VIBELANG,
  title: oneLine(`${repo} migration: ${title}`),
  body: body([`Found migrating ${repo} to VibeLang (${id}).`, "", section.split("\n").slice(1).join("\n"), "", "Fix status: open (no line marks it fixed)."]),
  labels: ["migration-finding", `migrate:${repo}`],
  links: [{ kind: "review", ref: `migrate-${repo}:${id}`, label: `migration finding ${id}` }],
  parent: `tree:repos:${repo}`,
  })
}

// ── Fuzz findings: the pending gaps on main ───────────────────────────────────────────────────────────────────────

/**
 * Open fuzz findings from main's `testdata/pending/<area>.txt` (`<target> <key> <owner> <reason>`): each oracle line
 * not superseded, grouped by area, target and the reason before its first `;`, since one disagreement often has
 * several keys. Corpus lines only mark reproductions. `files` is `[{ name, text }]`. Returns `{ records, areas }`,
 * `areas` the tree's area nodes.
 */
export const fuzzRecords = (files, { unformatted = false } = {}) => {
  const { oneLine, body } = formatting(unformatted)
  const groups = new Map()
  for (const { name, text } of files) {
    const area = name.replace(/\.txt$/, "")
    for (const line of text.split("\n")) {
      if (line.trim() === "" || line.startsWith("#")) continue
      const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)
      if (match === null) continue
      const [, target, key, owner, reason] = match
      if (owner === "superseded" || key.startsWith("corpus:")) continue
      const head = reason.split(";")[0].trim()
      const id = `${area}:${target}:${short(`${area}\n${target}\n${head}`)}`
      const group = groups.get(id) ?? { id, area, target, owner, head, keys: [], lanes: new Set() }
      group.keys.push(key)
      for (const lane of reason.matchAll(/\blane ([\w-]+)/g)) group.lanes.add(lane[1])
      groups.set(id, group)
    }
  }
  const areas = new Map()
  const records = [...groups.values()].map((group) => {
    const cite = /^((?:VIP-\d+|D\d+|crash|hang)[^:]*):\s*(.*)$/.exec(group.head)
    const what = cite === null ? group.head : `${cite[2]} (${cite[1]})`
    const parent = `tree:fuzz:${group.area}`
    areas.set(parent, [parent, `Fuzz findings: ${group.area}`, "tree:fuzz"])
    return {
      key: `fuzz:${group.id}`,
      kind: "fuzz",
      repo: VIBELANG,
      title: oneLine(`${group.target}: ${what}`),
      body: body([
        `${group.target} disagrees with the specification; the gap is pending on main in [\`testdata/pending/${group.area}.txt\`](${PENDING_URL}/${group.area}.txt).`,
        "",
        `- what: ${group.head}`,
        `- owner: ${group.owner}${group.lanes.size === 0 ? "" : `, lane ${[...group.lanes].join(", ")}`}`,
        `- keys (${group.keys.length}): ${group.keys.slice(0, 40).map((key) => `\`${key}\``).join(", ")}${group.keys.length > 40 ? ", …" : ""}`,
        "",
        "Fix status: open. The change that fixes it deletes these pending lines; the reproductions then pass.",
      ]),
      labels: ["fuzz-finding", ...migrateLabels(group.area, ...group.lanes)],
      links: [...group.lanes].map((lane) => ({ kind: "session", ref: `lane:${lane}`, label: `lane ${lane}` })),
      parent,
    }
  })
  return { records, areas: [...areas.values()] }
}

// ── Agents' drafts ────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a draft with no parent text goes, by its labels: a spec or ruling item, docs, else the implementation. */
const nodeOfLabels = (labels) =>
  labels.includes("spec") || labels.includes("ruling") ? "tree:spec" : labels.includes("docs") ? "tree:docs" : labels.includes("tooling") ? "tree:tooling" : undefined

/** A draft's own links: an array as the work-links route takes them, or `{ lane, mq: [ids], commit }`. */
const draftLinks = (links) => {
  if (Array.isArray(links)) return links.filter((link) => typeof link?.kind === "string" && typeof link?.ref === "string")
  if (links === null || typeof links !== "object") return []
  return [
    ...(typeof links.lane === "string" && links.lane !== "" ? [{ kind: "session", ref: `lane:${links.lane}`, label: `lane ${links.lane}` }] : []),
    ...(Array.isArray(links.mq) ? links.mq.filter((id) => typeof id === "string" && id !== "").map((id) => ({ kind: "queue", ref: id, label: `queue ${id}` })) : []),
  ]
}

/**
 * A repository's tracking draft ("Migrate <repo>'s Effect modules to VibeLang", "Migrate <repo> to VibeLang (tracking)", or
 * one whose parent or role says it is the node) is that repository's tree node.
 */
const TRACKING = /^migrate\b.*\b(?:effect modules to vibelang\b|to vibelang \(tracking\))/i

/** One vocabulary across drafters; unknown values are a refusal, never an implicit open or skipped draft. */
const DRAFT_STATUSES = new Map([
  ["open", "open"], ["fixed", "fixed"], ["nonbug", "nonbug"], ["duplicate", "duplicate"], ["closed", "closed"],
  ["not_a_bug", "nonbug"], ["not-a-bug", "nonbug"], ["notabug", "nonbug"], ["wontfix", "nonbug"],
  ["dup", "duplicate"], ["done", "fixed"], ["resolved", "fixed"],
])

/**
 * All issue drafts the agents prepared, normalized but unfiltered so the importer can count and audit every row.
 * Legacy `state` supplies status when `status` is absent; absence of both means open. A repository's tracking draft carries
 * `asNode`: it becomes that node's issue instead of a child of it.
 */
export const draftRecords = (source, drafts, { unformatted = false } = {}) => {
  const { oneLine, body } = formatting(unformatted)
  return drafts.map((draft) => {
    const key = `draft:${source}:${draft.draft_id ?? draft.id ?? draft.key ?? short(draft.title)}`
    const value = draft.status === undefined ? (draft.state === undefined ? "open" : draft.state) : draft.status
    const status = typeof value === "string" ? DRAFT_STATUSES.get(value.toLowerCase()) : undefined
    if (status === undefined) throw new Error(`${key} has unknown status ${JSON.stringify(value)}`)
    const duplicateOf = draft.duplicate_of_draft ?? draft.duplicate_of_title ?? draft.duplicate_of
    const labels = [...new Set([...(draft.labels ?? []), ...migrateLabels(source)])]
    const repoNode = migrateLabels(source)[0] === undefined ? undefined : `tree:repos:${source}`
    const parent = nodeOfParentText(draft.parent) ?? nodeOfLabels(labels) ?? repoNode ?? "tree:impl"
    const tracking = TRACKING.test(String(draft.title)) || /this is the .*node/i.test(String(draft.parent ?? "")) || /\bnode\b/i.test(String(draft.role ?? ""))
    const asNode = tracking ? (MIGRATED_REPOS.map((repo) => `tree:repos:${repo}`).find((key) => key === parent || key === repoNode) ?? undefined) : undefined
    return {
      key,
      status,
      ...(duplicateOf === undefined ? {} : { duplicate_of: duplicateOf }),
      kind: "draft",
      source,
      repo: draft.repo ?? VIBELANG,
      title: oneLine(draft.title),
      body: body([String(draft.body ?? "")]),
      labels,
      links: draftLinks(draft.links),
      parent,
      parentText: draft.parent ?? null,
      ...(asNode === undefined ? {} : { asNode }),
    }
  })
}
