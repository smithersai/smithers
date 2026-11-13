#!/usr/bin/env node
// Builds the maintainer site: the e2e flow GIFs and an Obsidian-like knowledge base of the repository's docs.
//
//   node apps/maintainer-site/build.mjs
//
// Writes ~/Desktop/smithers-maintainer/ (MAINTAINER_SITE_OUT) from the GIFs in ~/Desktop/smithers-mvp/gifs
// (MAINTAINER_SITE_GIFS) and prints the path to index.html. No dependencies.
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, posix, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { escapeHtml, renderMarkdown, safeUrl, slugify, splitFrontmatter } from "./markdown.mjs"

const check = process.argv[2] === "--check"
const requested = new Set(check ? process.argv.slice(3) : [])
const started = performance.now()
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "../..")
const out = resolve(process.env.MAINTAINER_SITE_OUT ?? join(homedir(), "Desktop/smithers-maintainer"))
const gifSource = resolve(process.env.MAINTAINER_SITE_GIFS ?? join(homedir(), "Desktop/smithers-mvp/gifs"))
const specDir = join(repo, "apps/mvp/e2e")

const toPosix = (path) => path.split(sep).join("/")
const markdownUnder = (dir) =>
  existsSync(join(repo, dir))
    ? readdirSync(join(repo, dir), { recursive: true })
        .map(String)
        .filter((file) => file.endsWith(".md") && !file.split(sep).includes("node_modules"))
        .map((file) => toPosix(join(dir, file)))
    : []
const sources = [...markdownUnder("apps/mvp/docs"), "apps/mvp/AGENTS.md", "AGENTS.md", "docs/libraries.md", "README.md"]
  .filter((path) => existsSync(join(repo, path)))
  .sort()
if (check) {
  for (const path of requested) {
    if (!sources.includes(path)) throw new Error(`Not a site note: ${path}`)
  }
}
const selected = sources.filter((path) => !check || requested.size === 0 || requested.has(path))
const warnings = []
const validationErrors = []
const invalid = (message) => {
  warnings.push(message)
  validationErrors.push(message)
}

// ---------------------------------------------------------------------------------------------------------
// Notes: render once to learn titles, then again with every link resolved.

const raw = new Map(sources.map((path) => [path, readFileSync(join(repo, path), "utf8")]))
// Front matter (`---` key: value lines) becomes the note's properties; the Markdown after it is the body.
const front = new Map(sources.map((path) => [path, splitFrontmatter(raw.get(path))]))
for (const path of selected) for (const error of front.get(path).errors) invalid(`front matter in ${path}: ${error}`)
const bodyOf = (path) => front.get(path).body
const dataOf = (path) => front.get(path).data
const text = (value) => (Array.isArray(value) ? value.join(", ") : typeof value === "string" && value !== "" ? value : null)
const titleOf = (path, title) => title ?? text(dataOf(path)?.title) ?? basename(path, ".md")
const titles = new Map(sources.map((path) => [path, titleOf(path, renderMarkdown(bodyOf(path)).title)]))

// `[[name]]` matches a note's path, title or file name, in that order; the shortest path wins a tie.
const wikiIndex = new Map()
for (const [rank, keyOf] of [(path) => path, (path) => path.replace(/\.md$/, ""), (path) => titles.get(path), (path) => basename(path), (path) => basename(path, ".md")].entries())
  for (const path of sources) {
    const key = keyOf(path).toLowerCase()
    const seen = wikiIndex.get(key)
    if (!seen || rank < seen.rank || (rank === seen.rank && path.length < seen.path.length)) wikiIndex.set(key, { path, rank })
  }

const noteHref = (path, anchor = "") => `#/${encodeURI(path)}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`
const copiedFiles = new Map()

const resolverFor = (from) => {
  const fromDir = posix.dirname(from)
  const local = (href) => {
    const hash = href.indexOf("#")
    const pathPart = hash < 0 ? href : href.slice(0, hash)
    const anchor = hash < 0 ? "" : href.slice(hash + 1)
    let decoded = pathPart
    try {
      decoded = decodeURIComponent(pathPart)
    } catch {}
    const target = decoded.startsWith("/") ? posix.normalize(decoded.slice(1)) : posix.normalize(posix.join(fromDir, decoded))
    return { target: target.replace(/\/$/, ""), anchor }
  }
  return {
    link(href) {
      if (href.startsWith("#")) return { href: noteHref(from, href.slice(1)) }
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) {
        const safe = safeUrl(href)
        if (!safe) invalid(`unsafe link in ${from}: ${href}`)
        return safe ? { href: safe, cls: "ext", title: null } : { href: null, cls: "broken", title: "Unsafe link" }
      }
      const { target, anchor } = local(href)
      const note = raw.has(target) ? target : raw.has(`${target}/README.md`) ? `${target}/README.md` : null
      if (note) return { href: noteHref(note, anchor), note, anchor }
      const file = join(repo, target)
      if (!target.startsWith("..") && existsSync(file)) return { href: pathToFileURL(file).href, cls: "file", title: target }
      invalid(`broken link in ${from}: ${href}`)
      return { href: null, cls: "broken", title: `Missing: ${target}` }
    },
    image(src) {
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) return { href: safeUrl(src) }
      const { target } = local(src)
      if (target.startsWith("..") || !existsSync(join(repo, target)) || !statSync(join(repo, target)).isFile()) {
        invalid(`missing image in ${from}: ${src}`)
        return null
      }
      copiedFiles.set(target, join(repo, target))
      return { href: `files/${encodeURI(target)}` }
    },
    wikilink(name) {
      const hash = name.indexOf("#")
      const key = (hash < 0 ? name : name.slice(0, hash)).trim().toLowerCase()
      const anchor = hash < 0 ? "" : name.slice(hash + 1).trim()
      const hit = key === "" ? { path: from } : wikiIndex.get(key) ?? wikiIndex.get(`${key}.md`)
      if (!hit) {
        invalid(`unresolved wikilink in ${from}: [[${name}]]`)
        return null
      }
      return { href: noteHref(hit.path, anchor), note: hit.path, anchor, label: titles.get(hit.path) }
    },
  }
}

// Work notes: apps/mvp/docs/work/*.md, one workstream each, placed on the board by their front matter.
const WORK_DIR = "apps/mvp/docs/work/"
const STATUSES = ["idea", "todo", "designing", "in-progress", "blocked", "done"]
const AREAS = ["app", "sdk", "infra", "design", "process"]
const validStatus = (data) => typeof data?.status === "string" && STATUSES.includes(data.status)
const statusLabel = (status) => ({ todo: "To do", "in-progress": "In progress" })[status] ?? status.charAt(0).toUpperCase() + status.slice(1)
const isWork = (path) => path.startsWith(WORK_DIR) && !path.slice(WORK_DIR.length).includes("/")

// Reject unsupported values before publishing a board with misleading columns or counts.
// Notes without a status retain the existing warning below.
for (const [path, { data }] of front) {
  if (!check && isWork(path) && data && "status" in data && !validStatus(data)) {
    throw new Error(`work note ${path}: status ${JSON.stringify(data.status)} is not one of ${STATUSES.join(", ")}`)
  }
}

// The properties table a note's front matter renders as, and the notes its `links` point to.
const PROPERTY_ORDER = ["status", "area", "owner", "updated", "links"]
function properties(data, resolver) {
  const links = []
  const keys = [...PROPERTY_ORDER.filter((key) => key in data), ...Object.keys(data).filter((key) => key !== "title" && !PROPERTY_ORDER.includes(key))]
  const linkHtml = (target) => {
    const resolved = resolver.link(target)
    if (resolved.note) {
      const label = titles.get(resolved.note)
      links.push({ note: resolved.note, anchor: resolved.anchor ?? "", label })
      return `<a href="${escapeHtml(resolved.href)}">${escapeHtml(label)}</a>`
    }
    const attrs = `${resolved.cls ? ` class="${resolved.cls}"` : ""}${resolved.title ? ` title="${escapeHtml(resolved.title)}"` : ""}`
    return resolved.href ? `<a href="${escapeHtml(resolved.href)}"${attrs}>${escapeHtml(target)}</a>` : `<a${attrs}>${escapeHtml(target)}</a>`
  }
  const rows = keys.map((key) => {
    const value = data[key]
    let html = ""
    if (key === "status" && text(value)) html = `<span class="pill st-${escapeHtml(slugify(text(value)))}">${escapeHtml(statusLabel(text(value)))}</span>`
    else if (key === "links") html = (Array.isArray(value) ? value : [value]).filter(Boolean).map(linkHtml).join("")
    else html = escapeHtml(text(value) ?? "")
    const name = key.charAt(0).toUpperCase() + key.slice(1).replace(/[-_]/g, " ")
    return `<div class="prop prop-${escapeHtml(slugify(key))}"><dt>${escapeHtml(name)}</dt><dd>${html || '<span class="muted">None</span>'}</dd></div>`
  })
  const context = `Links: ${links.map((link) => link.label).join(", ")}`
  return { html: `<dl class="props">${rows.join("")}</dl>`, links: links.map((link) => ({ ...link, context })) }
}

const notes = selected.map((path) => {
  const resolver = resolverFor(path)
  const rendered = renderMarkdown(bodyOf(path), resolver)
  const data = dataOf(path)
  if (data) {
    const props = properties(data, resolver)
    // A note whose body has no H1 takes its title from the front matter.
    rendered.html = rendered.title
      ? rendered.html.replace("</h1>", `</h1>\n${props.html}`)
      : `<h1 id="${escapeHtml(slugify(titles.get(path)) || "title")}">${escapeHtml(titles.get(path))}</h1>\n${props.html}\n${rendered.html}`
    rendered.links.push(...props.links)
  }
  return { path, title: titles.get(path), rendered }
})

const work = notes
  .filter((note) => isWork(note.path))
  .map((note) => {
    const data = dataOf(note.path)
    if (!data) invalid(`work note without front matter: ${note.path}`)
    const status = text(data?.status)
    const area = text(data?.area)
    if (!validStatus(data)) invalid(`work note ${note.path}: status ${status ?? "(none)"} is not one of ${STATUSES.join(", ")}`)
    if (!AREAS.includes(area)) warnings.push(`work note ${note.path}: area ${area ?? "(none)"} is not one of ${AREAS.join(", ")}`)
    return { path: note.path, title: note.title, status: status ?? "unknown", area: area ?? "unknown", owner: text(data?.owner), updated: text(data?.updated) }
  })
  .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.title.localeCompare(b.title))
// Validate the same metadata and destinations the board renders, without writing the site.
if (check) {
  for (const error of validationErrors) console.error(error)
  console.log(`Checked ${notes.length} notes: ${validationErrors.length} errors`)
  process.exit(validationErrors.length ? 1 : 0)
}

const workStatuses = [...STATUSES, ...new Set(work.map((item) => item.status).filter((status) => !STATUSES.includes(status)))].map((id) => ({ id, label: statusLabel(id) }))
const workAreas = [...AREAS, ...new Set(work.map((item) => item.area).filter((area) => !AREAS.includes(area)))].filter((area) => work.some((item) => item.area === area))
const openWork = work.filter((item) => item.status !== "done").length

// Backlinks and graph edges: one per (from, to) pair; a note's links to itself are anchors, not edges.
const edges = new Map()
const backlinks = new Map(sources.map((path) => [path, []]))
for (const note of notes) {
  for (const link of note.rendered.links) {
    if (link.note === note.path) continue
    const key = `${note.path}\n${link.note}`
    const context = trimContext(link.context, link.label)
    if (!edges.has(key)) edges.set(key, [note.path, link.note])
    const list = backlinks.get(link.note)
    const existing = list.find((entry) => entry.from === note.path)
    if (existing) {
      if (existing.contexts.length < 3 && !existing.contexts.includes(context)) existing.contexts.push(context)
    } else list.push({ from: note.path, contexts: [context] })
  }
}

// About 220 characters of the block around the link, with the link's text in bold.
function trimContext(context, label) {
  const at = label ? context.indexOf(label) : -1
  let start = 0
  let end = context.length
  if (context.length > 220) {
    const center = at < 0 ? 0 : at + label.length / 2
    start = Math.max(0, Math.round(center - 110))
    end = Math.min(context.length, start + 220)
    start = Math.max(0, end - 220)
    // Cut at spaces, never inside a word or the link's text.
    const first = at < 0 ? end : at
    const last = at < 0 ? start : at + label.length
    const space = context.indexOf(" ", start)
    if (start > 0 && space >= 0 && space < first) start = space + 1
    const back = context.lastIndexOf(" ", end)
    if (end < context.length && back > last) end = back
  }
  const slice = context.slice(start, end)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < context.length ? "…" : ""
  const local = at < 0 ? -1 : at - start
  if (local < 0 || local + label.length > slice.length) return prefix + escapeHtml(slice) + suffix
  return `${prefix}${escapeHtml(slice.slice(0, local))}<strong>${escapeHtml(label)}</strong>${escapeHtml(slice.slice(local + label.length))}${suffix}`
}

// ---------------------------------------------------------------------------------------------------------
// The sidebar tree mirrors the source folders; a folder with one folder inside folds into it ("apps/mvp").

const tree = { name: "", dirs: new Map(), files: [] }
for (const path of sources) {
  const parts = path.split("/")
  let node = tree
  for (const part of parts.slice(0, -1)) {
    if (!node.dirs.has(part)) node.dirs.set(part, { name: part, dirs: new Map(), files: [] })
    node = node.dirs.get(part)
  }
  node.files.push(path)
}
const treeJson = (node) => {
  let name = node.name
  let current = node
  while (current.files.length === 0 && current.dirs.size === 1 && name !== "") {
    current = [...current.dirs.values()][0]
    name = `${name}/${current.name}`
  }
  return {
    name,
    dirs: [...current.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(treeJson),
    files: current.files.sort((a, b) => basename(a).localeCompare(basename(b))),
  }
}

// ---------------------------------------------------------------------------------------------------------
// Flows: `<spec>-<test>.gif`, matched to `test("…")` in apps/mvp/e2e/<spec>.spec.ts the way e2e/fixtures.ts names them.

const flowName = (spec, title) =>
  `${spec}-${title.split(":")[0]}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
const unquote = (body) =>
  body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, escape) => {
    if (escape[0] === "u") return String.fromCodePoint(parseInt(escape.replace(/[u{}]/g, ""), 16))
    if (escape[0] === "x" && escape.length === 3) return String.fromCharCode(parseInt(escape.slice(1), 16))
    return { n: "\n", t: "\t", r: "\r" }[escape] ?? escape
  })

const specs = existsSync(specDir)
  ? readdirSync(specDir)
      .filter((file) => file.endsWith(".spec.ts"))
      .sort()
      .map((file) => {
        const name = file.replace(/\.spec\.ts$/, "")
        const source = readFileSync(join(specDir, file), "utf8")
        const tests = []
        for (const match of source.matchAll(/\btest(?:\.(?:only|skip|fixme|fail|slow))?\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
          const title = unquote(match[2])
          tests.push({ title, line: source.slice(0, match.index).split("\n").length, flow: flowName(name, title) })
        }
        return { name, path: `apps/mvp/e2e/${file}`, tests }
      })
  : []
const specNames = specs.map((spec) => spec.name).sort((a, b) => b.length - a.length)
const testsByFlow = new Map(specs.flatMap((spec) => spec.tests.map((test) => [test.flow, { ...test, spec: spec.name }])))

const gifSize = (file) => {
  const header = Buffer.alloc(10)
  const fd = openSync(file, "r")
  readSync(fd, header, 0, 10, 0)
  closeSync(fd)
  return header.toString("latin1", 0, 3) === "GIF" ? { width: header.readUInt16LE(6), height: header.readUInt16LE(8) } : { width: 0, height: 0 }
}
const gifs = existsSync(gifSource) ? readdirSync(gifSource).filter((file) => file.toLowerCase().endsWith(".gif")) : []
if (gifs.length === 0) warnings.push(`no GIFs in ${gifSource}`)

const readable = (slug) => {
  const words = slug.replace(/-/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
const flows = gifs.map((file) => {
  const name = file.replace(/\.gif$/i, "")
  const test = testsByFlow.get(name)
  const spec = test?.spec ?? specNames.find((spec) => name.startsWith(`${spec}-`)) ?? "other"
  if (!test) warnings.push(`no test matches ${file}`)
  const { width, height } = gifSize(join(gifSource, file))
  const bytes = statSync(join(gifSource, file)).size
  return {
    name,
    spec,
    title: readable(spec === "other" ? name : name.slice(spec.length + 1)),
    test: test?.title ?? null,
    line: test?.line ?? null,
    gif: `gifs/${encodeURIComponent(file)}`,
    width,
    height,
    bytes,
  }
})
const flowOrder = (flow) => testsByFlow.get(flow.name)?.line ?? Number.MAX_SAFE_INTEGER
flows.sort((a, b) => a.spec.localeCompare(b.spec) || flowOrder(a) - flowOrder(b) || a.name.localeCompare(b.name))
const missingGifs = specs.flatMap((spec) => spec.tests.filter((test) => !flows.some((flow) => flow.name === test.flow)).map((test) => ({ ...test, spec: spec.name })))
for (const test of missingGifs) warnings.push(`no GIF for ${test.flow} (${test.spec}.spec.ts:${test.line})`)

// ---------------------------------------------------------------------------------------------------------
// TODO: the open task items (\`- [ ]\`) in apps/mvp/docs/todo.md, counted for the nav.
const openTodos = (raw.get("apps/mvp/docs/todo.md") ?? "").match(/^\s*[-*] \[ \]/gm)?.length ?? 0

// Decisions: docs/decisions/NNNN-*.md with a "Status: <status> (<who>, <date>)" line.

const decisions = notes
  .filter((note) => /\/decisions\/[^/]+\.md$/.test(note.path))
  .map((note) => {
    const status = raw.get(note.path).match(/^Status:\s*([^(\n]+?)\s*(?:\(([^)]*)\))?\s*$/m)
    const date = status?.[2]?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null
    const heading = note.title.match(/^(\d+)[:.\s-]+(.*)$/)
    return {
      path: note.path,
      number: heading?.[1] ?? basename(note.path).match(/^\d+/)?.[0] ?? "",
      title: heading?.[2] ?? note.title,
      status: status?.[1]?.trim().toLowerCase() ?? null,
      date,
    }
  })
  .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.number.localeCompare(a.number))

// ---------------------------------------------------------------------------------------------------------
// Write.

const site = {
  builtAt: new Date().toISOString(),
  repo,
  notes: notes.map((note) => ({
    path: note.path,
    title: note.title,
    file: pathToFileURL(join(repo, note.path)).href,
    html: note.rendered.html,
    headings: note.rendered.headings.filter((heading) => heading.level >= 2 && heading.level <= 4),
    backlinks: backlinks.get(note.path).sort((a, b) => titles.get(a.from).localeCompare(titles.get(b.from))),
  })),
  tree: treeJson(tree),
  edges: [...edges.values()],
  sections: notes.flatMap((note) => note.rendered.sections.map((section) => ({ note: note.path, ...section }))),
  flows,
  specs: specs.map((spec) => ({ name: spec.name, path: spec.path, file: pathToFileURL(join(repo, spec.path)).href })),
  missingGifs,
  decisions,
  work,
  workStatuses,
  workAreas,
}

for (const owned of ["index.html", "assets", "gifs", "files"]) rmSync(join(out, owned), { recursive: true, force: true })
mkdirSync(join(out, "assets"), { recursive: true })
mkdirSync(join(out, "gifs"), { recursive: true })
for (const file of gifs) copyFileSync(join(gifSource, file), join(out, "gifs", file), constants.COPYFILE_FICLONE)
for (const [target, file] of copiedFiles) {
  mkdirSync(dirname(join(out, "files", target)), { recursive: true })
  copyFileSync(file, join(out, "files", target), constants.COPYFILE_FICLONE)
}
for (const asset of ["site.css", "site.js"]) copyFileSync(join(here, "client", asset), join(out, "assets", asset))
writeFileSync(join(out, "assets", "data.js"), `window.SITE = ${JSON.stringify(site)};\n`)

const icon =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2f5d50"/><path d="M9 21c2 2 4.5 3 7 3 3.5 0 6-1.8 6-4.6 0-5.6-12-3.4-12-8.8C10 8.5 12.3 7 15.4 7c2.2 0 4.2.8 5.6 2.1" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>')
writeFileSync(
  join(out, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Smithers maintainer</title>
<link rel="icon" href="${icon}">
<link rel="stylesheet" href="assets/site.css">
</head>
<body>
<div class="app">
  <aside class="sidebar" id="ms-sidebar">
    <div class="sidebar-top">
      <a class="brand" href="#/">Smithers</a>
      <button class="menu" id="ms-menu" type="button" aria-expanded="false" aria-controls="ms-sidebar-body" aria-label="Files">
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="search"><input id="ms-q" type="search" placeholder="Search" aria-label="Search notes and flows" autocomplete="off" spellcheck="false"><kbd>/</kbd></div>
    <div class="sidebar-body" id="ms-sidebar-body">
      <nav class="nav" aria-label="Views">
        <a href="#/" data-view="home">Home</a>
        <a href="#/work" data-view="work">Work <span class="count">${openWork}</span></a>
        <a href="#/flows" data-view="flows">Flows <span class="count">${flows.length}</span></a>
        <a href="#/graph" data-view="graph">Graph</a>
        <a href="#/apps/mvp/docs/todo.md" data-view="todo">TODO <span class="count">${openTodos}</span></a>
        <a href="http://localhost:4747/queue" title="Will's decision queue: node apps/maintainer-site/serve.mjs">Queue</a>
      </nav>
      <nav class="tree" id="ms-tree" aria-label="Notes"></nav>
    </div>
  </aside>
  <main id="ms-main" tabindex="-1"></main>
</div>
<dialog id="ms-lightbox" aria-label="Flow"></dialog>
<script src="assets/data.js"></script>
<script src="assets/site.js"></script>
</body>
</html>
`,
)

for (const warning of warnings) console.warn(`warning: ${warning}`)
const ms = Math.round(performance.now() - started)
console.log(`${notes.length} notes, ${flows.length} flows, ${edges.size} links, ${work.length} work items (${openWork} open) in ${ms} ms`)
console.log(join(out, "index.html"))
