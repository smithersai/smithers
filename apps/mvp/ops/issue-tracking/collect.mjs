#!/usr/bin/env node
// Collects our real tracking records into issue records for the issue-tracking proof (docs/features/work-links.md).
//
//   node ops/issue-tracking/collect.mjs [--host nyc-01] [--inbox ~/.vibe-orch/proxy/inbox.md] [--out <file>] [--total 5000]
//
// Sources, read at run time and never committed: the proxy inbox (one issue per entry), and on the lane host each
// lane (its prompt, start and exit), its review report, and each merge-queue entry (`~/vibe/mq/queue.jsonl`, latest
// state per id). Records past the real ones, up to `--total`, are synthetic and say so. Every record carries `key`
// (`<kind>:<id>`) and the work links it implies (lane, queue entry, review), which the proof posts after the issue
// exists. Text is scrubbed of anything credential-shaped and home paths are shortened; the output file is mode 600 and
// belongs on a private repository only.
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import { interleave, recordsOf } from "./records.mjs"

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "nyc-01" },
    inbox: { type: "string", default: `${homedir()}/.vibe-orch/proxy/inbox.md` },
    out: { type: "string", default: `${homedir()}/.smithers-e2e/smithers.sh/issue-tracking/records.jsonl` },
    total: { type: "string", default: "5000" },
  },
})

// One pass on the lane host: lanes, reports and queue entries as JSON lines. Bounded text only.
const REMOTE = String.raw`
import json, os, glob
home = os.path.expanduser("~")
def text(path, limit):
    try:
        with open(path, errors="replace") as f: return f.read(limit)
    except OSError: return None
def mtime(path):
    try: return int(os.path.getmtime(path))
    except OSError: return None
for prompt in sorted(glob.glob(home + "/lanes/*.prompt.md")):
    name = os.path.basename(prompt)[:-len(".prompt.md")]
    base = home + "/lanes/" + name
    exit_text = text(base + ".exit", 64)
    print(json.dumps({"kind": "lane", "name": name, "prompt": text(prompt, 6000), "started": mtime(base + ".started") or mtime(prompt),
      "exited": mtime(base + ".exit"), "exit": (exit_text or "").strip() or None}))
    report = text(base + ".REPORT.md", 6000)
    if report is not None:
        print(json.dumps({"kind": "review", "lane": name, "report": report, "at": mtime(base + ".REPORT.md")}))
entries = {}
for line in open(home + "/vibe/mq/queue.jsonl", errors="replace"):
    try: entry = json.loads(line)
    except ValueError: continue
    if isinstance(entry, dict) and entry.get("id"): entries[entry["id"]] = entry
for entry in entries.values():
    print(json.dumps({"kind": "queue", "entry": {k: entry.get(k) for k in ("id", "rev", "lane", "commits", "at", "state", "reason")}}))
`

const remote = execFileSync("ssh", ["-o", "BatchMode=yes", values.host, "python3", "-"], {
  input: REMOTE,
  maxBuffer: 512 * 1024 * 1024,
  encoding: "utf8",
})
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line))

const inbox = readFileSync(values.inbox, "utf8")
const records = interleave(recordsOf({ inbox, remote }), Number(values.total))
const out = resolve(values.out)
mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
writeFileSync(out, records.map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 })
const counts = records.reduce((acc, record) => ({ ...acc, [record.kind]: (acc[record.kind] ?? 0) + 1 }), {})
console.log(JSON.stringify({ out, total: records.length, counts }))
