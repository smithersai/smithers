// Real repository views, controls and tab storage; run with node --test.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { MessageChannel } from "node:worker_threads"
import test, { after } from "node:test"

const rootPath = fileURLToPath(new URL("../../../../../../../", import.meta.url))
const require = createRequire(new URL("../../../../../../../package.json", import.meta.url))
const { Window } = await import(require.resolve("happy-dom"))
const window = new Window({ url: "https://mock.test/?still=1" })
for (const key of ["window", "document", "navigator", "HTMLElement", "Event", "CustomEvent", "FormData", "sessionStorage", "localStorage", "history"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : window[key] })
}
globalThis.matchMedia = window.matchMedia.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const channels = []
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this) }
}
window.HTMLElement.prototype.scrollIntoView = function () {}

const { build, stop } = require("esbuild")
const bundle = await build({
  stdin: {
    contents: `
      export { default as React, act } from "react"
      export { createRoot } from "react-dom/client"
      export { DEFAULTS, MockProvider } from "./.specs/design/mock/src/sites/core/mock"
      export { PullReady } from "./.specs/design/mock/src/sites/repo/views/pulls/PullPage"
      export { localPull } from "./.specs/design/mock/src/sites/repo/views/pulls/shared"
      export * as reviews from "./.specs/design/mock/src/sites/repo/views/pulls/shared"
      export { AgentsReady } from "./.specs/design/mock/src/sites/repo/views/flows/Agents"
      export { FlowReady, FlowOverview } from "./.specs/design/mock/src/sites/repo/views/flows/Flow"
      export { startFlowRun } from "./.specs/design/mock/src/sites/repo/views/flows/actions"
      export { getSlash } from "./.specs/design/mock/src/sites/repo/frame/slash"
      export * as fixtures from "./.specs/design/mock/src/sites/repo/fixtures"
    `,
    resolveDir: rootPath, loader: "tsx"
  },
  bundle: true, write: false, format: "cjs", platform: "browser", jsx: "automatic",
  nodePaths: [fileURLToPath(new URL("node_modules", `file://${rootPath}`))],
  loader: { ".css": "empty" }
})
const module = { exports: {} }
new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, module, module.exports)
const kit = module.exports
const { React, act, fixtures } = kit
const h = React.createElement
const container = document.createElement("div")
document.body.append(container)
let root
const unmount = async () => {
  if (root) await act(async () => root.unmount())
  root = undefined
}
const render = async (content, path, flags = {}) => {
  await unmount()
  sessionStorage.setItem("site-mock-flags", JSON.stringify({ ...kit.DEFAULTS, as: "in", landing: "open", ...flags }))
  window.location.hash = `#/smithers.sh/${fixtures.repo.slug}/${path}`
  root = kit.createRoot(container)
  await act(async () => root.render(h(kit.MockProvider, null, content)))
}
const click = async element => {
  assert.ok(element, "control exists")
  await act(async () => element.click())
}
const button = text => [...container.querySelectorAll("button")].find(element => element.textContent.trim() === text)
const submit = async form => {
  assert.ok(form, "form exists")
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
}
const typeComment = async text => {
  const textarea = container.querySelector("#repo-pulls-line-comment")
  assert.ok(textarea)
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea, text)
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const fresh = async () => {
  await unmount()
  sessionStorage.clear()
  fixtures.selectRepo("maya/tinyhttp")
}
const diffLine = side => container.querySelector(`.repo-pulls-diff-${side === "old" ? "del" : "add"} button[aria-label="Comment on src/query.ts line 13"]`).closest('[role="row"]')
const expectThread = (side, text) => {
  const thread = [...container.querySelectorAll(".repo-pulls-inline-thread")].find(element => element.textContent.includes(text))
  assert.ok(thread, `Shows comment: ${text}`)
  assert.ok(thread.previousElementSibling === diffLine(side), "Comment stays on its original diff side")
  return thread
}
after(async () => {
  await unmount()
  await window.happyDOM.close()
  for (const channel of channels) { channel.port1.close(); channel.port2.close() }
  stop()
})

for (const side of ["new", "old"]) test(`line comments preserve the ${side} side through posting, links, resolve and reload`, async () => {
  await fresh()
  const pull = fixtures.pull(12)
  await render(h(kit.PullReady, { initial: pull, tab: "files" }), "pull/12/files")
  await click(diffLine(side).querySelector("button"))
  const selected = container.querySelectorAll('[data-selected="true"]')
  assert.equal(selected.length, 1, "Selects exactly one replacement row")
  assert.ok(selected[0] === diffLine(side))
  assert.ok(container.querySelector("#repo-pulls-line-comment").closest(".repo-pulls-inline-thread").previousElementSibling === diffLine(side))
  await typeComment(`Discuss the ${side} statement`)
  await submit(container.querySelector("#repo-pulls-line-comment").closest("form"))
  assert.equal(kit.localPull(pull).reviewComments.at(-1).side, side, "Storage retains diff side")
  let thread = expectThread(side, `Discuss the ${side} statement`)
  const excerpt = pull.files.find(file => file.path === "src/query.ts").lines.find(line => line[side] === 13).text
  assert.ok(thread.textContent.includes(excerpt), "Excerpt comes from the commented side")
  const link = thread.querySelector(".repo-pulls-thread-head a").getAttribute("href")
  assert.equal(new URLSearchParams(link.split("?")[1]).get("side"), side)
  assert.match(thread.querySelector('button[title^="/pull.thread."]').title, new RegExp(`13 ${side}$`))
  await click([...thread.querySelectorAll("button")].find(element => element.textContent === "Resolve conversation"))
  thread = expectThread(side, `Discuss the ${side} statement`)
  await click([...thread.querySelectorAll("button")].find(element => element.textContent === "Reopen conversation"))
  assert.equal(kit.localPull(pull).reviewComments.at(-1).side, side)
  await render(h(kit.PullReady, { initial: pull, tab: "files" }), link.replace(/^#\/smithers.sh\/maya\/tinyhttp\//, ""))
  thread = expectThread(side, `Discuss the ${side} statement`)
  assert.ok(thread.textContent.includes(excerpt))
  assert.equal(container.querySelectorAll('[data-selected="true"]').length, 1)
  assert.ok(container.querySelector('[data-selected="true"]') === diffLine(side))
})

test("pending review comments retain both replacement sides on submit and navigation", async () => {
  await fresh()
  const pull = fixtures.pull(12)
  await render(h(kit.PullReady, { initial: pull, tab: "files" }), "pull/12/files")
  for (const side of ["old", "new"]) {
    await click(diffLine(side).querySelector("button"))
    await typeComment(`Pending ${side} statement`)
    await click(button(side === "old" ? "Start a review" : "Add to review"))
    expectThread(side, `Pending ${side} statement`)
  }
  await render(h(kit.PullReady, { initial: pull, tab: "files" }), "pull/12/files?review=1")
  for (const side of ["old", "new"]) expectThread(side, `Pending ${side} statement`)
  await submit(container.querySelector("#repo-pulls-review-body").closest("form"))
  assert.deepEqual(kit.localPull(pull).reviewComments.slice(-2).map(comment => comment.side), ["old", "new"])
  await render(h(kit.PullReady, { initial: pull, tab: "conversation" }), "pull/12")
  for (const side of ["old", "new"]) {
    const thread = [...container.querySelectorAll(".repo-pulls-thread")].find(element => element.textContent.includes(`Pending ${side} statement`))
    const excerpt = pull.files.find(file => file.path === "src/query.ts").lines.find(line => line[side] === 13).text
    assert.ok(thread.textContent.includes(excerpt))
    assert.equal(new URLSearchParams(thread.querySelector("a").getAttribute("href").split("?")[1]).get("side"), side)
  }
})

test("agent model edits survive navigation and supply roles and the next run", async () => {
  await fresh()
  await render(h(kit.AgentsReady), "agents")
  const model = "claude-sonnet-5-5"
  const select = container.querySelector("#repo-agent-implementer")
  await act(async () => {
    select.value = model
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  assert.equal(select.value, model)
  assert.equal(JSON.parse(sessionStorage.getItem("repo-agent-models:maya/tinyhttp") ?? "{}").implementer, model, "Model edits are persisted")
  const flow = fixtures.flow("implement-issue")
  await render(h(kit.FlowReady, { flow }), "flows/implement-issue")
  assert.equal(container.querySelector(".repo-flows-role code").textContent, model, "Roles uses the saved model")
  await click(button("Run this flow"))
  await submit(container.querySelector(".repo-flows-form form"))
  await submit(container.querySelector(".repo-flows-form form"))
  const id = window.location.hash.split("/").at(-1)
  const run = JSON.parse(sessionStorage.getItem("repo-runs:maya/tinyhttp")).runs[id]
  assert.equal(run.harness, `Claude Code · ${model}`, "The new run uses the saved model")
  await render(h(kit.AgentsReady), "agents")
  assert.equal(container.querySelector("#repo-agent-implementer").value, model)
  fixtures.selectRepo("Effect-TS/effect")
  await render(h(kit.AgentsReady), "agents")
  assert.equal(container.querySelector("#repo-agent-implementer").value, fixtures.agents.find(agent => agent.id === "implementer").model, "Another repository keeps its own configuration")
  fixtures.selectRepo("maya/tinyhttp")
  await render(h(kit.AgentsReady), "agents")
  assert.equal(container.querySelector("#repo-agent-implementer").value, model)
  assert.equal(fixtures.agents.find(agent => agent.id === "implementer").model, "claude-opus-5-5", "The fixture remains unchanged")
  // A fresh module graph represents a reload: only tab storage carries the edit over.
  await unmount()
  const reloadedModule = { exports: {} }
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, reloadedModule, reloadedModule.exports)
  const reloaded = reloadedModule.exports
  reloaded.fixtures.selectRepo("maya/tinyhttp")
  const reloadedRoot = reloaded.createRoot(container)
  try {
    const element = reloaded.React.createElement
    await reloaded.act(async () => reloadedRoot.render(element(reloaded.MockProvider, null, element(reloaded.AgentsReady))))
    assert.equal(container.querySelector("#repo-agent-implementer").value, model, "A reload restores the stored model")
    const runId = reloaded.startFlowRun(reloaded.fixtures.flow("implement-issue"), { issue: "11" })
    assert.equal(JSON.parse(sessionStorage.getItem("repo-runs:maya/tinyhttp")).runs[runId].harness, `Claude Code · ${model}`)
  } finally { await reloaded.act(async () => reloadedRoot.unmount()) }
})

test("slash model edits update mounted roles and remain read only for nonmembers", async () => {
  await fresh()
  const flow = fixtures.flow("implement-issue")
  await render(h(React.Fragment, null, h(kit.AgentsReady), h(kit.FlowOverview, { flow })), "agents")
  await act(async () => kit.getSlash("agent.model").run({ agent: "implementer", model: "claude-sonnet-5-5" }))
  assert.equal(container.querySelector(".repo-flows-role code").textContent, "claude-sonnet-5-5")
  assert.throws(() => kit.getSlash("agent.model").run({ agent: "implementer", model: "gpt-6.1-sol" }), /Choose a Claude model/)
  assert.throws(() => kit.getSlash("agent.model").run({ agent: "missing", model: "claude-sonnet-5-5" }), /Agent not found/)
  for (const flags of [{ role: "reader" }, { as: "out" }]) {
    await render(h(kit.AgentsReady), "agents", flags)
    assert.equal(container.querySelector("select"), null)
    await act(async () => kit.getSlash("agent.model").run({ agent: "implementer", model: "claude-opus-5-5" }))
  }
  await render(h(kit.AgentsReady), "agents")
  assert.equal(container.querySelector("#repo-agent-implementer").value, "claude-sonnet-5-5")
})


test("legacy comments infer new, old-only and unavailable lines without losing explicit sides", async () => {
  await fresh()
  const file = fixtures.pull(12).files[0]
  const comment = { path: file.path, line: 13, author: "maya", body: "Saved comment", date: fixtures.MOCK_NOW }
  assert.equal(kit.reviews.reviewSide(comment, file), "new", "A replacement defaults to the new statement")
  const deletion = { ...file, lines: file.lines.filter(line => line.kind === "del") }
  assert.equal(kit.reviews.reviewSide(comment, deletion), "old", "Old-only legacy comments keep their deletion")
  assert.equal(kit.reviews.reviewSide({ ...comment, side: "old" }, file), "old")
  assert.equal(kit.reviews.reviewSide({ ...comment, line: 999 }, file), "new")
  assert.equal(kit.reviews.reviewSide(comment), "new")
})
