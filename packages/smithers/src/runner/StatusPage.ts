/**
 * `runner/StatusPage`: the one page `smthrs runner status --port` serves, and
 * the two routes it reads.
 *
 * The page is self-contained HTML with no dependencies. It reads
 * `workstreams.json` beside it, which the server answers by folding the
 * runner's lanes again ({@link Workstreams.read}) on every request, and reads
 * it again every 15 seconds. It writes every value it shows as text, never as
 * markup.
 *
 *   GET /                 the page
 *   GET /workstreams.json { workstreams: [...] }, read now
 *
 * @since 1.0.0
 */

import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

/**
 * The page's HTML.
 *
 * @category constants
 * @since 1.0.0
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Workstreams</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; --done: #15803d; --doing: #1d4ed8; --blocked: #b91c1c; }
  body { font: 15px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 960px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  #read { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  section { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 16px; padding: 14px 16px; }
  h2 { font-size: 17px; margin: 0; }
  .head { align-items: baseline; display: flex; gap: 12px; justify-content: space-between; }
  .goal { margin: 6px 0; }
  .criteria { color: var(--muted); font-size: 13px; margin: 4px 0 8px; padding-left: 18px; }
  .bar { background: var(--line); border-radius: 4px; height: 6px; margin: 8px 0 10px; overflow: hidden; }
  .bar > div { background: var(--done); height: 100%; }
  table { border-collapse: collapse; width: 100%; }
  td { border-top: 1px solid var(--line); padding: 6px 8px 6px 0; vertical-align: top; }
  .status { font-size: 12px; font-weight: 600; text-transform: uppercase; white-space: nowrap; }
  .done { color: var(--done); } .doing, .active { color: var(--doing); } .blocked { color: var(--blocked); }
  .todo, .idle { color: var(--muted); }
  .owner { color: var(--muted); font: 12px ui-monospace, monospace; }
  #error { color: var(--blocked); }
</style>
</head>
<body>
<h1>Workstreams</h1>
<div id="read">Reading…</div>
<div id="error"></div>
<main id="workstreams"></main>
<script>
const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const owner = (lane) => [lane.runId ?? lane.request, lane.profile, lane.standing ? "standing" : undefined, lane.status]
  .filter((part) => part !== undefined).join(" ")
const render = (workstreams) => {
  const main = document.getElementById("workstreams")
  main.replaceChildren()
  if (workstreams.length === 0) main.append(el("p", "", "No workstreams. Declare them under workstreams in runner.json."))
  for (const workstream of workstreams) {
    const section = el("section")
    const head = el("div", "head")
    head.append(el("h2", "", workstream.title), el("span", "status " + workstream.status, workstream.status + "  " +
      workstream.progress.done + "/" + workstream.progress.total + " tasks"))
    section.append(head)
    if (workstream.goal) section.append(el("p", "goal", workstream.goal))
    if (workstream.criteria.length > 0) {
      const list = el("ul", "criteria")
      for (const criterion of workstream.criteria) list.append(el("li", "", criterion))
      section.append(list)
    }
    const bar = el("div", "bar")
    const fill = el("div")
    fill.style.width = (workstream.progress.total === 0 ? 0 : 100 * workstream.progress.done / workstream.progress.total) + "%"
    bar.append(fill)
    section.append(bar)
    const table = el("table")
    for (const task of workstream.tasks) {
      const row = el("tr")
      const what = el("td", "", task.title)
      for (const criterion of task.criteria) what.append(el("div", "criteria", criterion))
      const who = el("td", "owner", task.owners.length === 0 ? "no lane" : task.owners.map(owner).join(", "))
      row.append(el("td", "status " + task.status, task.status), what, who)
      table.append(row)
    }
    section.append(table)
    main.append(section)
  }
}
const unread = (why) => {
  document.getElementById("error").textContent = "Couldn't read the workstreams: " + why
}
const read = async () => {
  try {
    const response = await fetch("workstreams.json", { cache: "no-store" })
    if (!response.ok) return unread("the runner answered " + response.status)
    render((await response.json()).workstreams)
    document.getElementById("error").textContent = ""
    document.getElementById("read").textContent = "Read from the lanes' runs at " + new Date().toLocaleTimeString()
  } catch (error) {
    unread(error.message)
  }
}
read()
setInterval(read, 15000)
</script>
</body>
</html>
`

/**
 * The page's routes over `read`, the workstreams as the page shows them. A
 * read that fails is logged and answers 500, naming no path; a defect is the
 * router's own 500.
 *
 * @category layers
 * @since 1.0.0
 */
export const routes = <A, E>(read: Effect.Effect<A, E>) =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/", HttpServerResponse.html(PAGE)),
    HttpRouter.add(
      "GET",
      "/workstreams.json",
      read.pipe(
        Effect.map((workstreams) => HttpServerResponse.jsonUnsafe({ workstreams })),
        Effect.catch(() =>
          Effect.logWarning("runner.status").pipe(
            Effect.annotateLogs({ outcome: "unread" }),
            Effect.as(HttpServerResponse.jsonUnsafe({ message: "the workstreams can't be read" }, { status: 500 }))
          )
        )
      )
    )
  )
