// `node bench/electric-load/report.ts <label> <host record>...`: one Markdown table row for a run from its hosts'
// records (run.ts), and the run's window for objects.ts.
import { readFile } from "node:fs/promises"
import { HEADER, type HostRecord, report, row } from "./stats.ts"

const [label, ...files] = process.argv.slice(2)
if (label === undefined || files.length === 0) throw new Error("usage: report.ts <label> <host record>...")
const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8")) as HostRecord))
const r = report(records)
console.log(HEADER)
console.log(row(label, r))
const starts = records.map((record) => record.startedAt).sort()
const ends = records.map((record) => record.endedAt).sort()
console.log(`window ${starts[0]} ${ends.at(-1)}`)
if (r.writeToAllDevices !== null) console.log(`write to all devices: ${JSON.stringify(r.writeToAllDevices)}`)
