/*
 * The showcase page: one static HTML file beside gifs/<id>.gif, built from
 * the case records and the coverage. No script, no network.
 */
import type { Bucket, Coverage } from "./coverage"
import type { ShowcaseRecord } from "./showcase"

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const BUCKETS: ReadonlyArray<Bucket> = ["recorded", "unrecorded", "unavailable"]

export interface PageInput {
  readonly records: ReadonlyArray<ShowcaseRecord>
  readonly coverage: Coverage
  readonly revision: string
  readonly generatedAt: string
}

const caseSection = (revision: string) => (record: ShowcaseRecord, index: number): string => `
<section class="case" id="${escape(record.id)}">
  <header>
    <span class="n">${index + 1}</span>
    <h2>${escape(record.title)}</h2>
    ${record.revision !== revision.replace(/\+local$/, "") ? `<span class="tag old">${escape(record.revision ?? "old")}</span>` : ""}
    ${record.fakeBackend ? '<span class="tag">fake backend</span>' : ""}
  </header>
  <p>${escape(record.summary)}</p>
  <div class="doors">${record.doors.map(door => `<kbd>${escape(door)}</kbd>`).join("")}</div>
  <a href="gifs/${escape(record.id)}.gif"><img src="gifs/${escape(record.id)}.gif" alt="${escape(record.title)}" loading="lazy"></a>
  <div class="flows">${record.flows.map(flow => `<code>${escape(flow)}</code>`).join(" ")}</div>
</section>`

const coverageTable = (coverage: Coverage): string => {
  const namespaces = [...new Set(coverage.rows.map(row => row.namespace))].sort()
  const cell = (namespace: string, bucket: Bucket): string => {
    const rows = coverage.rows.filter(row => row.namespace === namespace && row.bucket === bucket)
    if (rows.length === 0) return `<td class="zero">0</td>`
    const list = rows.map(row => {
      const note = bucket === "recorded" ? row.cases.join(", ") : bucket === "unavailable" ? row.unavailable ?? "" : ""
      return `<li><code>${escape(row.name)}</code> <span>${escape(note)}</span></li>`
    }).join("")
    return `<td class="${bucket}"><details><summary>${rows.length}</summary><ul>${list}</ul></details></td>`
  }
  return `
<table>
  <thead><tr><th></th>${BUCKETS.map(bucket => `<th>${bucket}</th>`).join("")}</tr></thead>
  <tbody>
    ${namespaces.map(namespace => `<tr><th>${escape(namespace)}</th>${BUCKETS.map(bucket => cell(namespace, bucket)).join("")}</tr>`).join("\n    ")}
  </tbody>
  <tfoot><tr><th>${coverage.rows.length}</th>${BUCKETS.map(bucket => `<td>${coverage.counts[bucket]}</td>`).join("")}</tr></tfoot>
</table>`
}

export const renderPage = ({ records, coverage, revision, generatedAt }: PageInput): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smithers App Showcase</title>
<style>
:root { --bg:#fafaf9; --fg:#1c1917; --muted:#78716c; --line:#e7e5e4; --card:#fff; --accent:#0f766e; --tag:#fef3c7; --tag-fg:#92400e; }
@media (prefers-color-scheme: dark) { :root { --bg:#141414; --fg:#f5f5f4; --muted:#a8a29e; --line:#2e2e2e; --card:#1c1c1c; --accent:#5eead4; --tag:#422006; --tag-fg:#fcd34d; } }
* { box-sizing: border-box; }
body { overflow-x: hidden; margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -.01em; }
.meta { color: var(--muted); font: 12px/1.4 ui-monospace, Menlo, monospace; margin-bottom: 20px; }
nav { display:flex; flex-wrap:wrap; gap:6px; margin-bottom: 28px; }
nav a { color: var(--fg); text-decoration: none; border:1px solid var(--line); border-radius: 999px; padding: 3px 10px; font-size: 13px; background: var(--card); }
nav a:hover { border-color: var(--accent); }
.case { background: var(--card); border:1px solid var(--line); border-radius: 12px; padding: 18px; margin-bottom: 22px; }
.case header { display:flex; align-items:center; gap:10px; }
.case h2 { font-size: 19px; margin: 0; }
.n { font: 600 12px ui-monospace, Menlo, monospace; color: var(--accent); border:1px solid var(--line); border-radius: 6px; padding: 1px 6px; }
.tag.old { background: var(--line); color: var(--muted); }
.tag.old + .tag { margin-left: 6px; }
.tag { margin-left:auto; background: var(--tag); color: var(--tag-fg); font-size: 11px; font-weight:600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.case p { margin: 6px 0 10px; color: var(--muted); }
.doors { display:flex; flex-wrap:wrap; gap:6px; margin-bottom: 12px; }
kbd { font: 12px ui-monospace, Menlo, monospace; background: var(--bg); border:1px solid var(--line); border-bottom-width: 2px; border-radius: 6px; padding: 2px 7px; max-width: 100%; overflow-wrap: anywhere; }
.case img { display:block; width:100%; height:auto; border-radius: 8px; border:1px solid var(--line); }
.flows { margin-top: 10px; display:flex; flex-wrap: wrap; gap: 4px 8px; }
code { font: 12px ui-monospace, Menlo, monospace; color: var(--muted); }
h3 { font-size: 17px; margin: 36px 0 10px; }
table { table-layout: fixed; overflow-wrap: anywhere; border-collapse: collapse; width: 100%; background: var(--card); border:1px solid var(--line); border-radius: 12px; overflow: hidden; font-size: 13px; }
th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { color: var(--muted); font-weight: 600; }
tbody th { font: 12px ui-monospace, Menlo, monospace; font-weight: 400; }
td.zero { color: var(--line); }
td.recorded summary { color: var(--accent); font-weight: 600; }
tfoot td, tfoot th { font-weight: 700; border-bottom: 0; }
summary { cursor: pointer; }
details ul { margin: 6px 0 2px; padding-left: 16px; }
details li span { color: var(--muted); }
@media (max-width: 640px) { .case { padding: 12px; } th, td { padding: 4px 6px; } }
</style>
</head>
<body>
<main>
<h1>Smithers app</h1>
<div class="meta">${records.length} cases · ${coverage.counts.recorded}/${coverage.rows.length} flows recorded · ${escape(revision)} · ${escape(generatedAt)} · T1 browser test host</div>
<nav>${records.map((record, index) => `<a href="#${escape(record.id)}">${index + 1}. ${escape(record.title)}</a>`).join("")}<a href="#coverage">Coverage</a></nav>
${records.map(caseSection(revision)).join("\n")}
<h3 id="coverage">Coverage</h3>
${coverageTable(coverage)}
</main>
</body>
</html>
`
