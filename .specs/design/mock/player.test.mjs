/* node --test .specs/design/mock/player.test.mjs
 * Real React, cards and DOM; the two browser audits run against rendered buttons.
 */
import assert from "node:assert/strict"
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"
import { MessageChannel } from "node:worker_threads"
import { after, test } from "node:test"
import { build, transform } from "esbuild"
import vibelang from "vibelang-unplugin/esbuild"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "../../..")
const requireUi = createRequire(join(repo, "packages/smithers/ui/package.json"))
const { Window } = await import(requireUi.resolve("happy-dom"))
const window = new Window({ url: "https://mock.test/?j=j1" })
for (const key of ["document", "navigator", "location", "history", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "ResizeObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "addEventListener", "removeEventListener", "matchMedia"]) {
  const value = window[key]
  Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === "function" && /^[a-z]/.test(key) ? value.bind(window) : value })
}
globalThis.window = window
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const channels = []
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this) }
}

const directory = await mkdtemp(join(tmpdir(), "mock-player-"))
const bundle = await build({
  stdin: {
    contents: `
      export { createElement as h, act } from "react"
      export { createRoot } from "react-dom/client"
      export { renderToStaticMarkup } from "react-dom/server"
      export { Player } from "./src/Player"
      export { DraftCard } from "./src/cards/Draft"
      export { FrameContext } from "./src/frame"
      export { markOf } from "./src/Rail"
      export { stateBefore } from "./src/journey"
      export { j8 } from "./src/journeys/j8"
    `, resolveDir: here, loader: "tsx"
  },
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  nodePaths: [join(repo, "node_modules"), join(repo, "packages/smithers/ui/node_modules"), ...(process.env.NODE_PATH?.split(":") ?? [])],
  alias: { "@smthrs/ui": join(repo, "packages/smithers/ui/src/index.ts") },
  plugins: [vibelang({ root: here })],
  loader: { ".css": "empty" }
})
const filename = join(directory, "player.mjs")
await writeFile(filename, bundle.outputFiles[0].text)
const { h, act, createRoot, renderToStaticMarkup, Player, DraftCard, FrameContext, markOf, stateBefore, j8 } = await import(pathToFileURL(filename).href)
after(async () => {
  await window.happyDOM.abort()
  window.close()
  for (const channel of channels) { channel.port1.close(); channel.port2.close() }
  await rm(directory, { recursive: true, force: true })
})

const mount = async element => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(element))
  return { container, close: async () => { await act(async () => root.unmount()); container.remove() } }
}
const click = async (container, label) => {
  const button = container.querySelector(`button[aria-label="${label}"]`)
  assert.ok(button, label)
  await act(async () => button.click())
}
const count = container => Number(container.querySelector(".mock-count").textContent.split("/")[0])
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test("Restart during playback advances immediately and repeated restarts keep playing", async () => {
  const view = await mount(h(Player))
  try {
    assert.equal(count(view.container), 1)
    for (let n = 0; n < 3; n++) {
      await click(view.container, "Restart")
      assert.ok(view.container.querySelector('button[aria-label="Pause"]'))
      assert.equal(count(view.container), 1, "a new loop applies the first step after every restart")
    }
    await click(view.container, "Pause")
    const stopped = count(view.container)
    await act(async () => { await wait(2850) })
    assert.equal(count(view.container), stopped, "cancelled loops cannot advance a paused player")
  } finally { await view.close() }
})

test("Restart from paused or completed playback starts a new loop; scrubbing stays paused", async () => {
  const view = await mount(h(Player))
  try {
    await click(view.container, "Pause")
    await click(view.container, "Restart")
    assert.equal(count(view.container), 1)
    await click(view.container, "Next step")
    assert.equal(count(view.container), 2)
    assert.ok(view.container.querySelector('button[aria-label="Play"]'))
    const ticks = view.container.querySelectorAll(".mock-ticks button")
    await click(view.container, `Step ${ticks.length}`)
    assert.equal(count(view.container), ticks.length)
    await click(view.container, "Restart")
    assert.equal(count(view.container), 1)
    assert.ok(view.container.querySelector('button[aria-label="Pause"]'))
  } finally { await view.close() }
})

const draftEntry = state => state.viewers.alice.transcript.find(entry => entry.kind === "card" && entry.card.kind === "draft")
const cardMarkup = (state, me, entry) => renderToStaticMarkup(h(FrameContext.Provider, { value: { state, me, typed: {} } }, h(DraftCard, { id: entry.id, target: entry.card.target })))

test("draft timeline and card are private to their author until the shared commit receipt", () => {
  const state = stateBefore(j8, 0)
  const entry = draftEntry(state)
  assert.ok(entry)
  const draft = state.world.drafts.find(draft => draft.id === entry.card.target)
  assert.ok(draft)
  assert.equal(markOf(state, "alice", entry).title, draft.title)
  assert.ok(cardMarkup(state, "alice", entry).includes(draft.title))
  assert.equal(cardMarkup(state, "maya", entry), "")
  assert.equal(markOf(state, "maya", entry), undefined)
  const committed = stateBefore(j8, 2)
  for (const me of ["alice", "maya"]) {
    const mark = markOf(committed, me, entry)
    assert.equal(mark.title, draft.title)
    assert.equal(mark.summary, "Committed")
    assert.match(cardMarkup(committed, me, entry), /Committed as/)
    assert.ok(cardMarkup(committed, me, entry).includes(draft.title))
  }
})

test("legacy drafts without an author retain their shared visibility", () => {
  const state = stateBefore(j8, 0)
  const entry = draftEntry(state)
  const draft = state.world.drafts.find(draft => draft.id === entry.card.target)
  delete draft.by
  for (const me of ["alice", "maya"]) {
    assert.equal(markOf(state, me, entry).title, draft.title)
    assert.ok(cardMarkup(state, me, entry).includes(draft.title))
  }
})

const browserSource = await readFile(join(here, "evals/mock-fidelity/browser.ts"), "utf8")
const browserAudit = browserSource.slice(browserSource.indexOf("export const auditPage ="), browserSource.indexOf("/** Serializable DOM evidence"))
const compiledAudit = (await transform(browserAudit.replace("export const", "const"), { loader: "ts" })).code
const crawlSource = await readFile(join(here, "crawl.mjs"), "utf8")
const crawlAudit = crawlSource.slice(crawlSource.indexOf("const audit = () => {"), crawlSource.indexOf("const browser ="))
for (const [name, source, fn] of [["fidelity", compiledAudit, "auditPage"], ["crawl", crawlAudit, "audit"]]) {
  test(`${name}: real DOM orphan buttons fail; form submitters, handlers, disabled and inert buttons pass`, async () => {
    const view = await mount(h("div", null,
      h("button", null, "Dead action"),
      h("button", { type: "submit" }, "Orphan submit"),
      h("button", { type: "button" }, "Explicit dead action"),
      h("form", { id: "test-form", onSubmit: event => event.preventDefault() }, h("button", null, "Submit")),
      h("button", { form: "test-form" }, "External submit"),
      h("button", { form: "missing-form" }, "Missing form"),
      h("button", { onClick() {} }, "Handled"),
      h("button", { disabled: true }, "Disabled"),
      h("button", { "data-inert": "preview" }, "Inert")
    ))
    try {
      const orphan = view.container.querySelector("button")
      assert.equal(orphan.type, "submit")
      assert.equal(orphan.form, null)
      assert.ok(Object.keys(orphan).some(key => key.startsWith("__reactProps")))
      const problems = Array.from(runInNewContext(`${source}; ${fn}()`, { window, document, __name: target => target }))
      assert.deepEqual(problems, [
        'button "Dead action" does nothing',
        'button "Orphan submit" does nothing',
        'button "Explicit dead action" does nothing',
        'button "Missing form" does nothing'
      ])
    } finally { await view.close() }
  })
}
