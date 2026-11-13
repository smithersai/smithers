// Mounted legacy mock components, the real issue store, and real clipboard permissions.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { after, afterEach, test } from "node:test"
import { MessageChannel } from "node:worker_threads"

const rootPath = fileURLToPath(new URL("../../../../../", import.meta.url))
const require = createRequire(new URL("../../../../../package.json", import.meta.url))
const requireUi = createRequire(new URL("../../../../../packages/smithers/ui/package.json", import.meta.url))
const { Window } = await import(requireUi.resolve("happy-dom"))
const window = new Window({ url: "https://mock.test/?still=1" })
for (const key of ["window", "document", "navigator", "HTMLElement", "Event", "CustomEvent", "FormData", "sessionStorage", "localStorage", "history"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : window[key] })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const channels = []
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this) }
}
const directory = await mkdtemp(join(tmpdir(), "mock-reporting-"))
const vibelang = (await import("vibelang-unplugin/esbuild")).default
const bundle = await require("esbuild").build({
  stdin: {
    contents: `
      export { act, createElement } from "react"
      export { createRoot } from "react-dom/client"
      export { BugCard } from "./.specs/design/mock/src/sites/app/cards"
      export { CopyButton, useCopied } from "./.specs/design/mock/src/sites/app/lib"
      export { MockProvider, DEFAULTS } from "./.specs/design/mock/src/sites/core/mock"
      export { useLocation, navigate, setRoutes, resolveRoute, matchPattern } from "./.specs/design/mock/src/sites/core/router"
      export { routes as codeRoutes } from "./.specs/design/mock/src/sites/repo/views/code/routes"
      export { Packages, PackageHome } from "./.specs/design/mock/src/sites/effect/scope/Packages"
      export { issuesFor } from "./.specs/design/mock/src/sites/effect/work/filters"
      export { allIssues, setIssueClosed, createIssue } from "./.specs/design/mock/src/sites/repo/views/issues/model"
      export * as fixtures from "./.specs/design/mock/src/sites/repo/fixtures"
    `, resolveDir: rootPath, loader: "tsx"
  },
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  nodePaths: [join(rootPath, "node_modules"), join(rootPath, "packages/smithers/ui/node_modules")],
  alias: { "@smthrs/ui": join(rootPath, "packages/smithers/ui/src/index.ts") },
  plugins: [vibelang({ root: rootPath })], loader: { ".css": "empty" }
})
const path = join(directory, "reporting.mjs")
await writeFile(path, bundle.outputFiles[0].text)
const kit = await import(pathToFileURL(path).href)
const { act, createElement: h } = kit
const views = []
const mount = async element => {
  sessionStorage.setItem("site-mock-flags", JSON.stringify({ ...kit.DEFAULTS, as: "in", role: "member", landing: "open" }))
  sessionStorage.setItem("repo-ask-open", "false")
  const container = document.createElement("div")
  document.body.append(container)
  const root = kit.createRoot(container)
  const close = async () => { await act(async () => root.unmount()); container.remove() }
  views.push(close)
  await act(async () => root.render(h(kit.MockProvider, null, element)))
  return container
}
const route = async value => {
  await act(async () => kit.navigate(value, { replace: true }))
}
const click = async button => { assert.ok(button); await act(async () => button.click()) }
const permission = await navigator.permissions.query({ name: "clipboard-write" })
const clipboardText = "const encoded = '%20 %2F'"

afterEach(async () => {
  while (views.length) await views.pop()()
  sessionStorage.clear()
  permission.state = "granted"
  delete navigator.clipboard
})
after(async () => {
  await window.happyDOM.close()
  channels.forEach(channel => { channel.port1.close(); channel.port2.close() })
  await rm(directory, { recursive: true, force: true })
})

const conversionRepo = { slug: "effeck/effeck", github: "https://github.com/effeck/effeck" }
const input = "PRIVATE_INPUT"
const output = "PRIVATE_OUTPUT"
const attachments = [
  ["Input · Users example", input],
  ["Output · Users example", output],
  ["2 diagnostics", "EK1004"]
]
const conversionRoute = (extra = "", inputText = input, outputText = output) => `smithers.sh/effeck/effeck/bug?from=conversion&input=${encodeURIComponent(inputText)}&output=${encodeURIComponent(outputText)}${extra}`
const bodyOf = container => container.querySelector(".app-bug-public-body").textContent

for (let removed = 0; removed < 8; removed++) {
  test(`conversion report omits removed attachments from details, preview and GitHub body (mask ${removed})`, async () => {
    await route(conversionRoute())
    const container = await mount(h(kit.BugCard, { repo: conversionRepo, from: "conversion", onClose() {} }))
    for (const [label, marker] of attachments) {
      assert.ok(bodyOf(container).includes(marker), marker)
      assert.ok([...container.querySelectorAll("summary")].some(item => item.textContent === label))
    }
    for (let i = 0; i < attachments.length; i++) {
      if (removed & (1 << i)) await click(container.querySelector(`button[aria-label="Remove ${attachments[i][0]}"]`))
    }
    const github = container.querySelector('a[href^="https://github.com/effeck/effeck/issues/new?"]')
    const githubBody = new URL(github.href).searchParams.get("body")
    assert.equal(githubBody, bodyOf(container))
    for (let i = 0; i < attachments.length; i++) {
      const [label, marker] = attachments[i]
      const included = !(removed & (1 << i))
      assert.equal(bodyOf(container).includes(marker), included, `${label}: preview and outbound body`)
      assert.equal([...container.querySelectorAll("summary")].some(item => item.textContent === label), included, `${label}: details`)
    }
  })
}

test("removed attachments stay excluded after restoring the draft and publishing in the app", async () => {
  await route(conversionRoute("&bugpublish=app"))
  const props = { repo: conversionRepo, from: "conversion", onClose() {} }
  const container = await mount(h(kit.BugCard, props))
  for (const [label] of attachments) await click(container.querySelector(`button[aria-label="Remove ${label}"]`))
  await views.pop()()
  let published
  const restored = await mount(h(kit.BugCard, { ...props, onPublish: (title, body) => { published = { title, body }; return 119 } }))
  await click([...restored.querySelectorAll("button")].find(button => button.textContent === "Publish"))
  assert.equal(published.title, "Conversion did not compile")
  assert.equal(published.body, bodyOf(restored))
  for (const [, marker] of attachments) assert.equal(published.body.includes(marker), false)
})

test("ordinary bug drafts do not attach conversion query contents", async () => {
  await route("smithers.sh/effeck/effeck/bug?title=Draft&body=Description&input=not-attached&output=not-attached")
  const container = await mount(h(kit.BugCard, { repo: conversionRepo, from: null, onClose() {} }))
  assert.ok(bodyOf(container).startsWith("Description"))
  assert.equal(bodyOf(container).includes("not-attached"), false)
  for (const [label] of attachments) assert.equal([...container.querySelectorAll("summary")].some(item => item.textContent === label), false)
})

const HookCopy = () => {
  const { copied, failed, copy } = kit.useCopied()
  return h("button", { onClick: () => copy(clipboardText) }, failed ? "Copy failed. Retry" : copied ? "Copied" : "Copy")
}
for (const [name, component] of [
  ["CopyButton", () => h(kit.CopyButton, { text: clipboardText })],
  ["useCopied", () => h(HookCopy)]
]) {
  test(`${name} acknowledges a completed write and resets after 1.5 seconds`, async () => {
    const container = await mount(component())
    const button = container.querySelector("button")
    act(() => button.click())
    assert.equal(button.textContent.trim(), "Copy")
    await act(async () => {})
    assert.equal(await navigator.clipboard.readText(), clipboardText)
    assert.equal(button.textContent.trim(), "Copied")
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1550)) })
    assert.equal(button.textContent.trim(), "Copy")
  })

  test(`${name} handles denied writes, missing APIs and a retry without false success`, async () => {
    await navigator.clipboard.writeText("unchanged")
    const container = await mount(component())
    const button = container.querySelector("button")
    permission.state = "denied"
    await click(button)
    assert.equal(button.textContent.trim(), "Copy failed. Retry")
    assert.equal(await navigator.clipboard.readText(), "unchanged")
    permission.state = "granted"
    await click(button)
    assert.equal(button.textContent.trim(), "Copied")
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
    await click(button)
    assert.equal(button.textContent.trim(), "Copy failed. Retry")
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1550)) })
    assert.equal(button.textContent.trim(), "Copy failed. Retry", "a prior success timer cannot clear a failure")
    delete navigator.clipboard
    await click(button)
    assert.equal(button.textContent.trim(), "Copied")
  })

  test(`${name} ignores overlapping writes while permission denial settles`, async () => {
    await navigator.clipboard.writeText("unchanged")
    permission.state = "denied"
    const container = await mount(component())
    const button = container.querySelector("button")
    await act(async () => {
      button.click()
      await Promise.resolve()
      permission.state = "granted"
      button.click()
    })
    assert.equal(await navigator.clipboard.readText(), "unchanged")
    assert.equal(button.textContent.trim(), "Copy failed. Retry")
    await click(button)
    assert.equal(button.textContent.trim(), "Copied")
  })
}

test("hash queries and route parameters decode once and preserve conversion and draft evidence", async () => {
  const Probe = () => {
    const location = kit.useLocation()
    const resolved = kit.resolveRoute(location)
    return h("output", null, JSON.stringify({
      input: resolved.context.query.get("input"),
      output: resolved.context.query.get("output"),
      title: resolved.context.query.get("title"),
      body: resolved.context.query.get("body"),
      params: resolved.context.params
    }))
  }
  kit.setRoutes([{ pattern: "smithers.sh/:owner/:repo/blob/:ref/*", name: "Blob", render() {}, screens: [] }])
  await route("smithers.sh/owner/repo/blob/main/file.ts")
  const container = await mount(h(Probe))
  const samples = ["const encoded = '%20 %2F'", "%2520 %252F", "100% + ? & # /", "café 日本語\nnext line"]
  for (const sample of samples) {
    const query = new URLSearchParams({ input: sample, output: sample, title: sample, body: sample })
    const routePath = `smithers.sh/owner/repo/blob/${encodeURIComponent("feature/%20")}/${encodeURIComponent("file %2F.ts")}`
    await route(`${routePath}?${query}`)
    assert.deepEqual(JSON.parse(container.textContent), {
      input: sample, output: sample, title: sample, body: sample,
      params: { owner: "owner", repo: "repo", ref: "feature/%20", "*": "file %2F.ts" }
    })
  }
  assert.deepEqual(kit.matchPattern("smithers.sh/a b/:name", "smithers.sh/a%20b/value%2520"), { name: "value%20" })
})

test("tree, file and blame renderers receive paths and revisions decoded once", async () => {
  kit.setRoutes(kit.codeRoutes)
  const Probe = () => {
    const resolved = kit.resolveRoute(kit.useLocation())
    return h("output", null, JSON.stringify(resolved.route.render(resolved.context).props))
  }
  const revision = "feature/%20"
  const path = "src/file%20 %2F.ts"
  for (const kind of ["tree", "blob", "blame"]) {
    await route(`smithers.sh/maya/tinyhttp/${kind}/${encodeURIComponent(revision)}/${path.split("/").map(encodeURIComponent).join("/")}`)
    const container = await mount(h(Probe))
    assert.deepEqual(JSON.parse(container.textContent), { path, revision })
    await views.pop()()
  }
})

test("conversion evidence round-trips through the hash into the actual public report", async () => {
  await route(conversionRoute("", clipboardText, clipboardText))
  const container = await mount(h(kit.BugCard, { repo: conversionRepo, from: "conversion", onClose() {} }))
  const body = bodyOf(container)
  assert.equal(body.split(clipboardText).length - 1, 2, "both input and output retain literal percent escapes")
  assert.equal(new URL(container.querySelector('a[href^="https://github.com/effeck/effeck/issues/new?"]').href).searchParams.get("body"), body)
})

test("package index and sidebar subscribe to closing, reopening and creating scoped issues", async () => {
  kit.fixtures.selectRepo("Effect-TS/effect")
  await route("smithers.sh/Effect-TS/effect/packages/sql-pg")
  const pkg = kit.fixtures.repo.config.packages.find(item => item.slug === "sql-pg")
  const container = await mount(h("div", null, h(kit.Packages), h(kit.PackageHome, { slug: "sql-pg" })))
  const counts = () => {
    const expected = kit.issuesFor(pkg, kit.allIssues()).filter(item => item.state === "open").length
    const row = [...container.querySelectorAll(".effect-package-row")].find(row => row.querySelector(".effect-package-name").textContent === pkg.name)
    assert.ok(row)
    const index = Number(row.querySelector(".effect-package-counts a").textContent.trim().split(" ")[0])
    const sidebar = Number([...container.querySelectorAll(".effect-package-sidebar section")].find(section => section.querySelector("h3").textContent === "Open work").querySelector("a").textContent.split(" ")[0])
    assert.equal(index, expected, "index matches package-scoped issue discovery")
    assert.equal(sidebar, expected, "sidebar matches package-scoped issue discovery")
    return expected
  }
  const initial = counts()
  const issue = kit.allIssues().find(item => item.n === 42)
  assert.equal(issue.state, "open")
  await act(async () => kit.setIssueClosed(issue, true))
  assert.equal(counts(), initial - 1)
  await act(async () => kit.setIssueClosed(kit.allIssues().find(item => item.n === 42), false))
  assert.equal(counts(), initial)
  let created
  await act(async () => { created = kit.createIssue("Unassociated package issue", "Visible in package discovery", [], []) })
  assert.equal(counts(), initial + 1, "new issues without associations remain visible in scoped discovery")
  await act(async () => kit.setIssueClosed(created, true))
  assert.equal(counts(), initial)
})
