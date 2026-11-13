/* node .specs/design/mock/src/sites/repo/views/issues/issues.test.mjs — no browser launch. */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MessageChannel } from "node:worker_threads"

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../../..")
const requireApp = createRequire(join(rootPath, "apps/app/package.json"))
const { Window } = await import(requireApp.resolve("happy-dom"))
const window = new Window({ url: "https://mock.test/?still=1" })
for (const key of ["window", "document", "navigator", "HTMLElement", "Event", "CustomEvent", "FormData", "sessionStorage", "localStorage", "history"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : window[key] })
}
window.matchMedia = query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })
globalThis.matchMedia = window.matchMedia
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/* React's browser act() uses one channel per turn; close them after the DOM is unmounted. */
const channels = []
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this) }
}
let scrolled
window.HTMLElement.prototype.scrollIntoView = function () { scrolled = this }

const { build, stop } = requireApp("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { default as React, act } from "react"
      export { createRoot } from "react-dom/client"
      export { DEFAULTS, MockProvider } from "./.specs/design/mock/src/sites/core/mock"
      export { Issues } from "./.specs/design/mock/src/sites/repo/views/issues/Issues"
      export { Issue } from "./.specs/design/mock/src/sites/repo/views/issues/Issue"
      export { CodeHome } from "./.specs/design/mock/src/sites/repo/views/code-home/CodeHome"
      export { FactoryReceipt } from "./.specs/design/mock/src/sites/repo/views/issues/shared"
      export { registerIssueCommands } from "./.specs/design/mock/src/sites/repo/views/issues/commands"
      export { AskPanel } from "./.specs/design/mock/src/sites/repo/frame/AskPanel"
      export { getSlash } from "./.specs/design/mock/src/sites/repo/frame/slash"
      export * as model from "./.specs/design/mock/src/sites/repo/views/issues/model"
      export * as waiting from "./.specs/design/mock/src/sites/repo/frame/waiting"
      export { pluralize } from "./.specs/design/mock/src/sites/repo/ui/pluralize"
      export * as fixtures from "./.specs/design/mock/src/sites/repo/fixtures"
    `,
    resolveDir: rootPath, loader: "jsx"
  },
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  nodePaths: [join(rootPath, "apps/app/node_modules"), join(rootPath, "node_modules")],
  alias: { "@smthrs/ui": join(rootPath, "packages/smithers/ui/src/index.ts") },
  loader: { ".css": "empty" }
})
const kit = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
const { React, act, fixtures, model } = kit
const h = React.createElement
const container = document.createElement("div")
document.body.append(container)
let root
let revision = 0
const clear = async () => {
  if (root) await act(async () => root.unmount())
  root = undefined
  sessionStorage.clear()
}
const render = async (content, path, overrides = {}) => {
  await clear()
  sessionStorage.setItem("site-mock-flags", JSON.stringify({ ...kit.DEFAULTS, as: "in", landing: "open", ...overrides }))
  sessionStorage.setItem("repo-ask-open", "true")
  window.location.hash = `#/${path}`
  root = kit.createRoot(container)
  await act(async () => root.render(h(kit.MockProvider, null, content)))
}
const button = label => [...container.querySelectorAll("button")].find(item => item.textContent === label)
const click = async item => { assert.ok(item, "button exists"); await act(async () => item.click()) }
const submit = async form => { assert.ok(form, "form exists"); await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))) }
const base = "smithers.sh/maya/tinyhttp"
const list = query => `${base}/issues?q=${encodeURIComponent(query)}`
const rowNumbers = () => [...container.querySelectorAll(".repo-issues-row-title > a")].map(link => Number(link.getAttribute("href").split("/").at(-1)))

fixtures.selectRepo("maya/tinyhttp")
// A run ID alone cannot collapse two separate decisions.
const cors = fixtures.approvals.find(item => item.id === "approval-cors")
const corsTodo = fixtures.stack.find(item => item.id === "todo-33")
assert.ok(kit.waiting.sameDecision(corsTodo, cors))
for (const patch of [{ run: "another-run" }, { owner: "cora" }, { question: { ...corsTodo.question, text: "A different decision" } }]) {
  assert.equal(kit.waiting.sameDecision({ ...corsTodo, ...patch }, cors), false)
}
assert.equal(kit.waiting.waitingOnYou().total, 4)
sessionStorage.setItem("repo-pulls-v1:maya/tinyhttp:stack", JSON.stringify(fixtures.stack.map(item => item.id === corsTodo.id ? { ...item, question: { ...item.question, text: "A different decision" } } : item)))
assert.equal(kit.waiting.waitingOnYou().total, 5, "A separate decision on the same run keeps its own row/count")
sessionStorage.clear()
const answered = { ...cors, state: "approved", decided: { by: "maya", date: fixtures.MOCK_NOW, option: cors.options[0] } }
kit.waiting.resolveStackDecision(answered)
const answeredStack = JSON.parse(sessionStorage.getItem("repo-pulls-v1:maya/tinyhttp:stack"))
assert.equal(answeredStack.find(item => item.id === corsTodo.id).state, "working")
assert.equal(answeredStack.find(item => item.id === corsTodo.id).question, undefined)
assert.deepEqual(answeredStack.filter(item => item.id !== corsTodo.id), fixtures.stack.filter(item => item.id !== corsTodo.id))
sessionStorage.clear()
for (const [count, expected] of [[0,"releases"],[1,"release"],[2,"releases"]]) assert.equal(kit.pluralize(count, "release"), expected)
assert.equal(kit.pluralize(1, "branch", "branches"), "branch")
fixtures.selectRepo("smithers-canary/smithers")
const queuedFix = fixtures.issue(4218), queueEntry = fixtures.stack.find(entry => entry.issue === 4218)
assert.deepEqual(model.receiptStages(queuedFix).map(stage => stage.name), ["Reported", "Accepted", "Working", "Landed"])
assert.equal(model.landingLabel(queuedFix), "On main")
for (const [approver, expected] of [["maya", "Landed by maya"], ["smithers-agent", "On main"], ["missing", "On main"]]) {
  queueEntry.approver = approver
  assert.equal(model.landingLabel(queuedFix), expected, "Only a recorded person can be the subject of Landed")
}
delete queueEntry.approver
fixtures.selectRepo("maya/tinyhttp")
/* Only a closed issue with its landed fix belongs in Fixed by agents. */
for (const query of ["is:fixed-by-agents", "is:fixed-by-agents is:closed sort:created-asc"]) {
  await render(h(kit.Issues), list(query))
  assert.deepEqual(rowNumbers(), [31])
  assert.equal(container.querySelector('[aria-label="Issue state"]'), null)
  assert.equal(container.querySelector('[title="/issues.sort"]'), null)
  assert.equal(container.querySelector(".repo-issues-results-count").textContent, "1 issue")
}
await render(h(kit.Issues), list("is:open is:fixed-by-agents"))
assert.deepEqual(rowNumbers(), [], "A contradictory open filter cannot return closed fixes")
fixtures.selectRepo("effeck/effeck")
const fixed = fixtures.issue(31)
assert.equal(model.fixedByAgents(fixed), true)
assert.equal(model.fixedByAgents({ ...fixed, state: "open" }), false)
assert.equal(model.fixedByAgents({ ...fixed, receipt: { ...fixed.receipt, accepted: undefined } }), false)
assert.equal(model.fixedByAgents({ ...fixed, receipt: { ...fixed.receipt, landed: undefined } }), false)
assert.equal(model.fixedByAgents({ ...fixed, receipt: { ...fixed.receipt, landed: { ...fixed.receipt.landed, sha: "missing" } } }), false)
const fixCommit = fixtures.commit(fixed.receipt.landed.sha), originalAgent = fixCommit.agent
const proposal = { ...fixCommit, sha: "f".repeat(40), branches: ["proposal"], parents: [] }
try {
  fixtures.commits.push(proposal)
  assert.equal(model.fixedByAgents({ ...fixed, receipt: { ...fixed.receipt, landed: { ...fixed.receipt.landed, sha: proposal.sha } } }), false, "A branch proposal is not a main fix")
  proposal.branches = [fixtures.repo.defaultBranch]
  assert.equal(model.fixedByAgents({ ...fixed, receipt: { ...fixed.receipt, landed: { ...fixed.receipt.landed, sha: proposal.sha } } }), false, "A stale main label is not reachable remote-main evidence")
  fixCommit.agent = undefined
  assert.equal(model.fixedByAgents(fixed), false, "A human commit is not an agent fix")
} finally { fixtures.commits.splice(fixtures.commits.indexOf(proposal), 1); fixCommit.agent = originalAgent }
await render(h(kit.Issues), "smithers.sh/effeck/effeck/issues?q=is:fixed-by-agents%20is:open")
assert.deepEqual(rowNumbers(), [], "Effeck also honors the requested state")
await render(h(kit.Issues), "smithers.sh/effeck/effeck/issues?q=is:fixed-by-agents%20is:closed")
assert.deepEqual(rowNumbers(), [31])
assert.equal(container.querySelectorAll(".repo-issues-receipt").length, 1)
assert.ok([...container.querySelectorAll(".repo-issues-receipt a")].every(link => link.getAttribute("href").startsWith("#/smithers.sh/effeck/effeck/")))
await render(h(kit.CodeHome, { owner: "effeck", name: "effeck" }), "smithers.sh/effeck/effeck")
const evidence = () => container.querySelector('.repo-code-home-main .repo-code-home-evidence a.repo-code-home-fix-title[href="#/smithers.sh/effeck/effeck/issues/31"], .repo-code-home-main a.repo-code-home-evidence-title[href="#/smithers.sh/effeck/effeck/issues/31"]')
assert.ok(evidence())
try {
  await act(async () => model.saveIssue({ ...fixed, title: "Updated issue title" }))
  assert.ok(evidence().textContent.includes("Updated issue title"), "Home subscribes to saved title edits")
  await act(async () => model.setIssueClosed(model.allIssues().find(item => item.n === 31), false))
  assert.ok(evidence() === null, "Reopening removes the home evidence immediately")
  await render(h(kit.Issues), "smithers.sh/effeck/effeck/issues?q=is:fixed-by-agents")
  assert.deepEqual(rowNumbers(), [], "The list and home read the same reopened issue")
  await render(h(kit.CodeHome, { owner: "effeck", name: "effeck" }), "smithers.sh/effeck/effeck")
  assert.ok(evidence() === null, "Navigation keeps reopened issues out of fixed evidence")
  assert.ok(![...container.querySelectorAll(".repo-code-home-main .repo-ui-box-header")].some(header => header.textContent === "Fixed by agents"), "Omit the entire fixes block when no verified closed pair remains")
  await act(async () => model.setIssueClosed(model.allIssues().find(item => item.n === 31), true))
  assert.ok(evidence().textContent.includes("Updated issue title"), "Closing restores current evidence")
} finally { await act(async () => model.saveIssue(fixed)) }
fixtures.selectRepo("maya/tinyhttp")
await render(h(kit.Issues), list("is:open"))
assert.ok(container.querySelector('[aria-label="Issue state"]'))
assert.ok(!rowNumbers().includes(31))
await render(h(kit.Issues), list("is:closed"))
assert.ok(rowNumbers().includes(31))
assert.ok(!rowNumbers().includes(11))
await render(h(kit.Issues), list("is:fixed-by-agents label:missing"))
assert.ok(container.textContent.includes("No issues match your filters"))

/* Each reached stage has the actual evidence link and a check, including the final stage. */
await render(h(kit.Issue, { n: 31 }), `${base}/issues/31`)
const stages = [...container.querySelectorAll(".repo-issues-receipt > li")]
const landed = fixtures.issue(31).receipt.landed.sha
assert.deepEqual(stages.map(stage => stage.querySelector("a").getAttribute("href")), [
  `#/${base}/issues/31`, `#/${base}/issues/31?evidence=accepted`, `#/${base}/runs/run-507`,
  `#/${base}/pull/32`, `#/${base}/commit/${landed}`
])
for (const stage of stages) {
  assert.equal(stage.dataset.complete, "true")
  assert.equal(stage.querySelector(".repo-issues-receipt-dot path").getAttribute("d"), "m4.5 12.5 5 5 10-11")
}
const suggestions = [...container.querySelectorAll(".repo-frame-suggestion")].map(item => item.textContent)
assert.ok(suggestions.includes(`What happened with #31: ${fixtures.issue(31).title}?`))
assert.ok(suggestions.includes("Which changes relate to this issue?"))
assert.ok(!suggestions.includes("How is a request handled?"))
assert.ok(!suggestions.includes("Where should I start reading?"))

await render(h(kit.Issue, { n: 11 }), `${base}/issues/11`)
assert.equal(container.querySelectorAll('.repo-issues-receipt > li[data-complete="true"] a').length, 3)
for (const stage of container.querySelectorAll('.repo-issues-receipt > li[data-complete="false"]')) {
  assert.equal(stage.querySelector("a, svg"), null)
}
const invalid = structuredClone(fixtures.issue(31))
invalid.receipt.landed.sha = "missing-commit"
await render(h(kit.FactoryReceipt, { issue: invalid }), `${base}/issues/31`)
assert.equal(container.querySelector(".repo-issues-receipt > li:last-child").dataset.complete, "false")
assert.equal(container.querySelector(".repo-issues-receipt > li:last-child a"), null)

/* Acceptance links scroll to the recorded event, including datasets with receipt-only acceptance. */
scrolled = undefined
await render(h(kit.Issue, { n: 31 }), `${base}/issues/31?evidence=accepted`)
assert.ok(scrolled.textContent.includes("accepted"))
assert.equal(scrolled.id, "repo-issues-event-0")
fixtures.selectRepo("Effect-TS/effect")
scrolled = undefined
await render(h(kit.Issue, { n: 42 }), "smithers.sh/Effect-TS/effect/issues/42?evidence=accepted")
assert.ok(scrolled.textContent.includes("cora accepted this issue"))
fixtures.selectRepo("maya/tinyhttp")

/* The same public reads retain loading, error, empty and signed-out states. */
for (const [overrides, expected] of [
  [{ net: "slow" }, "Loading"], [{ net: "error" }, "GitHub sync failed"],
  [{ data: "empty" }, "No issues fixed by agents yet."]
]) {
  await render(h(kit.Issues), list("is:fixed-by-agents"), overrides)
  assert.ok(container.textContent.includes(expected))
}
await render(h(kit.Issues), list("is:fixed-by-agents"), { as: "out" })
assert.deepEqual(rowNumbers(), [31])
await render(h(kit.Issue, { n: 29 }), `${base}/issues/29?act=implement`, { role: "reader" })
assert.ok(container.textContent.includes("Only members of maya/tinyhttp can start agent work"))
await render(h(kit.Issue, { n: 29 }), `${base}/issues/29?act=implement`, { landing: "install" })
assert.ok(container.textContent.includes("Hosted runs that change code are held."))
assert.equal(button("Start run"), undefined)

/* Exercise real issue commands through Ask: collect only missing input and mutate the requested issue. */
await clear()
const unregister = kit.registerIssueCommands()
const commands = ["implement", "repro", "todo", "close", "comment"]
for (const name of commands) assert.ok(kit.getSlash(`issue.${name}`))
const ask = text => h(kit.AskPanel, { view: "issues/:n", prompt: { text, revision: ++revision, send: true }, onClose() {} })
const beforeRuns = fixtures.runs.length
const beforeComments = model.allIssues().find(item => item.n === 29).comments.length
await render(ask("/issue.comment 29"), `${base}/issues/29`)
const form = container.querySelector("form.repo-frame-confirm")
assert.equal(form.querySelectorAll("input, textarea").length, 1)
assert.equal(form.querySelector("label").textContent, "Comment")
form.querySelector("textarea").value = "The malformed route regression also needs a HEAD request."
await submit(form)
assert.equal(model.allIssues().find(item => item.n === 29).comments.length, beforeComments)
await click(container.querySelector(".repo-frame-confirm .repo-ui-btn-primary"))
assert.equal(model.allIssues().find(item => item.n === 29).comments.length, beforeComments + 1)
assert.equal(fixtures.runs.length, beforeRuns)

await render(ask("/issue.todo 39"), `${base}/issues`)
await click(container.querySelector(".repo-frame-confirm .repo-ui-btn-primary"))
assert.ok(model.todoFor(model.allIssues().find(item => item.n === 39)))
const todoCount = fixtures.stack.length
await render(ask("/issue.todo 39"), `${base}/issues`)
await click(container.querySelector(".repo-frame-confirm .repo-ui-btn-primary"))
assert.equal(fixtures.stack.length, todoCount)
await render(ask("/issue.close 39"), `${base}/issues`)
await click(container.querySelector(".repo-frame-confirm .repo-ui-btn-primary"))
assert.equal(model.allIssues().find(item => item.n === 39).state, "closed")

await render(ask("/issue.close 31"), `${base}/issues/31`, { role: "reader" })
await click(container.querySelector(".repo-frame-confirm .repo-ui-btn-primary"))
assert.ok(container.querySelector('[role="alert"]').textContent.includes("Only members or the issue's author"))
await render(ask("/issue.todo 29"), `${base}/issues/29`, { role: "reader" })
assert.ok(container.textContent.includes("Only members"))
await render(ask("/issue.comment 29 hi"), `${base}/issues/29`, { as: "out" })
assert.ok(container.textContent.includes("Sign in to continue"))
await render(ask("/issue.implement 999"), `${base}/issues`)
assert.ok(container.querySelector('[role="alert"]').textContent.includes("wasn't found"))
assert.equal(fixtures.runs.length, beforeRuns)

for (const command of ["implement", "repro"]) {
  await render(ask(`/issue.${command} 29`), `${base}/issues`)
  assert.ok(window.location.hash.endsWith(`/issues/29?act=${command}`))
  assert.equal(fixtures.runs.length, beforeRuns)
}
await act(async () => unregister())

/* Starting from the real confirmation creates a run for this issue with the correct flow. */
await render(h(kit.Issue, { n: 29 }), `${base}/issues/29?act=repro`)
await click(button("Start run"))
const started = fixtures.runs.find(run => run.id === window.location.hash.split("/").at(-1))
assert.equal(started.issue, 29)
assert.equal(started.flow, "reproduce-issue")
await clear()
for (const name of ["repro", "todo", "close", "comment"]) assert.equal(kit.getSlash(`issue.${name}`), undefined)
await window.happyDOM.close()
for (const channel of channels) { channel.port1.close(); channel.port2.close() }
stop()
console.log("Issue regressions passed: receipt list/order/state filters, evidence links/checks, acceptance events, Ask context, read states, five slash actions/access/cleanup.")
