#!/usr/bin/env node
// Plans the import of our open work into issues on the public repositories, as a tree under "Ship VibeLang"
// (tree.mjs). It reads, scrubs, deduplicates and places; it posts nothing. The plan is a mode-600 JSONL file that
// may hold private text in its dropped rows, so it never goes in a repository.
//
//   node ops/issues/import.mjs --out <plan.jsonl> --draft <source>=<file>... [--private-repos <file>]
//   node ops/issues/import.mjs --out <plan.jsonl> [--source lane-host|fuzz]... [--host <lane host>]
//                              [--draft <source>=<file or host:path>]... [--replace-findings <repo>]... [--pending-ref main]
//
// Draft mode, the first form: one or more `--draft` and no `--source`. It reads only the named local draft files, then
// counts every normalized status and plans only open drafts, placing, scrubbing and deduplicating them with the tree.
// It runs no `gh` and no `ssh`, so an agent holding only the App's machine token can plan its drafts: agent actions
// go through the App, never a personal login. A
// `host:path` draft needs ssh, so draft mode refuses it; copy the file here, or select a source. It reads no existing
// issues: `issues/file-tree` reuses an issue or a tree node by its `key:` marker when it files
// (ops/issues/track.mjs `findMatch`). Private repository names for the scrub come from `--private-repos <file>` or
// $SMITHERS_PRIVATE_REPOS_FILE, one per line, as for track.mjs; with none, nothing is planned.
//
// The second form reads the selected sources, every source when no `--source` and no `--draft` is given:
// - `lane-host`, over SSH, read-only: the merge queue (`~/vibe/mq/queue.jsonl`, latest state per id; its entries are
//   work, so they file no issue: one naming none goes in `<out>.queue-unlinked.jsonl`, mode 600, until TODO leaves
//   can hold it), the latest
//   spec-review round and the scoped reviews (`~/vibe/review-spec/loop`), and each example repository's migration
//   inbox (`~/vibe/review-spec/fuzz-coverage/inbox/migrate-<repo>.md`); lane reports (`~/lanes/*.REPORT.md`) are
//   counted and dated only, since they hold no open/fixed finding records;
// - `fuzz`, main's pending fuzz gaps (`typescript/tsc/internal/vibelangfuzz/testdata/pending/*.txt` on smithersai/vibelang),
//   through `gh api`;
// - the agents' issue drafts, `--draft <source>=<file>` (a JSON array or JSONL; `host:path` reads over SSH). A
//   source whose drafts cover its whole migration inbox, `--replace-findings <repo>`, stands in for that inbox's
//   parsed findings. A repository's tracking draft becomes its tree node's issue.
// Private repository names for the scrub come from `gh repo list <owner> --visibility private`, held in memory, and
// the `--private-repos` file. `gh` and `ssh` use the operator's own logins, so only an operator runs this form.
//
// Non-open drafts are counted and saved to `<out>.skipped.jsonl` (mode 600), with key, status and any duplicate_of.
// Unknown draft statuses refuse the import with exit 2 before output files are written.
//
// Plan rows, in filing order: `{"type":"node", ...}` (the tree), then `{"type":"issue", ...}` (drafts, then findings;
// each with key, repo, title, body, labels, links, parent, depth), then `{"type":"queue-link", key, repo, issue, link}`
// (a `queue` work link per issue an open merge-queue entry names), then
// `{"type":"dropped", key, kind, problems}` for each record the scrub refused (field and rule, plus its source title
// for the operator), then `{"type":"summary", ...}` with counts per kind, repo, parent and drop rule.
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import { cleanRecord } from "./scrub.mjs"
import { draftRecords, fuzzRecords, migrationRecords, queuePlan, reviewRoundRecords, scopedRecords } from "./sources.mjs"
import { MIGRATED_REPOS, place } from "./tree.mjs"
import { markerOf, bodyWithMarker, privateReposOf } from "./track.mjs"

/** The sources besides drafts: each needs the operator's own logins (`ssh` to the lane host, `gh`). */
const SOURCES = ["lane-host", "fuzz"]

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "nyc-01" },
    out: { type: "string" },
    draft: { type: "string", multiple: true, default: [] },
    "pending-ref": { type: "string", default: "main" },
    "replace-findings": { type: "string", multiple: true, default: [] },
    source: { type: "string", multiple: true, default: [] },
    "private-repos": { type: "string" },
  },
})
if (values.out === undefined) throw new Error("--out <plan.jsonl> is required")
for (const source of values.source) if (!SOURCES.includes(source)) throw new Error(`--source is one of ${SOURCES.join(", ")}`)
const draftOnly = values.draft.length > 0 && values.source.length === 0
const selected = new Set(draftOnly ? [] : values.source.length === 0 ? SOURCES : values.source)
const drafts = values.draft.map((spec) => {
  const at = spec.indexOf("=")
  if (at <= 0) throw new Error(`--draft is <source>=<file>, not ${spec}`)
  return { source: spec.slice(0, at), file: spec.slice(at + 1) }
})
/** A draft file named `<host>:<path>` with no local file of that name: read over SSH. */
const remoteDraft = (file) => (existsSync(file) ? null : /^([\w.-]+):((?:~|\/).*)$/.exec(file))
if (draftOnly) {
  for (const { source, file } of drafts) {
    if (remoteDraft(file) !== null) throw new Error(`--draft ${source}=${file} is on another host and needs ssh: draft mode reads local files only. Copy it here, or add --source lane-host`)
  }
}
const namedPrivate = privateReposOf(values["private-repos"] ?? process.env.SMITHERS_PRIVATE_REPOS_FILE)
if (draftOnly && namedPrivate.length === 0) {
  throw new Error("no private repository names: draft mode reads them from --private-repos <file> or SMITHERS_PRIVATE_REPOS_FILE, one per line, never from gh. The scrub would miss them, so nothing is planned")
}

// One read-only pass on the lane host. It opens files for reading and lists directories; nothing else.
const REMOTE = String.raw`
import json, os, glob, re
home = os.path.expanduser("~")
def text(path, limit=4000000):
    try:
        with open(path, errors="replace") as f: return f.read(limit)
    except OSError: return None
entries = {}
for line in open(home + "/vibe/mq/queue.jsonl", errors="replace"):
    try: entry = json.loads(line)
    except ValueError: continue
    if isinstance(entry, dict) and entry.get("id"): entries[entry["id"]] = entry
for entry in entries.values():
    print(json.dumps({"kind": "queue", "entry": {k: entry.get(k) for k in ("id", "rev", "lane", "commits", "at", "state", "reason", "issues")}}))
loop = home + "/vibe/review-spec/loop"
rounds = sorted(int(m.group(1)) for d in os.listdir(loop) for m in [re.match(r"r(\d+)$", d)] if m)
if rounds:
    r = rounds[-1]
    for reviewer in sorted(os.listdir("%s/r%d" % (loop, r))):
        t = text("%s/r%d/%s/FINDINGS.md" % (loop, r, reviewer))
        if t is not None: print(json.dumps({"kind": "round", "round": r, "reviewer": reviewer, "text": t}))
for path in sorted(glob.glob(loop + "/scoped/*/FINDINGS.md")):
    print(json.dumps({"kind": "scoped", "scope": path.split("/")[-2], "text": text(path)}))
for repo in ${JSON.stringify(MIGRATED_REPOS)}:
    t = text(home + "/vibe/review-spec/fuzz-coverage/inbox/migrate-%s.md" % repo)
    if t is not None: print(json.dumps({"kind": "migration", "repo": repo, "text": t}))
reports = glob.glob(home + "/lanes/*.REPORT.md")
times = sorted(int(os.path.getmtime(p)) for p in reports)
print(json.dumps({"kind": "lane-reports", "count": len(reports), "oldest": times[0] if times else None, "newest": times[-1] if times else None}))
`

const remote = !selected.has("lane-host") ? [] : execFileSync("ssh", ["-o", "BatchMode=yes", values.host, "python3", "-"], { input: REMOTE, maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" })
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line))

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
const pendingPath = "typescript/tsc/internal/vibelangfuzz/testdata/pending"
const pendingNames = !selected.has("fuzz") ? [] : JSON.parse(gh("api", `repos/smithersai/vibelang/contents/${pendingPath}?ref=${values["pending-ref"]}`)).map((file) => file.name).filter((name) => name.endsWith(".txt"))
const pending = pendingNames.map((name) => ({ name, text: gh("api", "-H", "Accept: application/vnd.github.raw", `repos/smithersai/vibelang/contents/${pendingPath}/${name}?ref=${values["pending-ref"]}`) }))
const listedPrivate = draftOnly ? [] : ["smithersai", "roninjin10"].flatMap((owner) => {
  try {
    return JSON.parse(gh("repo", "list", owner, "--visibility", "private", "--limit", "500", "--json", "name")).map((repo) => repo.name)
  } catch {
    return []
  }
})
const privateRepos = [...new Set([...namedPrivate, ...listedPrivate])]
if (privateRepos.length === 0) throw new Error("no private repository names: the scrub would miss them, so nothing is planned")

/** A draft file: local, or `<host>:<path>` read over SSH (read-only) when no local file has that name; never in draft mode. */
const readDrafts = (file) => {
  const remotePath = remoteDraft(file)
  const text = (remotePath !== null
    ? execFileSync("ssh", ["-o", "BatchMode=yes", remotePath[1], "cat", "--", remotePath[2].replace(/^~\//, "")], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    : readFileSync(file, "utf8")).trim()
  if (text.startsWith("[")) return JSON.parse(text)
  if (text.startsWith("{") && !text.includes("\n{")) {
    const value = JSON.parse(text)
    return Array.isArray(value.issues) ? value.issues : [value]
  }
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
}

const fuzz = fuzzRecords(pending)
const round = remote.filter((row) => row.kind === "round")
// Filing order: the tree, then the agents' drafts, then the findings, then the queue's work links. Drafts come first so
// they win a title match against a finding of the same thing. A queue entry is work, never an issue.
const queue = queuePlan(remote.filter((row) => row.kind === "queue").map((row) => row.entry))
const replaced = new Set(values["replace-findings"])
let draftRows
try {
  draftRows = drafts.flatMap(({ source, file }) => draftRecords(source, readDrafts(file)))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
const statuses = { open: 0, fixed: 0, nonbug: 0, duplicate: 0, closed: 0 }
for (const row of draftRows) statuses[row.status]++
const skipped = draftRows.filter((row) => row.status !== "open").map(({ key, status, duplicate_of }) => ({
  key, status, ...(duplicate_of === undefined ? {} : { duplicate_of }),
}))
const records = [
  ...draftRows.filter((row) => row.status === "open"),
  ...reviewRoundRecords(round.map((row) => ({ reviewer: row.reviewer, round: row.round, text: row.text }))),
  ...remote.filter((row) => row.kind === "scoped").flatMap((row) => scopedRecords(row.scope, row.text)),
  ...remote.filter((row) => row.kind === "migration" && !replaced.has(row.repo)).flatMap((row) => migrationRecords(row.repo, row.text)),
  ...fuzz.records,
]

// Deduplicate by key, then by normalized title within a repository (an agent's draft and an imported finding of the
// same thing): the first wins, and the later's key is noted in its body.
const byKey = new Map()
const duplicates = []
for (const record of records) {
  if (byKey.has(record.key)) duplicates.push({ key: record.key, of: record.key })
  else byKey.set(record.key, record)
}
const byTitle = new Map()
const unique = []
for (const record of byKey.values()) {
  const title = `${record.repo}\n${record.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`
  const first = byTitle.get(title)
  if (first !== undefined) {
    duplicates.push({ key: record.key, of: first.key })
    continue
  }
  byTitle.set(title, record)
  unique.push(record)
}

const dropped = []
const clean = []
for (const record of unique) {
  const withMarker = { ...record, body: bodyWithMarker(record.body, markerOf({ key: record.key, labels: record.labels })) }
  const result = cleanRecord(withMarker, { privateRepos })
  if (result.ok) clean.push(result.record)
  else dropped.push({ type: "dropped", key: record.key, kind: record.kind, problems: result.problems, sourceTitle: record.title })
}
const queueLinks = []
for (const row of queue.links) {
  const result = cleanRecord({ key: row.key, links: [row.link] }, { privateRepos })
  if (result.ok) queueLinks.push({ type: "queue-link", ...row, link: result.record.links[0] })
  else dropped.push({ type: "dropped", key: row.key, kind: row.kind, problems: result.problems, sourceTitle: row.key })
}
const tree = place(clean, fuzz.areas)
const count = (rows, of) => rows.reduce((acc, row) => ({ ...acc, [of(row)]: (acc[of(row)] ?? 0) + 1 }), {})
const reports = remote.find((row) => row.kind === "lane-reports")
const summary = {
  type: "summary",
  at: new Date().toISOString(),
  nodes: tree.nodes.length,
  issues: tree.records.length,
  statuses,
  planned: statuses.open,
  byKind: count(tree.records, (row) => row.kind),
  bySource: count(tree.records, (row) => (row.kind === "draft" ? `draft:${row.source}` : row.kind)),
  queueLinks: queueLinks.length,
  queueUnlinked: queue.unlinked.length,
  trackingDraftsAsNodes: tree.nodes.filter((node) => node.draft !== undefined).map((node) => node.key),
  replacedFindings: [...replaced],
  byRepo: count([...tree.nodes, ...tree.records], (row) => row.repo),
  byParent: count(tree.records, (row) => row.parent),
  maxDepth: Math.max(...tree.records.map((row) => row.depth), ...tree.nodes.map((row) => row.depth)),
  crossRepoChildren: tree.records.filter((row) => row.repo !== "smithersai/vibelang").length,
  duplicates: duplicates.length,
  dropped: dropped.length,
  droppedByKind: count(dropped, (row) => row.kind),
  droppedByRule: count(dropped.flatMap((row) => row.problems.flatMap((p) => p.rules)), (rule) => rule),
  droppedByField: count(dropped.flatMap((row) => row.problems.map((p) => p.field.replace(/\[\d+\]/, "[]"))), (field) => field),
  laneReports: reports === undefined ? null : { count: reports.count, oldest: reports.oldest && new Date(reports.oldest * 1000).toISOString(), newest: reports.newest && new Date(reports.newest * 1000).toISOString(), imported: 0 },
  sources: [...(drafts.length === 0 ? [] : ["drafts"]), ...selected],
  fuzzSource: selected.has("fuzz") ? `smithersai/vibelang@${values["pending-ref"]}:${pendingPath} (${pending.length} areas)` : null,
}
const out = resolve(values.out)
mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
const rows = [
  ...tree.nodes.map((node) => ({ type: "node", ...node, ...(node.draft === undefined ? {} : { status: "open" }), labels: node.labels ?? ["tree"] })),
  ...tree.records.map((record) => ({ type: "issue", ...record })),
  ...queueLinks,
  ...dropped,
  ...duplicates.map((row) => ({ type: "duplicate", ...row })),
  summary,
]
const skippedOut = `${out}.skipped.jsonl`
writeFileSync(skippedOut, skipped.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 })
chmodSync(skippedOut, 0o600)
const queueOut = out.replace(/(\.jsonl)?$/, ".queue-unlinked.jsonl")
writeFileSync(queueOut, queue.unlinked.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 })
chmodSync(queueOut, 0o600)
writeFileSync(out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 })
chmodSync(out, 0o600)
console.log(JSON.stringify({ out, ...summary }, null, 2))
