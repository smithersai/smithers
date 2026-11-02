#!/usr/bin/env node
// Plans the import of our open work into issues on the public repositories, as a tree under "Ship VibeLang"
// (tree.mjs). It reads, scrubs, deduplicates and places; it posts nothing. The plan is a mode-600 JSONL file that
// may hold private text in its dropped rows, so it never goes in a repository.
//
//   node ops/issues/import.mjs --out <plan.jsonl> [--host <lane host>] [--draft <source>=<file>]... [--pending-ref main]
//
// Sources, read at run time:
// - the lane host, over SSH, read-only: the merge queue (`~/vibe/mq/queue.jsonl`, latest state per id), the latest
//   spec-review round and the scoped reviews (`~/vibe/review-spec/loop`), and each example repository's migration
//   inbox (`~/vibe/review-spec/fuzz-coverage/inbox/migrate-<repo>.md`); lane reports (`~/lanes/*.REPORT.md`) are
//   counted and dated only, since they hold no open/fixed finding records;
// - main's pending fuzz gaps (`typescript/tsc/internal/vibelangfuzz/testdata/pending/*.txt` on smithersai/vibelang),
//   through `gh api`;
// - the agents' issue drafts, `--draft <source>=<file>` (a JSON array or JSONL).
// Private repository names for the scrub come from `gh repo list <owner> --visibility private`, held in memory.
//
// Plan rows: `{"type":"node"|"issue", key, repo, title, body, labels, links, parent, depth}`, then
// `{"type":"dropped", key, kind, problems}` for each record the scrub refused (field and rule, plus its source title
// for the operator), then `{"type":"summary", ...}` with counts per kind, repo, parent and drop rule.
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import { cleanRecord } from "./scrub.mjs"
import { draftRecords, fuzzRecords, migrationRecords, queueRecords, reviewRoundRecords, scopedRecords } from "./sources.mjs"
import { MIGRATED_REPOS, place } from "./tree.mjs"
import { markerOf, bodyWithMarker } from "./track.mjs"

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "nyc-01" },
    out: { type: "string" },
    draft: { type: "string", multiple: true, default: [] },
    "pending-ref": { type: "string", default: "main" },
  },
})
if (values.out === undefined) throw new Error("--out <plan.jsonl> is required")

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
    print(json.dumps({"kind": "queue", "entry": {k: entry.get(k) for k in ("id", "rev", "lane", "commits", "at", "state", "reason")}}))
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

const remote = execFileSync("ssh", ["-o", "BatchMode=yes", values.host, "python3", "-"], { input: REMOTE, maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" })
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line))

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
const pendingPath = "typescript/tsc/internal/vibelangfuzz/testdata/pending"
const pendingNames = JSON.parse(gh("api", `repos/smithersai/vibelang/contents/${pendingPath}?ref=${values["pending-ref"]}`)).map((file) => file.name).filter((name) => name.endsWith(".txt"))
const pending = pendingNames.map((name) => ({ name, text: gh("api", "-H", "Accept: application/vnd.github.raw", `repos/smithersai/vibelang/contents/${pendingPath}/${name}?ref=${values["pending-ref"]}`) }))
const privateRepos = ["smithersai", "roninjin10"].flatMap((owner) => {
  try {
    return JSON.parse(gh("repo", "list", owner, "--visibility", "private", "--limit", "500", "--json", "name")).map((repo) => repo.name)
  } catch {
    return []
  }
})
if (privateRepos.length === 0) throw new Error("no private repository names: the scrub would miss them, so nothing is planned")

const readDrafts = (file) => {
  const text = readFileSync(file, "utf8").trim()
  if (text.startsWith("[")) return JSON.parse(text)
  if (text.startsWith("{") && !text.includes("\n{")) {
    const value = JSON.parse(text)
    return Array.isArray(value.issues) ? value.issues : [value]
  }
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
}

const fuzz = fuzzRecords(pending)
const round = remote.filter((row) => row.kind === "round")
const records = [
  ...queueRecords(remote.filter((row) => row.kind === "queue").map((row) => row.entry)),
  ...reviewRoundRecords(round.map((row) => ({ reviewer: row.reviewer, round: row.round, text: row.text }))),
  ...remote.filter((row) => row.kind === "scoped").flatMap((row) => scopedRecords(row.scope, row.text)),
  ...remote.filter((row) => row.kind === "migration").flatMap((row) => migrationRecords(row.repo, row.text)),
  ...fuzz.records,
  ...values.draft.flatMap((spec) => {
    const [source, file] = spec.split("=")
    return draftRecords(source, readDrafts(file))
  }),
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
const tree = place(clean, fuzz.areas)
const count = (rows, of) => rows.reduce((acc, row) => ({ ...acc, [of(row)]: (acc[of(row)] ?? 0) + 1 }), {})
const reports = remote.find((row) => row.kind === "lane-reports")
const summary = {
  type: "summary",
  at: new Date().toISOString(),
  nodes: tree.nodes.length,
  issues: tree.records.length,
  byKind: count(tree.records, (row) => row.kind),
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
  fuzzSource: `smithersai/vibelang@${values["pending-ref"]}:${pendingPath} (${pending.length} areas)`,
}
const out = resolve(values.out)
mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
const rows = [
  ...tree.nodes.map((node) => ({ type: "node", ...node, labels: ["tree"] })),
  ...tree.records.map((record) => ({ type: "issue", ...record })),
  ...dropped,
  ...duplicates.map((row) => ({ type: "duplicate", ...row })),
  summary,
]
writeFileSync(out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 })
chmodSync(out, 0o600)
console.log(JSON.stringify({ out, ...summary }, null, 2))
