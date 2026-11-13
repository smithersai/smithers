/* node .specs/design/mock/src/sites/repo/frame/frame.test.mjs — DOM regressions; no browser launch. */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { MessageChannel as NodeMessageChannel } from "node:worker_threads"

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../..")
const requireApp = createRequire(join(rootPath, "apps/app/package.json"))
const { Window } = await import(requireApp.resolve("happy-dom"))
const window = new Window({ url: "https://mock.test/?still=1#/smithers.sh/maya/tinyhttp?as=in&ask=sample" })
for (const key of ["window", "document", "navigator", "HTMLElement", "Event", "CustomEvent", "FormData", "sessionStorage", "localStorage", "history"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : window[key] })
}
window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
globalThis.matchMedia = window.matchMedia
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/* Close the ports React's browser act() creates, so the standalone test exits after cleanup. */
const channels = []
globalThis.MessageChannel = class extends NodeMessageChannel {
  constructor() { super(); channels.push(this) }
}

const { build } = requireApp("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      import React, { act, useEffect } from "react"
      import { createRoot } from "react-dom/client"
      import { DEFAULTS, MockProvider, useMock } from "./.specs/design/mock/src/sites/core/mock"
      import { AskPanel } from "./.specs/design/mock/src/sites/repo/frame/AskPanel"
      import { RepoFrame } from "./.specs/design/mock/src/sites/repo/frame/RepoFrame"
      import { CodeHomeReady } from "./.specs/design/mock/src/sites/repo/views/code-home/CodeHome"
      import * as fixtures from "./.specs/design/mock/src/sites/repo/fixtures"
      export { registerSlash, getSlash, parseSlash, missingSlashFields } from "./.specs/design/mock/src/sites/repo/frame/slash"
      export { React, act, createRoot, DEFAULTS, MockProvider, AskPanel, RepoFrame, CodeHomeReady }
      export const fixtureInfo = () => ({ sample: fixtures.askFor(""), entries: fixtures.children("").map(entry => ({ ...entry, last: fixtures.commit(entry.sha) })) })
      export const selectRepo = fixtures.selectRepo
      export const Flags = ({ next, children }) => { const { set } = useMock(); useEffect(() => set(next), [next]); return children }
    `,
    resolveDir: rootPath,
    loader: "jsx"
  },
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  nodePaths: [join(rootPath, "apps/app/node_modules"), join(rootPath, "node_modules")],
  alias: { "@smthrs/ui": join(rootPath, "packages/smithers/ui/src/index.ts") },
  loader: { ".css": "empty" }
})
const bundleDir = await mkdtemp(join(tmpdir(), "repo-frame-test-"))
const bundlePath = join(bundleDir, "frame.mjs")
await writeFile(bundlePath, bundled.outputFiles[0].text)
const kit = await import(pathToFileURL(bundlePath).href)
const { React, act, DEFAULTS } = kit
const h = React.createElement
const container = document.createElement("div")
document.body.append(container)
let root
let revision = 0
const flags = overrides => ({ ...DEFAULTS, as: "in", ...overrides })
const render = async (content, next = flags()) => {
  root ??= kit.createRoot(container)
  await act(async () => root.render(h(kit.MockProvider, null, h(kit.Flags, { next }, content))))
}
const clear = async () => { if (root) await act(async () => root.unmount()); root = undefined; sessionStorage.clear() }
const route = async value => {
  await act(async () => { window.location.hash = `#/${value}`; window.dispatchEvent(new window.HashChangeEvent("hashchange")) })
}
const ask = (text = "", send = false) => h(kit.AskPanel, { view: "", prompt: { text, revision: ++revision, send }, onClose() {} })
const commandForm = () => container.querySelector("form.repo-frame-confirm")
const button = (label, within = container) => [...within.querySelectorAll("button")].find(item => item.textContent === label)
const click = async item => { assert.ok(item, "button exists"); await act(async () => item.click()) }
const submit = async form => { assert.ok(form, "form exists"); await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))) }

try {
/* Parent route flags apply after Ask's first effect, just as Shell does on a cold load. */
kit.selectRepo("maya/tinyhttp")
await render(ask(), flags())
assert.ok(container.textContent.includes("matches a method and path, fills params"))
assert.ok(!container.textContent.includes("Sign in to ask about this repo"))
await render(ask(), flags({ as: "out", guest: "off" }))
assert.ok(container.textContent.includes("Sign in to ask about this repo"))
await render(ask(), flags({ as: "in", guest: "off" }))
assert.ok(!container.textContent.includes("Sign in to ask about this repo"))
await clear()

/* A view can override a shared command; out-of-order cleanup cannot resurrect a disposed handler. */
const definitions = [0, 1, 2].map(n => kit.registerSlash("test.scope", { fields: [], run() {}, purpose: `Scope ${n}` }))
assert.equal(kit.getSlash("/test.scope").purpose, "Scope 2")
definitions[0]()
definitions[2]()
assert.equal(kit.getSlash("test.scope").purpose, "Scope 1")
definitions[1]()
definitions[1]()
assert.equal(kit.getSlash("test.scope"), undefined)

let calls = []
const unregister = kit.registerSlash("test.comment", {
  purpose: "Comment on an issue",
  fields: [{ name: "issue", label: "Issue number", type: "number", min: 1 }, { name: "body", label: "Comment", type: "textarea" }],
  run(values, context) { calls.push({ ...values, as: context.flags.as }) }
})
assert.deepEqual(kit.parseSlash('/test.comment 31 "Keep the router small"').values, { issue: "31", body: "Keep the router small" })
assert.equal(kit.missingSlashFields(kit.getSlash("test.comment"), { issue: "0", body: "x" })[0].name, "issue")
await route("smithers.sh/maya/tinyhttp")
await render(ask("/"))
assert.ok(container.querySelector('[aria-label="Slash commands"]').textContent.includes("Comment on an issue"))
await click(container.querySelector('[title="/test.comment"]'))
assert.equal(container.querySelector("#repo-ask-input").value, "/test.comment ")
await render(ask("/test.comment 31", true))
assert.equal(commandForm().querySelectorAll("input, textarea").length, 1, "only the missing comment is collected")
assert.equal(commandForm().querySelector("label").textContent, "Comment")
commandForm().querySelector("textarea").value = "Keep the router small"
await submit(commandForm())
assert.equal(calls.length, 0, "the form does not start a consequential act")
await click(button("Comment on an issue"))
assert.deepEqual(calls, [{ issue: "31", body: "Keep the router small", as: "in" }])
await clear()

/* Permission is checked again when a confirmation is accepted. */
await render(ask())
await render(ask("/test.comment 31 hello", true))
await render(ask(), flags({ role: "reader" }))
await click(button("Comment on an issue"))
assert.equal(calls.length, 1)
assert.ok(container.textContent.includes("Only members"))
await clear()
await render(ask("/test.comment 31 hello", true), flags({ as: "out" }))
assert.ok(container.textContent.includes("Sign in to continue"))
assert.equal(calls.length, 1)
await clear()
unregister()

/* Unknown commands never pretend to start an unrelated run. */
await render(ask())
await render(ask("/unknown.command", true), flags({ landing: "open" }))
assert.ok(container.textContent.includes("isn't available here"))
assert.equal(container.querySelector(".repo-frame-confirm"), null)
await clear()

/* Rejected async acts keep the actual reason and can be retried, without double execution. */
let attempts = 0
let settle
const removeRetry = kit.registerSlash("test.retry", {
  purpose: "Retry a run", fields: [],
  run() { attempts++; return new Promise((resolve, reject) => { settle = attempts === 1 ? () => reject(new Error("Worker disconnected.")) : resolve }) }
})
await render(ask())
await render(ask("/test.retry", true))
await click(button("Retry a run"))
assert.ok(button("Retry a run").disabled, "named action stays disabled while running")
await click(button("Retry a run"))
assert.equal(attempts, 1)
assert.ok(container.textContent.includes("Running…"))
await act(async () => settle())
assert.ok(container.querySelector('[role="alert"]').textContent.includes("Worker disconnected."))
await click(button("Retry"))
await act(async () => settle())
assert.equal(attempts, 2)
assert.equal(container.querySelector(".repo-frame-confirm"), null)
await clear()
removeRetry()

/* The issue fallback opens the issue's own confirmation instead of an unrelated run. */
await render(ask())
await render(ask("/issue.implement 31", true))
assert.ok(window.location.hash.endsWith("/issues/31?act=implement"))
await clear()

/* Header identity is independent of the repo's people; a zero inbox count has no badge. */
for (const slug of ["smithers-canary/smithers", "effeck/effeck"]) {
  kit.selectRepo(slug)
  await route(`smithers.sh/${slug}`)
  await render(h(kit.RepoFrame, { tab: "code" }, h("p", null, "Files")), flags({ data: "empty" }))
  assert.equal(container.querySelector(".repo-frame-avatar-button .repo-ui-avatar").textContent, "M")
  assert.ok(container.querySelector(".repo-frame-inbox"))
  assert.equal(container.querySelector(".repo-frame-inbox .repo-ui-counter"), null)
  assert.equal(container.querySelector(".repo-frame-inbox").getAttribute("aria-label"), "Waiting on you")
  await clear()
}

/* An unknown repository never inherits the previously selected repository inbox. */
for (const slug of ["maya/tinyhttp", "smithers-canary/smithers", "effeck/effeck", "Effect-TS/effect"]) {
  kit.selectRepo(slug)
  await route(`smithers.sh/${slug}`)
  await render(h(kit.RepoFrame, { tab: "code" }, h("p", null, "Files")))
  assert.ok(container.querySelector(".repo-frame-inbox").getAttribute("href").endsWith(`${slug}/approvals`))
  assert.equal(kit.selectRepo("maya/not-imported"), false)
  await route("smithers.sh/maya/not-imported")
  const unavailableInbox = container.querySelector(".repo-frame-inbox")?.outerHTML ?? null
  const accountAvailable = Boolean(container.querySelector(".repo-frame-avatar-button"))
  await route(`smithers.sh/${slug}`)
  const inboxRestored = Boolean(container.querySelector(".repo-frame-inbox"))
  await clear()
  assert.equal(unavailableInbox, null, `${slug}: no retained inbox on an unavailable repository`)
  assert.ok(accountAvailable, "account controls remain available")
  assert.ok(inboxRestored, "returning to the repository restores its inbox")
}

/* Each Code row links the commit recorded for that entry, even when history omits file details. */
kit.selectRepo("smithers-canary/smithers")
await route("smithers.sh/smithers-canary/smithers")
await render(h(kit.RepoFrame, { tab: "code" }, h(kit.CodeHomeReady)))
const info = kit.fixtureInfo()
const rows = [...container.querySelectorAll(".repo-code-home-file-row")]
for (const entry of info.entries.filter(entry => entry.last)) {
  const row = rows.find(item => item.querySelector('[role="cell"] a').textContent === entry.path)
  assert.ok(row)
  assert.ok(row.querySelector(".repo-code-home-file-message a").getAttribute("href").endsWith(`/commit/${entry.last.sha}`), entry.path)
}
assert.ok(new Set(info.entries.map(entry => entry.last?.sha).filter(Boolean)).size > 1)
/* Code's registered slash and its button open the same file finder, including for guests. */
await click(button("Go to file"))
assert.ok(container.querySelector("#repo-file-finder"))
await click(button("Go to file"))
assert.equal(kit.getSlash("file.find").access, "public")
/* The registered handler runs without depending on a signed-in repository contributor. */
await act(async () => kit.getSlash("file.find").run({ path: "" }, { flags: flags({ as: "out" }), location: "", closeAsk() {} }))
assert.ok(container.querySelector("#repo-file-finder"))
} finally {
await clear()
await window.happyDOM.close()
channels.forEach(channel => { channel.port1.close(); channel.port2.close() })
await rm(bundleDir, { recursive: true, force: true })
}
console.log("Frame regressions passed: sample flags, registry forms/confirm/retry/access/cleanup, identity, inbox, file commits.")
