import { readFileSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
const monday = JSON.parse(readFileSync(new URL("./monday-cuts.json", import.meta.url), "utf8"))
const incrementFor = view => monday.keptViews[monday.viewAliases[view] ?? view]?.increment ?? monday.conditionalViews[view]?.increment ?? "—"
const mockRoot = fileURLToPath(new URL("../../", import.meta.url))
const cell = value => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")
const scorerNames = ["live-clean", "structure-parity", "parity-judge"]
const scoreIssue = score => {
  if (score === null || typeof score !== "object" || Array.isArray(score)) return "missing or invalid scorer record"
  if (score.inconclusive) return score.inconclusive
  if (!Number.isFinite(score.score) || score.score < 0 || score.score > 1) return "missing or invalid score; expected a number from 0 to 1"
}
const classify = ({ output, scores = {} }) => {
  const structure = scores["structure-parity"]?.meta?.gaps ?? []
  const judged = scores["parity-judge"]?.meta?.gaps ?? []
  const audit = output.pairs.flatMap(pair => pair.outcome === "compared" ? (pair.live?.problems ?? []).map(p => `${pair.id}/${pair.width}: ${p}`) : [])
  const gaps = [...new Set([...judged, ...structure, ...audit])]
  const missingScores = scorerNames.filter(name => scoreIssue(scores[name]))
  const deducted = Object.values(scores).some(score => !scoreIssue(score) && score.score < 1)
  const partial = output.pairs.some(pair => !["compared", "cut"].includes(pair.outcome))
  const outcome = output.outcome !== "compared" ? output.outcome : missingScores.length ? "inconclusive" : gaps.length || deducted ? "gaps" : partial ? "inconclusive" : "parity"
  return { gaps, outcome }
}
export const renderGaps = records => {
  const rows = records.map(record => ({ ...record, ...classify(record) }))
  const tables = rows.map(({ output, scores = {}, gaps, outcome }) => {
    const partial = output.pairs.filter(p => !["compared", "cut"].includes(p.outcome)).length
    const notes = [...output.unobservable, ...scorerNames.flatMap(name => scoreIssue(scores[name]) && output.outcome !== "cut" ? [`${name}: ${scoreIssue(scores[name])}`] : []), ...(scores["parity-judge"]?.meta?.unobservable ?? []), ...(output.infrastructureError ? [output.infrastructureError] : [])]
    const pictures = output.pairs.map(p => `${p.id}/${p.width}: ${[p.mock, p.live].filter(Boolean).map((screen, i) => `[${i === 0 ? "mock" : "live"}](${screen.screenshot})`).join(" / ") || "—"}${p.outcome !== "compared" ? ` (${p.outcome})` : ""}`).join("<br>") || "—"
    return `| View | Increment | Outcome | Top gaps | Paired screenshots |\n| --- | --- | --- | --- | --- |\n| ${cell(output.view)} | ${incrementFor(output.view)} | ${cell(outcome)}${partial ? ` (${partial} unpaired)` : ""} | ${cell(gaps.slice(0, 5).join("; ") || (outcome === "parity" ? "None observed" : outcome === "cut" ? output.cutReason ?? monday.decision : "Unobservable"))} | ${cell(pictures)} |\n${notes.length ? `\nUnobservable: ${notes.map(cell).join("; ")}\n` : ""}`
  }).join("\n")
  const summaries = [1, 2, "—"].map(increment => {
    const group = rows.filter(row => incrementFor(row.output.view) === increment)
    const count = kind => group.filter(row => kind === "green" ? row.outcome === "parity" && row.output.pairs.every(pair => ["compared", "cut"].includes(pair.outcome)) && row.output.pairs.some(pair => pair.outcome === "compared") : row.outcome === kind).length
    const unverified = group.length - ["green", "gaps", "not deployed", "cut"].reduce((sum, kind) => sum + count(kind), 0)
    return `${increment === "—" ? "Outside increments" : `Increment ${increment}`}: views ${count("green")} green / ${count("gaps")} gaps / ${count("not deployed")} not deployed / ${count("cut")} cut${unverified ? ` / ${unverified} unverified or partial` : ""}`
  }).join("\n\n")
  return `${tables}\n${summaries}\n`
}
export const loadRun = async directory => {
  const files = (await readdir(directory)).filter(file => /^[\w-]+\.json$/.test(file)).sort()
  return Promise.all(files.map(async file => {
    const output = JSON.parse(await readFile(join(directory, file), "utf8"))
    if (!output.view || !Array.isArray(output.pairs)) throw new Error(`Invalid live-parity record ${file}`)
    const scores = {}
    for (const name of scorerNames) {
      try {
        const score = JSON.parse(await readFile(join(directory, `${output.view}.${name}.json`), "utf8"))
        const inconclusive = scoreIssue(score)
        scores[name] = inconclusive && !score?.inconclusive ? { inconclusive } : score
      }
      catch (error) { if (error.code !== "ENOENT") throw error }
    }
    return { output, scores }
  }))
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const id = process.argv[2]
  if (!id || !/^[\w-]+$/.test(id)) throw new Error("Usage: node evals/live-parity/gaps.mjs <run-id>")
  const records = await loadRun(resolve(mockRoot, ".flows/evals/live-parity", id))
  if (!records.length) throw new Error(`No live-parity records in ${id}`)
  console.log(renderGaps(records))
}
