// Real clipboard permissions and mounted components; no clipboard implementation is replaced.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { MessageChannel as NodeMessageChannel } from "node:worker_threads"

const rootPath = fileURLToPath(new URL("../../../../../", import.meta.url))
const require = createRequire(new URL("../../../../../package.json", import.meta.url))
const { Window } = await import(require.resolve("happy-dom"))
const window = new Window({ url: "https://mock.test/" })
for (const key of ["window", "document", "navigator", "HTMLElement", "Event", "CustomEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : window[key] })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const channels = []
globalThis.MessageChannel = class extends NodeMessageChannel {
  constructor() { super(); channels.push(this) }
}
const directory = await mkdtemp(join(tmpdir(), "site-feedback-"))
const bundle = await require("esbuild").build({
  stdin: {
    contents: `
      export { act, createElement } from "react"
      export { createRoot } from "react-dom/client"
      export { CopyButton, CommandRow } from "./.specs/design/mock/src/sites/front/ui"
      export { Toast, toast } from "./.specs/design/mock/src/sites/repo/ui/Toast"
      export { getSlash } from "./.specs/design/mock/src/sites/repo/frame/slash"
    `, resolveDir: rootPath, loader: "tsx"
  },
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  nodePaths: [join(rootPath, "apps/app/node_modules"), join(rootPath, "node_modules")]
})
const path = join(directory, "feedback.mjs")
await writeFile(path, bundle.outputFiles[0].text)
const kit = await import(pathToFileURL(path).href)
const { act, createElement: h } = kit
const container = document.createElement("div")
document.body.append(container)
let root
const mount = async element => {
  root = kit.createRoot(container)
  await act(async () => root.render(element))
}
const clear = async () => { if (root) await act(async () => root.unmount()); root = undefined }
const click = async element => { await act(async () => element.click()) }
const writePermission = await navigator.permissions.query({ name: "clipboard-write" })
const text = "npm i -g smthrs@next"

test.afterEach(async () => { await clear(); writePermission.state = "granted"; delete navigator.clipboard })
test.after(async () => {
  await window.happyDOM.close()
  channels.forEach(channel => { channel.port1.close(); channel.port2.close() })
  await rm(directory, { recursive: true, force: true })
})

test("Copy acknowledges only a completed clipboard write and resets its label", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await mount(h(kit.CommandRow, { command: text }))
  const button = container.querySelector("button")
  act(() => button.click())
  assert.notEqual(button.textContent, "Copied", "no success before the write resolves")
  await act(async () => {})
  assert.equal(await navigator.clipboard.readText(), text)
  assert.equal(button.textContent, "Copied")
  act(() => t.mock.timers.tick(1500))
  assert.equal(button.textContent, "Copy")
})

test("denied clipboard writes stay retryable and never acknowledge success", async () => {
  await navigator.clipboard.writeText("unchanged")
  writePermission.state = "denied"
  await mount(h(kit.CopyButton, { text, label: "Share link", copiedLabel: "Link copied" }))
  const button = container.querySelector("button")
  await click(button)
  assert.equal(button.textContent, "Copy failed. Retry")
  assert.equal(button.disabled, false)
  assert.equal(await navigator.clipboard.readText(), "unchanged")
  writePermission.state = "granted"
  await click(button)
  assert.equal(button.textContent, "Link copied")
  assert.equal(await navigator.clipboard.readText(), text)
})

test("overlapping clicks cannot race a failed write against a later success", async () => {
  await navigator.clipboard.writeText("unchanged")
  writePermission.state = "denied"
  await mount(h(kit.CopyButton, { text }))
  const button = container.querySelector("button")
  await act(async () => {
    button.click()
    await Promise.resolve()
    writePermission.state = "granted"
    button.click()
  })
  assert.equal(await navigator.clipboard.readText(), "unchanged", "the second click cannot start another write while the first settles")
  assert.equal(button.textContent, "Copy failed. Retry")
  await click(button)
  assert.equal(button.textContent, "Copied")
  assert.equal(await navigator.clipboard.readText(), text)
})

test("an absent clipboard reports failure and can recover", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
  await mount(h(kit.CopyButton, { text }))
  const button = container.querySelector("button")
  await click(button)
  assert.equal(button.textContent, "Copy failed. Retry")
  delete navigator.clipboard
  await click(button)
  assert.equal(await navigator.clipboard.readText(), text)
  assert.equal(button.textContent, "Copied")
})

test("a failed later write clears a previous success", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await mount(h(kit.CopyButton, { text, initialCopied: true }))
  const button = container.querySelector("button")
  writePermission.state = "denied"
  await click(button)
  assert.equal(button.textContent, "Copy failed. Retry")
  act(() => t.mock.timers.tick(1500))
  assert.equal(button.textContent, "Copy failed. Retry", "old success timer cannot clear a failure")
})

test("toast bursts retain only the latest three; dismiss and expiry still work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await mount(h(kit.Toast))
  const messages = () => [...container.querySelectorAll(".repo-ui-toast span")].map(item => item.textContent)
  for (let i = 1; i <= 20; i++) {
    act(() => kit.toast(String(i)))
    assert.deepEqual(messages(), Array.from({ length: Math.min(i, 3) }, (_, j) => String(Math.max(1, i - 2) + j)))
  }
  await click(container.querySelector(".repo-ui-toast button"))
  assert.deepEqual(messages(), ["19", "20"])
  act(() => kit.getSlash("notice.dismiss").run({}))
  assert.deepEqual(messages(), ["19"])
  act(() => t.mock.timers.tick(6000))
  assert.deepEqual(messages(), [])
})

test("an evicted toast's timer cannot remove a newer notification", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await mount(h(kit.Toast))
  act(() => { kit.toast("old"); t.mock.timers.tick(1000); kit.toast("one"); kit.toast("two"); kit.toast("three") })
  act(() => t.mock.timers.tick(5000))
  assert.deepEqual([...container.querySelectorAll(".repo-ui-toast span")].map(item => item.textContent), ["one", "two", "three"])
  act(() => t.mock.timers.tick(1000))
  assert.equal(container.querySelectorAll(".repo-ui-toast").length, 0)
})
