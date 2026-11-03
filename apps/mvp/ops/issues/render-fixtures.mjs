#!/usr/bin/env node
// Refreshes render-fixtures.json: each case escaped as the server files it (escapeMarkdown), rendered by GitHub's
// own Markdown API (POST https://api.github.com/markdown, gfm mode, in the sandbox repository's context). Creates
// nothing on GitHub and sends no token: unauthenticated, 60 requests an hour. Run from apps/mvp:
//   node ops/issues/render-fixtures.mjs [--out ops/issues/render-fixtures.json]
import { writeFileSync } from "node:fs"
import { escapeMarkdown } from "../../src/features/issues/publicContent.mjs"
import { RENDER_CASES, RENDER_CONTEXT } from "./render-cases.mjs"

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : new URL("./render-fixtures.json", import.meta.url).pathname
// Ten cases a request, between separator paragraphs, so a refresh costs five requests. An escaped case can't open a
// block that runs into the next one, and a separator that doesn't come back as its own paragraph fails the refresh.
const separator = (n) => `RENDERCASESEPARATOR${n}`
const fixtures = []
for (let first = 0; first < RENDER_CASES.length; first += 10) {
  const batch = RENDER_CASES.slice(first, first + 10)
  const text = batch.map((one, i) => `${separator(i)}\n\n${escapeMarkdown(one)}`).join("\n\n") + `\n\n${separator(batch.length)}`
  const response = await fetch("https://api.github.com/markdown", {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "smithers-render-fixtures" },
    body: JSON.stringify({ text, mode: "gfm", context: RENDER_CONTEXT }),
  })
  if (response.status !== 200) throw new Error(`GitHub answered ${response.status}, ${response.headers.get("x-ratelimit-remaining") ?? "?"} requests left this hour`)
  const html = await response.text()
  batch.forEach((one, i) => {
    const open = `<p dir="auto">${separator(i)}</p>`
    const close = `<p dir="auto">${separator(i + 1)}</p>`
    const start = html.indexOf(open)
    const end = html.indexOf(close)
    if (start === -1 || end === -1) throw new Error(`case ${first + i}: its separators did not come back as paragraphs`)
    fixtures.push({ text: one, escaped: escapeMarkdown(one), html: html.slice(start + open.length, end).trim() })
  })
}
writeFileSync(out, `${JSON.stringify({ context: RENDER_CONTEXT, rendered: new Date().toISOString(), fixtures }, null, 2)}\n`)
console.log(`wrote ${fixtures.length} cases to ${out}`)
