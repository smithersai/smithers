// node --test .specs/design/mock/review-evidence.test.mjs
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { after, test } from "node:test"

const require = createRequire(new URL("../../../package.json", import.meta.url))
const { Window } = require("happy-dom")
const window = new Window({ url: "http://localhost/?still=1" })
for (const name of ["window", "document", "sessionStorage", "history", "Event", "CustomEvent", "HTMLElement"]) {
  globalThis[name] = name === "window" ? window : window[name]
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act, createElement } = require("react")
const { createRoot } = require("react-dom/client")
const bundle = await require("esbuild").build({
  stdin: {
    contents: `
      export * as fixtures from "./src/sites/repo/fixtures"
      export { checkState } from "./src/sites/repo/views/pulls/shared"
      export { PullsReady } from "./src/sites/repo/views/pulls/PullsList"
      export { StackReady } from "./src/sites/repo/views/pulls/Stack"
      export { applyProposal, proposalDiff, WikiReady } from "./src/sites/repo/views/wiki/Wiki"
      export { getSlash } from "./src/sites/repo/frame/slash"
      export { MockProvider, DEFAULTS } from "./src/sites/core/mock"
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "tsx"
  },
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
  external: ["react", "react/*", "react-dom", "react-dom/*"], logLevel: "silent"
})
const module = { exports: {} }
new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, module, module.exports)
const { fixtures, checkState, PullsReady, StackReady, applyProposal, proposalDiff, WikiReady, getSlash, MockProvider, DEFAULTS } = module.exports

async function mount(Component, props, { slug = "maya/tinyhttp", login = "maya", as = "in", role = "member" } = {}) {
  assert.equal(fixtures.selectRepo(slug), true)
  sessionStorage.clear()
  sessionStorage.setItem(`repo-runs:${slug}`, JSON.stringify({ runs: {}, approvals: {} }))
  sessionStorage.setItem("site-mock-flags", JSON.stringify({ ...DEFAULTS, as, role }))
  const roles = fixtures.people.map(person => person.role)
  const owner = fixtures.people.find(person => person.role === "owner")
  const viewer = fixtures.people.find(person => person.login === login)
  assert.ok(owner && viewer)
  owner.role = viewer.role
  viewer.role = "owner"
  window.location.hash = `#/smithers.sh/${slug}/wiki/${props.slug ?? ""}`
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(createElement(MockProvider, null, createElement(Component, props))))
  return {
    container,
    async close() {
      await act(() => root.unmount())
      container.remove()
      fixtures.people.forEach((person, i) => { person.role = roles[i] })
    }
  }
}

after(async () => { await window.happyDOM.close() })

test("pull check state succeeds only with nonempty, entirely successful evidence", () => {
  const states = ["success", "failure", "pending", "skipped"]
  const cases = [[]]
  for (const a of states) for (const b of states) cases.push([a], [a, b])
  for (const checks of cases) {
    const expected = !checks.length ? "unknown" : checks.includes("failure") ? "failure"
      : checks.includes("pending") ? "pending" : checks.includes("skipped") ? "skipped" : "success"
    assert.equal(checkState({ checks: checks.map(state => ({ name: "check", state })) }), expected, JSON.stringify(checks))
  }
})

for (const [slug, n] of [["smithers-canary/smithers", 3723], ["effeck/effeck", 103]]) {
  test(`pull list reports unavailable check evidence for ${slug} #${n}`, async () => {
    const view = await mount(PullsReady, { query: "is:open" }, { slug })
    try {
      assert.deepEqual(fixtures.pull(n).checks, [])
      const link = view.container.querySelector(`a[aria-label="Checks for #${n}: unknown"]`)
      assert.ok(link, "The list must not claim successful verification")
      assert.equal(link.title, "Checks: unknown")
      assert.equal(link.querySelector('[role="img"]').getAttribute("aria-label"), "unknown")
    } finally { await view.close() }
  })
}

test("pull list renders skipped evidence without a successful glyph or tooltip", async () => {
  fixtures.selectRepo("maya/tinyhttp")
  const item = fixtures.pull(34)
  const original = item.checks
  item.checks = [{ name: "test", state: "skipped" }]
  const view = await mount(PullsReady, { query: "is:open" })
  try {
    const link = view.container.querySelector('a[aria-label="Checks for #34: skipped"]')
    assert.ok(link)
    assert.equal(link.title, "Checks: skipped")
    assert.equal(link.querySelector('[role="img"]').getAttribute("aria-label"), "skipped")
  } finally { await view.close(); item.checks = original }
})

for (const [slug, contextLine, addition] of [
  ["middleware-order", 10, "Credentials require an explicit origin; wildcard origins are rejected at construction."],
  ["adapters", 7, "Cancel the response producer when the client socket closes; verify with a real socket."]
]) {
  test(`accepted ${slug} proposal matches its preview and exact page body`, async () => {
    fixtures.selectRepo("maya/tinyhttp")
    const page = fixtures.wikiPage(slug)
    const proposal = page.proposals[0]
    const expected = page.body.split("\n")
    expected.splice(contextLine, 0, addition)
    assert.equal(proposalDiff(page, proposal)[0].lines.find(line => line.kind === "add").new, contextLine + 1)
    assert.equal(applyProposal(page.body, proposal.diff), expected.join("\n"))
    const view = await mount(WikiReady, { slug })
    try {
      await act(() => view.container.querySelector(`button[title="/wiki.accept ${proposal.run}"]`).click())
      await act(() => view.container.querySelector(".repo-wiki-confirm button").click())
      assert.equal(view.container.querySelectorAll(".repo-wiki-proposal").length, 0)
      assert.match(view.container.querySelector(".repo-wiki-meta").textContent, new RegExp(`revision ${page.revision + 1}`))
      await act(() => getSlash("wiki.edit").run({}, { closeAsk() {} }))
      assert.equal(view.container.querySelector("textarea").value, expected.join("\n"))
    } finally { await view.close() }
  })
}

test("wiki patches consume context at coordinates, replacements and multiple hunks", () => {
  assert.equal(applyProposal("", "@@ -0,0 +1,1 @@\n+first"), "first")
  assert.equal(applyProposal("alpha", "@@ -1,1 +0,0 @@\n-alpha"), "")
  assert.equal(applyProposal("alpha\nbeta\ngamma", "@@ -2,1 +2,2 @@\n beta\n+new"), "alpha\nbeta\nnew\ngamma")
  assert.equal(applyProposal("alpha\nbeta\ngamma\ndelta", "@@ -2,1 +2,2 @@\n-beta\n+B\n+extra\n@@ -4,1 +5,1 @@\n-delta\n+D"), "alpha\nB\nextra\ngamma\nD")
  assert.equal(applyProposal("alpha\nbeta", "@@ -0,0 +1,1 @@\n+first"), "first\nalpha\nbeta")
  assert.equal(applyProposal("alpha\nbeta", "@@ -2,0 +3,1 @@\n+last"), "alpha\nbeta\nlast")
})

test("wiki rejects conflicting or malformed patches rather than partially applying them", () => {
  const body = "alpha\nbeta\ngamma"
  for (const diff of [
    "@@ -2,1 +2,1 @@\n-missing\n+new",
    "@@ -2,1 +2,2 @@\n unrelated\n+new",
    "@@ -1,1 +1,2 @@\n beta\n+new",
    "@@ -2,1 +3,2 @@\n beta\n+new",
    "@@ -2,1 +2,1 @@\n-beta\n+new\n+extra",
    "@@ -20,1 +20,2 @@\n beta\n+new",
    "@@ -2,1 +2,1 @@\n-beta\n+new\n@@ -3,1 +3,1 @@\n-missing\n+last",
    "+unanchored",
    "@@ -2,2 +2,1 @@\n-beta\n+new",
    "@@ -2,1 +2,1 @@\n-beta\n+new\n@@ -1,1 +1,1 @@\n-alpha\n+first"
  ]) assert.throws(() => applyProposal(body, diff), /proposal|patch|conflict/i, diff)
  assert.equal(body, "alpha\nbeta\ngamma")
})

test("shortened wiki context rejects negated prose and changed code operators", () => {
  fixtures.selectRepo("maya/tinyhttp")
  const page = fixtures.wikiPage("adapters")
  assert.throws(() => applyProposal(
    page.body.replace("The application owns", "The application no longer owns"),
    page.proposals[0].diff
  ), /conflicts/)
  for (const [body, context] of [
    ["if (x != 1)", "if (x == 1)"], ["alphabet soup", "alpha"],
    ["return + b", "return a + b"], ["const the = 1", "const a = 1"]
  ]) {
    assert.throws(() => applyProposal(body, `@@ -1,1 +1,2 @@\n ${context}\n+new`), /conflicts/)
  }
})

test("wiki code context is exact even when it resembles a prose sentence", () => {
  for (const fence of ["```", "~~~"]) {
    const body = `# Example\n\n${fence}text\nThe statement mentions an option.\n${fence}`
    assert.throws(() => applyProposal(body, "@@ -4,1 +4,2 @@\n The statement mentions option.\n+new"), /conflicts/)
  }
  assert.throws(() => applyProposal("    The statement mentions an option.", "@@ -1,1 +1,2 @@\n The statement mentions option.\n+new"), /conflicts/)
})

test("conflicting wiki acceptance leaves the proposal and revision intact", async () => {
  fixtures.selectRepo("maya/tinyhttp")
  const page = fixtures.wikiPage("adapters")
  const original = page.body
  page.body = original.replace("The adapter creates an unbound Node server.", "The page changed.")
    .replace("The application owns listen(), shutdown, and process signals.", "Ownership changed.")
  const view = await mount(WikiReady, { slug: page.slug })
  const errors = []
  const listen = event => errors.push(event.detail)
  window.addEventListener("repo-toast", listen)
  try {
    await act(() => getSlash("wiki.accept").run({ run: page.proposals[0].run }))
    assert.equal(view.container.querySelectorAll(".repo-wiki-proposal").length, 1)
    assert.match(view.container.querySelector(".repo-wiki-meta").textContent, new RegExp(`revision ${page.revision}`))
    assert.ok(errors.length > 0, "The conflict must be visible")
    await act(() => getSlash("wiki.edit").run({}, { closeAsk() {} }))
    assert.equal(view.container.querySelector("textarea").value, page.body)
  } finally {
    window.removeEventListener("repo-toast", listen)
    await view.close()
    page.body = original
  }
})

for (const [login, as, role, allowed] of [
  ["maya", "in", "member", false], ["cora", "in", "member", true],
  ["cora", "in", "reader", false], ["cora", "out", "member", false]
]) {
  test(`standalone Effect question ownership: ${login}, ${as}, ${role}`, async () => {
    const view = await mount(StackReady, { filter: "" }, { slug: "Effect-TS/effect", login, as, role })
    try {
      const id = "todo-46"
      const row = view.container.querySelector(`#repo-pulls-stack-${id}`)
      const before = fixtures.stack.find(item => item.id === id)
      assert.equal(before.owner, "cora")
      const buttons = row.querySelectorAll(".repo-pulls-answer-options button")
      // Invoke the registered action too: hiding controls alone cannot protect the mutation.
      await act(() => getSlash("stack.answer").run({ item: id, answer: before.question.options[0] }, { closeAsk() {} }))
      const saved = JSON.parse(sessionStorage.getItem("repo-pulls-v1:Effect-TS/effect:stack") ?? "null")
      const item = saved?.find(item => item.id === id) ?? before
      assert.equal(item.state, allowed ? "working" : "needs-answer")
      assert.equal(Boolean(item.question), !allowed)
      assert.equal(buttons.length, allowed ? before.question.options.length : 0)
    } finally { await view.close() }
  })
}

for (const [login, allowed] of [["maya", true], ["cora", false]]) {
  test(`linked stack decision preserves approval ownership: ${login}`, async () => {
    const view = await mount(StackReady, { filter: "" }, { login })
    try {
      const item = fixtures.stack.find(item => item.id === "todo-33")
      const decision = fixtures.approvals.find(item => item.id === "approval-cors")
      assert.equal(item.question.text, decision.question)
      await act(() => getSlash("stack.answer").run({ item: item.id, answer: decision.options[0] }, { closeAsk() {} }))
      const saved = JSON.parse(sessionStorage.getItem("repo-runs:maya/tinyhttp"))
      const result = saved.approvals[decision.id] ?? decision
      assert.equal(result.state, allowed ? "approved" : "waiting")
      if (allowed) assert.equal(result.decided.by, "maya")
    } finally { await view.close() }
  })
}

test("stack answer rejects options absent from the linked approval", async () => {
  fixtures.selectRepo("maya/tinyhttp")
  const item = fixtures.stack.find(item => item.id === "todo-33")
  const options = item.question.options
  item.question.options = [...options, "Unapproved option"]
  const view = await mount(StackReady, { filter: "" })
  try {
    await act(() => getSlash("stack.answer").run({ item: item.id, answer: "Unapproved option" }, { closeAsk() {} }))
    assert.equal(sessionStorage.getItem("repo-pulls-v1:maya/tinyhttp:stack"), null)
    assert.deepEqual(JSON.parse(sessionStorage.getItem("repo-runs:maya/tinyhttp")).approvals, {})
    assert.equal(view.container.querySelectorAll("#repo-pulls-stack-todo-33 .repo-pulls-answer-options button").length, 3)
  } finally { await view.close(); item.question.options = options }
})
