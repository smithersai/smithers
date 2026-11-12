// Will's decision queue: one item fills the screen; every action has a key.
"use strict"
;(() => {
  const $ = (id) => document.getElementById(id)
  const stage = $("q-stage")
  const keysBar = $("q-keys")
  const viewer = $("q-viewer")
  const sheet = $("q-sheet")
  const toast = $("q-toast")
  const reduced = matchMedia("(prefers-reduced-motion: reduce)")
  const MOVE_MS = 160

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
  // Backticks and bold in one-line fields (why, options, file notes) render as code and bold.
  const inline = (value) => esc(value).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  const store = {
    get(key) {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    set(key, value) {
      try {
        if (value) localStorage.setItem(key, value)
        else localStorage.removeItem(key)
      } catch {}
    },
  }
  const draftKey = (id) => `queue:draft:${id}`
  const scopeKey = (id) => `queue:scope:${id}`
  const COMMENTS_KEY = "queue:hide-comments"
  const OUTLINE_KEY = "queue:outline"

  // ---------------------------------------------------------------------------------------------------------
  // State.

  let items = [] // the server's visible queue, highest priority first
  let current = null // the item under Will's hands; a live reorder never replaces it
  let card = null // its element
  let picked = null // { action, option } chosen while the box has text; ⌘Enter sends it
  let scopeAll = false // g: the note applies to every item of this kind
  let fileIndex = 0
  let mediaIndex = 0
  let linkIndex = -1
  let serverLast = null
  const inFlight = new Set() // answered here, not yet hidden by the server
  const sent = [] // this session's answers, newest last, for undo: { item, text, scope, saved, settled }
  const files = new Map() // [slice, commit, revision, path] -> Promise<{ ok, text, type }>
  let stats = { doneToday: 0, remaining: {}, total: 0, coverage: null }
  let missing = false
  const outlines = new Map() // [slice, commit, revision, path] -> Promise<{ comments, folds, symbols } | null>
  let hideComments = store.get(COMMENTS_KEY) === "1" // c, per viewer
  let outlineOpen = store.get(OUTLINE_KEY) === "1" // O, per viewer
  const foldedBy = new Map() // path -> Set of folded first lines, this session
  let view = null // the code on screen with its outline; see codeView
  let codeToken = null // the latest renderCode; an older load never takes the view

  const KIND_LABEL = { decision: "Decision", code: "Code", design: "Design", gif: "Flow", verify: "Verify", question: "Question" }
  const KIND_PLURAL = { decision: "decisions", code: "code reviews", design: "designs", gif: "flows", verify: "fixes to verify", question: "questions" }
  const allOf = (kind) => `all ${KIND_PLURAL[kind] ?? `${kind} items`}`
  const kindOrder = ["decision", "question", "verify", "code", "design", "gif"]

  // ---------------------------------------------------------------------------------------------------------
  // Data.

  const api = async (path, init) => {
    const response = await fetch(path, { cache: "no-store", ...init })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw Object.assign(new Error(body.error || `${response.status}`), { status: response.status, body })
    return body
  }

  const fileUrl = (path) => `/api/file?path=${encodeURIComponent(path)}`
  // Path form, so a design's relative styles and scripts resolve beside it.
  const frameUrl = (path) => `/api/file/${path.startsWith("/") ? "/" : ""}${path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")}`
  const extOf = (path) => (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase()
  const IMAGE = new Set(["gif", "png", "jpg", "jpeg", "webp", "avif", "svg"])
  const VIDEO = new Set(["mp4", "webm"])

  const loadFile = (path, slice = "", commit = "", revision = "") => {
    const key = JSON.stringify([slice, commit, revision, path])
    if (!files.has(key))
      files.set(
        key,
        fetch(fileUrl(path) + `&slice=${encodeURIComponent(slice)}`, { cache: "no-store" })
          .then(async (response) => {
            const text = await response.text()
            if (!response.ok) {
              let error = text
              try {
                error = JSON.parse(text).error
              } catch {}
              return { ok: false, text: error || `${response.status}` }
            }
            return { ok: true, text }
          })
          .catch((error) => ({ ok: false, text: String(error.message || error) })),
      )
    return files.get(key)
  }

  // Comments, folds and symbols from the server's TypeScript parse; null for other languages or on failure. A failure
  // is not kept, so the next view of the file asks again (a server restarted with the endpoint, a file that parses now).
  const canOutline = (path) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path ?? "")
  const loadOutline = (path, slice = "", commit = "", revision = "") => {
    const key = JSON.stringify([slice, commit, revision, path])
    if (!outlines.has(key)) {
      const failed = () => {
        outlines.delete(key)
        return null
      }
      outlines.set(
        key,
        canOutline(path)
          ? fetch(`/api/outline?path=${encodeURIComponent(path)}&slice=${encodeURIComponent(slice)}`, { cache: "no-store" })
              .then((response) => (response.ok ? response.json() : failed()))
              .then((outline) => (outline?.supported ? outline : null))
              .catch(failed)
          : Promise.resolve(null),
      )
    }
    return outlines.get(key)
  }

  async function refresh() {
    let queue
    try {
      ;[queue, stats] = await Promise.all([api("/api/queue"), api("/api/stats")])
    } catch (error) {
      say(`Server unreachable: ${error.message}`, true)
      return
    }
    missing = queue.missing
    serverLast = queue.last
    const ids = new Set(queue.items.map((item) => item.id))
    for (const id of [...inFlight]) if (!ids.has(id)) inFlight.delete(id)
    items = queue.items.filter((item) => !inFlight.has(item.id))
    if (current) {
      const fresh = items.find((item) => item.id === current.id)
      // The curator dropped the item and Will has typed nothing: move on. With a draft, it stays, marked.
      if (!fresh && !hasDraft()) show(next(), "up")
      else card?.classList.toggle("gone", !fresh)
    } else if (items.length) {
      // `#<item id>` opens that item first.
      const wanted = decodeURIComponent(location.hash.slice(1))
      show(items.find((item) => item.id === wanted) ?? items[0], "up")
    } else if (!card || card.dataset.missing !== String(missing)) show(null)
    header()
    for (const item of items.slice(0, 3)) prefetch(item)
  }

  const next = (skip = current?.id) => items.find((item) => item.id !== skip && !inFlight.has(item.id)) ?? null
  const hasDraft = () => bare(box()?.value) !== ""
  const box = () => card?.querySelector("textarea") ?? null

  function prefetch(item) {
    if (item.kind === "code")
      for (const file of item.files ?? []) {
        loadFile(file.path, item.id, item.commit, item.revision)
        loadOutline(file.path, item.id, item.commit, item.revision)
      }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Header and footer.

  let lastTotal = null
  function header() {
    const total = items.length
    const at = current ? Math.max(1, items.findIndex((item) => item.id === current.id) + 1 || 1) : 0
    $("q-at").textContent = String(at)
    $("q-total").textContent = String(total)
    if (lastTotal !== null && lastTotal !== total) bump($("q-pos"))
    lastTotal = total
    const counts = {}
    for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1
    $("q-kinds").innerHTML = [...kindOrder, ...Object.keys(counts).filter((kind) => !kindOrder.includes(kind))]
      .filter((kind) => counts[kind])
      .map((kind) => `<span class="q-kind k-${esc(kind)}"><b>${counts[kind]}</b> ${esc((KIND_LABEL[kind] ?? kind).toLowerCase())}</span>`)
      .join("")
    const done = $("q-done")
    if (done.textContent !== String(stats.doneToday)) {
      done.textContent = String(stats.doneToday)
      bump(done.parentElement)
    }
    const cov = $("q-cov")
    cov.hidden = stats.coverage == null
    if (stats.coverage != null) cov.innerHTML = `<b>${esc(stats.coverage)}%</b> reviewed`
  }
  function bump(element) {
    element.classList.remove("bump")
    void element.offsetWidth
    element.classList.add("bump")
  }

  const kbd = (key) => `<kbd>${esc(key)}</kbd>`
  function footer() {
    const item = current
    const parts = []
    if (item) {
      if (item.options?.length) parts.push([`1–${item.options.length}`, "choose"])
      if (item.kind !== "decision" && item.kind !== "question") parts.push(["a", item.kind === "verify" ? "fixed" : "looks good"])
      parts.push(["r", item.kind === "verify" ? "not fixed" : item.options?.length ? "other" : item.kind === "question" ? "answer" : "changes"])
      parts.push(["l", "later"])
    }
    if (item) parts.push(["g", "applies to all"])
    if (sent.length || serverLast) parts.push(["u", "undo"])
    if (item) parts.push(["i", "type"], ["⌘↵", "send"], ["j k", "scroll"])
    if (item?.kind === "code" && (item.files?.length ?? 0) > 1) parts.push(["J K", "file"])
    if (item?.kind === "code" && canOutline(item.files?.[fileIndex]?.path)) parts.push(["c", "comments"], ["z Z", "fold"], ["O", "outline"])
    if (item && comparing(item) && compareKind(item) !== "code") parts.push(["b", "before / after"])
    if (!comparing(item) && (item?.media?.length ?? 0) > 1) parts.push(["n p", "media"])
    if (item && (comparing(item) ? compareKind(item) === "video" : isVideo(item.media?.[mediaIndex] ?? afterOf(item)))) parts.push(["space", "play"], ["← →", "2 s"], [", .", "frame"], ["[ ]", "chapter"], ["< >", "speed"], ["0", "start"])
    if (sourceOf(item)) parts.push(["o", "source"])
    else if (item?.links?.length) parts.push(["o", "open"])
    parts.push(["f", "full screen"], ["?", "keys"])
    keysBar.innerHTML = parts.map(([key, label]) => `<span>${kbd(key)} ${esc(label)}</span>`).join("")
  }

  // ---------------------------------------------------------------------------------------------------------
  // The item.

  function actionsFor(item) {
    const verify = item.kind === "verify"
    const list = []
    if (item.kind !== "decision" && item.kind !== "question") list.push({ key: "a", action: "approve", label: verify ? "Fixed" : "Looks good", primary: true })
    list.push({ key: "r", action: "changes", label: verify ? "Not fixed" : item.options?.length ? "Other" : item.kind === "question" ? "Answer" : "Changes" })
    list.push({ key: "l", action: "later", label: "Later" })
    return list
  }

  function render(item) {
    const element = document.createElement("article")
    element.className = `q-card kind-${item.kind}`
    element.dataset.id = item.id
    const wide = ["code", "design", "gif", "verify"].includes(item.kind) || (item.media?.length ?? 0) > 0 || Boolean(afterOf(item))
    if (wide) element.classList.add("wide")
    const options = (item.options ?? []).slice(0, 4)
    const optionsHtml = options.length
      ? `<ol class="q-options">${options
          .map(
            (option, index) => `<li><button type="button" class="q-option${option.recommended ? " rec" : ""}" data-action="option" data-option="${esc(option.key ?? String(index + 1))}">
          ${kbd(option.key ?? String(index + 1))}<span class="q-opt-body"><span class="q-opt-label">${inline(option.label)}${option.recommended ? ' <span class="q-rec">recommended</span>' : ""}</span>${option.detail ? `<span class="q-opt-detail">${inline(option.detail)}</span>` : ""}</span></button></li>`,
          )
          .join("")}</ol>`
      : ""
    const links = (item.links ?? []).length
      ? `<ul class="q-links">${item.links.map((link, index) => `<li><button type="button" class="q-link" data-link="${index}">${index === 0 ? kbd("o") : ""}<span>${esc(link.label || link.path)}</span></button></li>`).join("")}</ul>`
      : ""
    const said = saidOf(item) || (item.kind === "verify" ? item.verifies?.action : "")
    const verifies = said
      ? `<blockquote class="q-said"><span class="q-said-head">You said${item.verifies?.at ? ` on ${esc(new Date(item.verifies.at).toLocaleDateString())}` : ""}</span>${esc(said)}</blockquote>`
      : ""
    const draft = store.get(draftKey(item.id)) ?? ""
    element.innerHTML = `
      <section class="q-side">
        <div class="q-meta"><span class="q-pill k-${esc(item.kind)}">${esc(KIND_LABEL[item.kind] ?? item.kind)}</span>${item.area ? `<span class="q-area">${esc(item.area)}</span>` : ""}<span class="q-prio" title="Priority">${esc(item.priority ?? "")}</span><span class="q-gone-badge">left the queue</span></div>
        <h1 class="q-title">${esc(item.title)}</h1>
        ${item.why ? `<p class="q-why">${inline(item.why)}</p>` : ""}
        ${item.contextHtml ? `<div class="q-context md">${item.contextHtml}</div>` : ""}
        ${verifies}
        ${links}
        ${wide ? "" : optionsHtml}
        <div class="q-form">
          <span class="q-scope">${kbd("g")} Applies to ${esc(allOf(item.kind))}</span>
          <textarea class="q-box" rows="${wide ? 4 : 3}" placeholder="Note (i)" aria-label="Note" spellcheck="true">${esc(draft)}</textarea>
          <div class="q-actions">${wide ? optionsHtml : ""}${actionsFor(item)
            .map((action) => `<button type="button" class="q-act${action.primary ? " primary" : ""}" data-action="${action.action}">${kbd(action.key)} ${esc(action.label)}</button>`)
            .join("")}<span class="q-send-hint">${kbd("⌘↵")} send</span></div>
        </div>
      </section>
      ${wide ? `<section class="q-subject" tabindex="-1"></section>` : ""}`
    if (item.kind === "code") linkRefs(element, item)
    if (wide) renderSubject(item, element.querySelector(".q-subject"))
    return element
  }

  // `path:42` in the guide links to that line of the slice, and opens it past hidden comments and folds.
  const REF = /^([\w@./-]+\.[A-Za-z0-9]+):(\d+)(?:[-–]\d+)?$/
  function linkRefs(element, item) {
    for (const code of element.querySelectorAll(".q-context code")) {
      if (code.closest("pre, a")) continue
      const match = REF.exec(code.textContent.trim())
      if (!match) continue
      const index = (item.files ?? []).findIndex((file) => file.path === match[1] || file.path.endsWith(`/${match[1]}`))
      const file = item.files?.[index]
      const line = Number(match[2])
      if (!file || line < (Number(file.from) || 1) || (Number(file.to) && line > Number(file.to))) continue
      const link = document.createElement("a")
      link.className = "q-ref"
      link.href = `#L${line}`
      link.dataset.refFile = String(index)
      link.dataset.refLine = String(line)
      code.replaceWith(link)
      link.append(code)
    }
  }

  function renderSubject(item, subject) {
    if (comparing(item)) return renderCompare(item, subject)
    // An after recording without the old one: it plays alone, with Will's earlier note pinned at its moment.
    if (!item.media?.length && afterOf(item)) item = { ...item, media: [afterOf(item)] }
    if (item.kind === "code" && item.files?.length) return renderCode(item, subject)
    if (item.media?.length) return renderMedia(item, subject)
    if (item.files?.length) return renderCode(item, subject)
    subject.innerHTML = `<p class="q-empty-subject">Nothing to show.</p>`
  }

  // A code slice. TypeScript and JavaScript files also get the tools: c hides comments, z and Z fold and unfold every
  // body, a chevron folds one, O opens the outline. `line`, when given, is shown once the file is in.
  function renderCode(item, subject, line = null, press = null) {
    const list = item.files
    fileIndex = Math.min(fileIndex, list.length - 1)
    const file = list[fileIndex]
    const range = file.from ? `L${file.from}–${file.to ?? ""}` : ""
    const tools = canOutline(file.path)
    subject.innerHTML = `
      <nav class="q-tabs" aria-label="Files">${list
        .map((entry, index) => `<button type="button" class="q-tab${index === fileIndex ? " on" : ""}" data-file="${index}" title="${esc(entry.path)}">${esc(entry.path.split("/").pop())}</button>`)
        .join("")}${list.length > 1 ? `<span class="q-tab-keys">${kbd("J")}${kbd("K")}</span>` : ""}</nav>
      <div class="q-file-head"><span class="q-path">${esc(file.path)}</span><span class="q-range">${esc(range)}</span>${item.revision ? `<span class="q-rev">${esc(String(item.revision).slice(0, 12))}</span>` : ""}${tools ? `<span class="q-tools">${toolsHtml()}</span>` : ""}</div>
      ${file.note ? `<p class="q-note">${inline(file.note)}</p>` : ""}
      <div class="q-code-body"><div class="q-code-scroll"><div class="q-code loading">Loading…</div></div>${
        tools ? `<aside class="q-outline" aria-label="Outline"${outlineOpen ? "" : " hidden"}><input class="q-outline-filter" type="search" placeholder="Filter" aria-label="Filter symbols" spellcheck="false" autocomplete="off"><nav class="q-outline-list"><p class="q-outline-empty">Loading…</p></nav></aside>` : ""
      }</div>`
    const target = subject.querySelector(".q-code")
    const token = {}
    codeToken = token
    view = null
    Promise.all([loadFile(file.path, item.id, item.commit, item.revision), loadOutline(file.path, item.id, item.commit, item.revision)]).then(([result, outline]) => {
      if (!target.isConnected) return
      target.classList.remove("loading")
      if (!result.ok) {
        target.innerHTML = `<p class="q-error">${esc(result.text)}</p>`
        return
      }
      if (!outline || codeToken !== token) {
        target.innerHTML = codeHtml(result.text, file.path, file.from, file.to)
        if (codeToken === token) renderOutline()
        if (codeToken === token && press) say("The outline did not load", true)
      } else {
        view = codeView(target, result.text, file, outline)
        press?.()
      }
      if (line != null && codeToken === token) revealLine(line)
    })
  }

  const toolsHtml = () =>
    `<button type="button" class="q-tool" data-tool="comments">${kbd("c")} <span>${hideComments ? "Show comments" : "Hide comments"}</span></button>` +
    `<button type="button" class="q-tool" data-tool="fold">${kbd("z")} <span>Fold all</span></button>` +
    `<button type="button" class="q-tool" data-tool="unfold">${kbd("Z")} <span>Unfold all</span></button>` +
    `<button type="button" class="q-tool" data-tool="outline" aria-pressed="${outlineOpen}">${kbd("O")} <span>Outline</span></button>`
  function syncTools() {
    const label = card?.querySelector("[data-tool=comments] span")
    if (label) label.textContent = hideComments ? "Show comments" : "Hide comments"
    card?.querySelector("[data-tool=outline]")?.setAttribute("aria-pressed", String(outlineOpen))
  }

  // ---------------------------------------------------------------------------------------------------------
  // The code view's outline: every row keeps its file line number. Comment-only lines carry .q-cline and comments
  // beside code .q-cm, so hiding them is one class; a fold hides its lines and shows its first line as `{ … }`.

  function codeView(target, text, file, outline) {
    const lines = lineTokens(text, file.path)
    const start = Math.max(1, Number(file.from) || 1)
    const end = Math.min(lines.length, Number(file.to) || lines.length)
    const inside = (line) => line >= start && line <= end
    const commentLines = new Set()
    for (const [from, to] of outline.comments.lines) for (let line = Math.max(from, start); line <= Math.min(to, end); line++) commentLines.add(line)
    const inlineComments = new Map()
    for (const [line, from, to] of outline.comments.inline) if (inside(line)) inlineComments.set(line, [...(inlineComments.get(line) ?? []), [from, to]])
    const folds = outline.folds.filter((fold) => fold.from >= start && fold.to <= end)
    const symbols = outline.symbols.filter((symbol) => inside(symbol.line))
    const base = Math.min(...symbols.map((symbol) => symbol.depth))
    if (!foldedBy.has(file.path)) foldedBy.set(file.path, new Set())
    const state = {
      path: file.path,
      root: target,
      lines,
      start,
      end,
      commentLines,
      inlineComments,
      folds,
      foldAt: new Map(folds.map((fold) => [fold.from, fold])),
      folded: foldedBy.get(file.path),
      symbols: symbols.map((symbol) => ({ ...symbol, depth: symbol.depth - base })),
      shown: [],
      selected: 0,
      rows: [],
    }
    const rows = []
    for (let number = start; number <= end; number++)
      rows.push(
        `<div class="q-line${commentLines.has(number) ? " q-cline" : ""}"><a class="q-ln" data-line="${number}">${number}</a><span class="q-gut">${
          state.foldAt.has(number) ? `<button type="button" class="q-chev" data-fold="${number}" tabindex="-1" aria-label="Fold" aria-expanded="true"></button>` : ""
        }</span><span class="q-lc">${lineHtml(state, number) || " "}</span></div>`,
      )
    target.innerHTML = rows.join("")
    target.classList.add("outlined")
    target.classList.toggle("hide-comments", hideComments)
    state.rows = [...target.children]
    applyFolds(state)
    view = state
    renderOutline()
    return state
  }

  // Line `number` from column `from` to `to`, coloured, with comments beside code wrapped so c can hide them.
  function lineHtml(state, number, from = 0, to = Infinity) {
    const marks = state.inlineComments.get(number) ?? []
    let col = 0
    let html = ""
    for (const [cls, value] of state.lines[number - 1] ?? []) {
      const segment = col
      col += value.length
      let at = Math.max(segment, from)
      const stop = Math.min(col, to)
      while (at < stop) {
        const mark = marks.find(([start, end]) => start <= at && at < end)
        const next = mark ? Math.min(stop, mark[1]) : Math.min(stop, marks.find(([start]) => start > at)?.[0] ?? stop)
        const piece = esc(value.slice(at - segment, next - segment))
        const span = cls ? `<span class="t${cls}">${piece}</span>` : piece
        html += mark ? `<span class="q-cm">${span}</span>` : span
        at = next
      }
    }
    return html
  }

  // A folded body: its first line to the `{`, the dots, then the line of its `}` from there on. When that line opens
  // another folded body (`} else {`), the chain continues on the same row.
  function foldedHtml(state, fold) {
    const dots = (entry) => `<button type="button" class="q-dots" data-fold="${entry.from}" tabindex="-1" title="Unfold">…</button>`
    let html = lineHtml(state, fold.from, 0, fold.open + 1) + dots(fold)
    let last = fold
    for (;;) {
      const next = state.foldAt.get(last.to)
      if (!next || next === last || !state.folded.has(next.from) || next.open < last.close) break
      html += lineHtml(state, last.to, last.close, next.open + 1) + dots(next)
      last = next
    }
    html += lineHtml(state, last.to, last.close)
    const count = last.to - fold.from
    return `${html}<span class="q-fold-n">${count} ${count === 1 ? "line" : "lines"}</span>`
  }

  function applyFolds(state) {
    const { rows, start, folds, folded } = state
    const hidden = new Uint8Array(rows.length)
    for (const fold of folds) if (folded.has(fold.from)) hidden.fill(1, fold.from + 1 - start, fold.to + 1 - start)
    rows.forEach((row, index) => {
      row.hidden = hidden[index] === 1
    })
    for (const fold of folds) {
      const row = rows[fold.from - start]
      const shut = folded.has(fold.from) && !hidden[fold.from - start]
      if (shut) row.querySelector(".q-lc").innerHTML = foldedHtml(state, fold)
      else if (row.classList.contains("folded")) row.querySelector(".q-lc").innerHTML = lineHtml(state, fold.from) || " "
      row.classList.toggle("folded", shut)
      const chevron = row.querySelector(".q-chev")
      chevron.setAttribute("aria-expanded", String(!folded.has(fold.from)))
      chevron.setAttribute("aria-label", folded.has(fold.from) ? "Unfold" : "Fold")
    }
  }

  // A change to what shows keeps the line at the top of the code where it was.
  function keepPlace(change) {
    const scroller = view?.root.closest(".q-code-scroll")
    if (!scroller) return change()
    const top = scroller.getBoundingClientRect().top
    const shows = (row) => !row.hidden && row.offsetParent !== null
    let index = view.rows.findIndex((row) => shows(row) && row.getBoundingClientRect().bottom > top + 1)
    const offset = index < 0 ? 0 : view.rows[index].getBoundingClientRect().top - top
    change()
    while (index > 0 && !shows(view.rows[index])) index--
    if (index >= 0 && shows(view.rows[index])) scroller.scrollTop += view.rows[index].getBoundingClientRect().top - top - offset
  }

  // A tool pressed before the outline arrived, or after it failed: ask again, and press it once the outline is in.
  function needView(press) {
    if (view) return false
    const file = current?.kind === "code" ? current.files?.[fileIndex] : null
    if (!canOutline(file?.path) || !card || card.querySelector(".q-code.loading")) return true
    renderCode(current, card.querySelector(".q-subject"), null, press)
    return true
  }

  function toggleComments() {
    if (needView(toggleComments)) return
    keepPlace(() => {
      hideComments = !hideComments
      store.set(COMMENTS_KEY, hideComments ? "1" : "")
      view.root.classList.toggle("hide-comments", hideComments)
      for (const row of view.root.querySelectorAll(".reveal")) row.classList.remove("reveal")
    })
    syncTools()
  }
  function toggleFold(line) {
    if (needView(() => toggleFold(line)) || !view.foldAt.has(line)) return
    keepPlace(() => {
      if (view.folded.has(line)) view.folded.delete(line)
      else view.folded.add(line)
      applyFolds(view)
    })
  }
  function foldAll(shut) {
    if (needView(() => foldAll(shut))) return
    keepPlace(() => {
      for (const fold of view.folds) {
        if (shut) view.folded.add(fold.from)
        else view.folded.delete(fold.from)
      }
      applyFolds(view)
    })
  }

  // Shows line `number`: the folds around it open, its comment shows if hidden, and it is marked and scrolled to.
  function revealLine(number) {
    let row
    if (view) {
      if (number < view.start || number > view.end) return
      for (const fold of view.folds) if (fold.from < number && number <= fold.to) view.folded.delete(fold.from)
      if (hideComments && view.commentLines.has(number)) {
        let from = number
        let to = number
        while (view.commentLines.has(from - 1)) from--
        while (view.commentLines.has(to + 1)) to++
        for (let line = from; line <= to; line++) view.rows[line - view.start].classList.add("reveal")
      }
      applyFolds(view)
      row = view.rows[number - view.start]
    } else row = card?.querySelector(`.q-code .q-ln[data-line="${number}"]`)?.parentElement
    const scroller = row?.closest(".q-code-scroll")
    if (!scroller) return
    for (const old of card.querySelectorAll(".q-line.hit")) old.classList.remove("hit")
    row.classList.add("hit")
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3
  }
  function goToLine(index, line) {
    if (!current?.files?.[index]) return
    if (index !== fileIndex || !view) {
      fileIndex = index
      renderCode(current, card.querySelector(".q-subject"), line)
      return footer()
    }
    revealLine(line)
  }

  // The outline: the slice's symbols in file order, indented by nesting; the box filters, ↑ ↓ pick, Enter jumps.
  function renderOutline() {
    const pane = card?.querySelector(".q-outline")
    if (!pane) return
    const list = pane.querySelector(".q-outline-list")
    if (!view) {
      list.innerHTML = `<p class="q-outline-empty">No outline</p>`
      return
    }
    const query = pane.querySelector(".q-outline-filter").value.trim().toLowerCase()
    view.shown = view.symbols.filter((symbol) => symbol.name.toLowerCase().includes(query))
    view.selected = Math.max(0, Math.min(view.selected, view.shown.length - 1))
    list.innerHTML = view.shown.length
      ? view.shown
          .map(
            (symbol, index) =>
              `<button type="button" class="q-sym${symbol.exported ? " exp" : ""}${index === view.selected ? " on" : ""}" data-sym="${index}" tabindex="-1" style="padding-left:${10 + symbol.depth * 14}px"><span class="q-sym-kind k-${esc(symbol.kind)}">${esc(symbol.kind)}</span><span class="q-sym-name">${esc(symbol.name)}</span><span class="q-sym-ln">${symbol.line}</span></button>`,
          )
          .join("")
      : `<p class="q-outline-empty">No symbols</p>`
  }
  function toggleOutline() {
    const pane = card?.querySelector(".q-outline")
    if (!pane) return
    outlineOpen = pane.hidden
    store.set(OUTLINE_KEY, outlineOpen ? "1" : "")
    if (outlineOpen && needView(() => card?.querySelector(".q-outline-filter")?.focus())) return syncTools()
    pane.hidden = !outlineOpen
    syncTools()
    if (outlineOpen) {
      renderOutline()
      pane.querySelector(".q-outline-filter").focus()
    } else if (pane.contains(document.activeElement)) document.activeElement.blur()
  }
  function pickSymbol(step) {
    if (!view?.shown.length) return
    view.selected = (view.selected + step + view.shown.length) % view.shown.length
    for (const row of card.querySelectorAll(".q-sym")) row.classList.toggle("on", Number(row.dataset.sym) === view.selected)
    card.querySelector(`.q-sym[data-sym="${view.selected}"]`)?.scrollIntoView({ block: "nearest" })
  }
  function openSymbol(index) {
    const symbol = view?.shown[index]
    if (!symbol) return
    view.selected = index
    for (const row of card.querySelectorAll(".q-sym")) row.classList.toggle("on", Number(row.dataset.sym) === index)
    revealLine(symbol.line)
  }

  function renderMedia(item, subject) {
    const list = item.media
    mediaIndex = Math.min(mediaIndex, list.length - 1)
    const media = list[mediaIndex]
    const type = media.type || extOf(media.path)
    const name = media.path.split("/").pop()
    let body
    if (type === "html") body = `<iframe class="q-frame" sandbox="allow-scripts" src="${esc(frameUrl(media.path))}" title="${esc(name)}"></iframe><span class="q-frame-hint">Keys go to the design. Click outside it for queue keys.</span>`
    else if (isMarkdown(media)) body = null
    else if (!isVideo(media)) body = `<img class="q-img" src="${esc(fileUrl(media.path))}" alt="${esc(name)}">`
    player = null
    const head = `<div class="q-file-head"><span class="q-path">${esc(media.path)}</span>${list.length > 1 ? `<span class="q-range">${mediaIndex + 1} / ${list.length} ${kbd("n")}${kbd("p")}</span>` : ""}${isMarkdown(media) ? `<span class="q-close">${kbd("o")} source</span>` : ""}</div>`
    if (isMarkdown(media)) {
      subject.innerHTML = `${head}<div class="q-doc"><article class="md q-md loading">Loading…</article></div>`
      return renderDoc(media, subject.querySelector(".q-md"))
    }
    subject.innerHTML = `${head}${body ? `<div class="q-media">${body}</div>` : `<div class="q-player"></div>`}`
    if (!body) renderPlayer(subject.querySelector(".q-player"), media, notesOf(item))
  }

  // A Markdown file reads like a README on GitHub: rendered by the server's markdown.mjs, code coloured here, links
  // opening in a new tab, and `o` for the raw source.
  const isMarkdown = (media) => Boolean(media) && (media.type === "md" || media.type === "markdown" || ["md", "mdx", "markdown"].includes(extOf(media.path ?? "")))
  const LANG = { typescript: "ts", javascript: "js", shell: "sh", console: "sh", rust: "rs", python: "py", golang: "go", yml: "yaml", markdown: "md", jsonc: "json", html: "html", xml: "xml" }
  async function renderDoc(media, article) {
    const response = await fetch(`/api/markdown?path=${encodeURIComponent(media.path)}`, { cache: "no-store" }).catch(() => null)
    const body = response ? await response.json().catch(() => ({})) : {}
    if (!article.isConnected) return
    article.classList.remove("loading")
    if (!response?.ok) {
      article.innerHTML = `<p class="q-error">${esc(body.error || "The file did not load.")}</p>`
      return
    }
    article.innerHTML = body.html
    for (const code of article.querySelectorAll("pre > code")) {
      const lang = (code.className.match(/language-([\w+-]+)/)?.[1] ?? "").toLowerCase()
      code.innerHTML = tokens(code.textContent, LANG[lang] ?? lang)
        .map(([cls, value]) => (cls ? `<span class="t${cls}">${esc(value)}</span>` : esc(value)))
        .join("")
    }
    for (const link of article.querySelectorAll("a[href]")) {
      if (link.getAttribute("href").startsWith("#")) continue
      link.target = "_blank"
      link.rel = "noopener noreferrer"
    }
  }
  const sourceOf = (item) => {
    const media = comparing(item) ? null : item?.media?.[mediaIndex]
    return isMarkdown(media) ? media : null
  }

  // ---------------------------------------------------------------------------------------------------------
  // The review player: a recording with a chapter timeline. Keys: space, ← →, , ., [ ], < >, 0.

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
  const FRAME = 1 / 30
  let player = null // { video, chapters, root, index }
  const isVideo = (media) => Boolean(media) && (media.type === "video" || VIDEO.has(extOf(media.path)))
  const clock = (seconds) => {
    const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
    return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`
  }
  const normalizeChapters = (list) => {
    const chapters = (Array.isArray(list) ? list : [])
      .filter((chapter) => chapter && Number.isFinite(Number(chapter.t)))
      .map((chapter) => ({ t: Math.max(0, Number(chapter.t)), label: String(chapter.label ?? "") }))
      .sort((a, b) => a.t - b.t)
    if (chapters.length && chapters[0].t > 0.05) chapters.unshift({ t: 0, label: "Start" })
    return chapters
  }
  async function loadChapters(source) {
    if (Array.isArray(source)) return normalizeChapters(source)
    if (typeof source !== "string" || source === "") return []
    const result = await loadFile(source)
    if (!result.ok) return []
    try {
      const data = JSON.parse(result.text)
      return normalizeChapters(Array.isArray(data) ? data : data.chapters)
    } catch {
      return []
    }
  }
  const chapterIn = (chapters, time) => {
    if (!chapters.length) return -1
    let index = 0
    for (let at = 0; at < chapters.length; at++) if (chapters[at].t <= time + 0.001) index = at
    return index
  }
  const chapterAt = (time) => (player ? chapterIn(player.chapters, time) : -1)
  // The same moment in another recording of the flow: the same chapter, the same distance into it. Without a
  // matching chapter, the same clock time.
  const mapTime = (time, from, to) => {
    const index = chapterIn(from, time)
    const target = index < 0 ? -1 : to.findIndex((chapter) => chapter.label === from[index].label)
    if (target < 0) return time
    const end = to[target + 1]?.t ?? Infinity
    return Math.min(to[target].t + (time - from[index].t), end - 0.001)
  }
  // "[02:14 Save] note" stamps in Will's earlier answer: where he said what.
  const STAMPED = /\[(\d+):(\d{2})(?:\s+([^\]\n]*))?\]\s*([^[]*)/g
  const pinsIn = (text) => [...String(text ?? "").matchAll(STAMPED)].map((match) => ({ old: Number(match[1]) * 60 + Number(match[2]), label: (match[3] ?? "").trim(), note: match[4].trim(), stamp: `[${match[1]}:${match[2]}${match[3] ? ` ${match[3].trim()}` : ""}]` }))

  // One recording, or a before and after pair on one timeline. The after recording leads; the before one follows
  // to the same moment, and Will's earlier notes are pinned where he made them.
  function renderPlayer(root, media, { before = null, note = "", stamp = "" } = {}) {
    const compare = before ? { before } : null
    // Will's earlier note sits on the old recording, or on this one when the old one wasn't kept.
    const screen = (cls, label, path) =>
      `<figure class="q-pane ${cls}">${compare ? `<figcaption><b>${label}</b> <span class="q-pane-time"></span></figcaption>` : ""}<div class="q-screen"><video class="${cls === "before" ? "q-video-before" : "q-video"}" src="${esc(fileUrl(path))}" muted playsinline preload="auto"></video>${cls === "before" || !compare ? `<p class="q-pin-note" hidden></p>` : ""}</div></figure>`
    root.innerHTML = `
      <div class="q-panes">${compare ? screen("before", "Before", compare.before.path) : ""}${screen("after", "After", media.path)}</div>
      <div class="q-timeline">
        <div class="q-bar" data-seek><div class="q-fill"></div><div class="q-ticks"></div><div class="q-pins"></div><div class="q-playhead"></div></div>
        <div class="q-segs"></div>
      </div>
      <div class="q-transport">
        <button type="button" class="q-pp" data-player="toggle">${kbd("space")} <span class="q-pp-label">Pause</span></button>
        <span class="q-time"><b>00:00</b> / 00:00</span>
        <span class="q-chapter-now"></span>
        <span class="q-spacer"></span>
        ${compare ? `<span class="q-mode">${kbd("b")} <b>Both</b></span>` : ""}
        <span class="q-speed">${kbd("<")} <b>1×</b> ${kbd(">")}</span>
      </div>`
    const video = root.querySelector(".q-video")
    const other = root.querySelector(".q-video-before")
    const state = { video, other, root, chapters: [], otherChapters: [], pins: [], index: -2, ready: 0 }
    player = state
    const live = () => player === state && video.isConnected
    // The before recording lines up as soon as it can seek.
    other?.addEventListener("loadedmetadata", () => live() && sync())
    for (const element of [video, other].filter(Boolean)) {
      // Muted recordings may play on their own; the property, not only the attribute, lets Chromium start them.
      element.muted = true
      element.addEventListener("error", () => {
        if (live()) element.parentElement.innerHTML = `<p class="q-error">This recording does not play here.</p>`
      })
    }
    const loop = () => {
      if (!live()) return
      sync()
      if (!video.paused && !video.ended) requestAnimationFrame(loop)
    }
    for (const name of ["timeupdate", "seeked", "pause", "ended", "ratechange"]) video.addEventListener(name, () => live() && sync())
    video.addEventListener("play", () => requestAnimationFrame(loop))
    // Start once the timeline is known: a pair opens paused on Will's first pinned moment; one recording plays.
    const start = () => {
      if (!live() || ++state.ready < 2) return
      layoutTimeline()
      if (state.pins.length) seek(state.pins[0].t)
      else video.play().catch(() => {})
    }
    if (video.readyState >= 1) start()
    else video.addEventListener("loadedmetadata", start, { once: true })
    Promise.all([loadChapters(media.chapters), compare ? loadChapters(compare.before.chapters) : []]).then(([chapters, otherChapters]) => {
      if (!live()) return
      state.chapters = chapters
      state.otherChapters = otherChapters
      const pins = pinsIn(note)
      // A stamp with no note text after it in the note: the whole note is about that moment.
      if (!pins.length && stamp) pins.push(...pinsIn(`${stamp} ${note.replace(STAMP, "").trim()}`))
      state.pins = pins.map((pin) => ({ ...pin, t: compare ? mapTime(pin.old, otherChapters, chapters) : placeOnAfter(pin, chapters) }))
      start()
    })
  }

  function layoutTimeline() {
    const { video, root, chapters, pins } = player
    const duration = video.duration
    if (!Number.isFinite(duration) || duration <= 0) return
    const at = (time) => `${Math.min(100, (100 * time) / duration)}%`
    root.querySelector(".q-ticks").innerHTML = chapters
      .map((chapter, index) => (index === 0 && chapter.t === 0 ? "" : `<button type="button" class="q-tick" data-index="${index}" data-t="${chapter.t}" style="left:${at(chapter.t)}" title="${esc(`${clock(chapter.t)} ${chapter.label}`)}"></button>`))
      .join("")
    root.querySelector(".q-pins").innerHTML = pins
      .map((pin) => `<button type="button" class="q-pin" data-t="${pin.t}" style="left:${at(pin.t)}" title="${esc(`${pin.stamp} ${pin.note}`)}"></button>`)
      .join("")
    root.querySelector(".q-segs").innerHTML = chapters
      .map((chapter, index) => {
        const end = chapters[index + 1]?.t ?? duration
        return `<button type="button" class="q-seg" data-index="${index}" data-t="${chapter.t}" style="left:${at(chapter.t)};width:${Math.max(0, (100 * (end - chapter.t)) / duration)}%" title="${esc(`${clock(chapter.t)} ${chapter.label}`)}">${esc(chapter.label)}</button>`
      })
      .join("")
    player.index = -2
    sync()
  }

  function sync() {
    const { video, other, root, chapters } = player
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const time = video.currentTime
    const fraction = duration ? Math.min(1, time / duration) : 0
    root.querySelector(".q-fill").style.width = `${fraction * 100}%`
    root.querySelector(".q-playhead").style.left = `${fraction * 100}%`
    root.querySelector(".q-time").innerHTML = `<b>${clock(time)}</b> / ${clock(duration)}`
    root.querySelector(".q-pp-label").textContent = video.paused || video.ended ? "Play" : "Pause"
    root.querySelector(".q-speed b").textContent = `${video.playbackRate}×`
    const index = chapterAt(time)
    if (index !== player.index) {
      player.index = index
      for (const element of root.querySelectorAll("[data-index]")) element.classList.toggle("on", Number(element.dataset.index) === index)
      root.querySelector(".q-chapter-now").textContent = chapters[index]?.label ?? ""
    }
    if (!other) {
      // One recording: Will's earlier note shows for two seconds around its moment.
      showPin(player.pins.find((entry) => Math.abs(entry.t - time) < 1))
      return
    }
    if (other.readyState < 1) return
    // The before recording follows: same moment, same speed, playing when the after one plays.
    const target = Math.min(mapTime(time, chapters, player.otherChapters), Number.isFinite(other.duration) ? other.duration : Infinity)
    const playing = !video.paused && !video.ended
    if (Math.abs(other.currentTime - target) > (playing ? 0.25 : 0.01)) other.currentTime = target
    if (other.playbackRate !== video.playbackRate) other.playbackRate = video.playbackRate
    if (playing && other.paused && target < other.duration) other.play().catch(() => {})
    if (!playing && !other.paused) other.pause()
    const [beforeTime, afterTime] = root.querySelectorAll(".q-pane-time")
    if (beforeTime) beforeTime.textContent = clock(target)
    if (afterTime) afterTime.textContent = clock(time)
    // Will's earlier note shows on the before recording for two seconds around its moment.
    showPin(player.pins.find((entry) => Math.abs(entry.old - target) < 1))
  }
  function showPin(pin) {
    const note = player.root.querySelector(".q-pin-note")
    if (!note) return
    note.hidden = !pin
    if (pin) note.innerHTML = `<b>${esc(pin.stamp)}</b> ${esc(pin.note)}`
  }
  // An old stamp on the new recording: its clock time, kept inside the chapter it names when that chapter exists.
  const placeOnAfter = (pin, chapters) => {
    const index = pin.label ? chapters.findIndex((chapter) => chapter.label === pin.label) : -1
    if (index < 0) return pin.old
    const end = chapters[index + 1]?.t ?? Infinity
    return pin.old >= chapters[index].t && pin.old < end ? pin.old : chapters[index].t
  }
  const notesOf = (item) => {
    const before = beforeOf(item)
    return { note: before?.note ?? item.verifies?.text ?? "", stamp: before?.stamp ?? "" }
  }

  function seek(time) {
    const { video } = player
    const duration = Number.isFinite(video.duration) ? video.duration : Infinity
    video.currentTime = Math.max(0, Math.min(duration, time))
    sync()
  }
  const playerKeys = {
    " ": () => {
      const { video } = player
      if (video.ended) video.currentTime = 0
      if (video.paused || video.ended) video.play().catch(() => {})
      else video.pause()
    },
    ArrowLeft: () => seek(player.video.currentTime - 2),
    ArrowRight: () => seek(player.video.currentTime + 2),
    ",": () => {
      player.video.pause()
      seek(player.video.currentTime - FRAME)
    },
    ".": () => {
      player.video.pause()
      seek(player.video.currentTime + FRAME)
    },
    "[": () => {
      const { chapters, video } = player
      const index = chapterAt(video.currentTime)
      if (index < 0) return seek(0)
      // Within a second of a chapter's start, go to the one before; otherwise back to this one's start.
      seek(video.currentTime - chapters[index].t > 1 ? chapters[index].t : chapters[Math.max(0, index - 1)].t)
    },
    "]": () => {
      const { chapters, video } = player
      const next = chapters[chapterAt(video.currentTime) + 1]
      if (next) seek(next.t)
    },
    "<": () => speed(-1),
    ">": () => speed(1),
    0: () => seek(0),
  }
  function speed(step) {
    const { video } = player
    const at = SPEEDS.reduce((best, value, index) => (Math.abs(value - video.playbackRate) < Math.abs(SPEEDS[best] - video.playbackRate) ? index : best), 0)
    video.playbackRate = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, at + step))]
  }
  const activePlayer = () => (player && player.video.isConnected && card?.contains(player.video) ? player : null)

  // A note on a recording starts with the moment it is about: "[02:14 Save] ".
  const STAMP = /\[\d+:\d{2}[^\]\n]*\]\s*/g
  const bare = (value) => String(value ?? "").replace(STAMP, "").trim()
  let stampAdded = ""
  function stampNote(area) {
    const active = activePlayer()
    if (!active) return
    active.video.pause()
    const label = active.chapters[chapterAt(active.video.currentTime)]?.label
    const stamp = `[${clock(active.video.currentTime)}${label ? ` ${label}` : ""}] `
    if (area.value.endsWith(stamp)) return
    stampAdded = `${area.value && !area.value.endsWith("\n") ? "\n" : ""}${stamp}`
    area.value += stampAdded
    store.set(draftKey(current.id), area.value)
    area.setSelectionRange(area.value.length, area.value.length)
  }
  function unstampNote(area) {
    if (stampAdded && area.value.endsWith(stampAdded)) {
      area.value = area.value.slice(0, -stampAdded.length)
      store.set(draftKey(current.id), area.value)
    }
    stampAdded = ""
  }

  // ---------------------------------------------------------------------------------------------------------
  // Before and after: the item's `before` and `after` media side by side (b cycles both, before, after), two
  // recordings on one timeline, or a diff for code.

  const one = (value) => (Array.isArray(value) ? value[0] : value) ?? null
  const isMedia = (value) => Boolean(value) && (typeof value.path === "string" || value.text != null)
  // The curator's contract: `before: { media, note, stamp }` (note and stamp: Will's earlier answer; media only when the
  // old recording or file was kept) and `after: { media }`. A bare media object in either place works too.
  const beforeOf = (item) => {
    const before = item?.before
    if (!before) return null
    const media = one(before.media) ?? (isMedia(before) ? before : null)
    return { media: isMedia(media) ? media : null, note: String(before.note ?? item.verifies?.text ?? ""), stamp: typeof before.stamp === "string" ? before.stamp : "" }
  }
  const afterOf = (item) => {
    const media = one(item?.after?.media) ?? (isMedia(item?.after) ? item.after : null) ?? one(item?.media)
    return isMedia(media) ? media : null
  }
  const saidOf = (item) => beforeOf(item)?.note || item?.verifies?.text || ""
  const comparing = (item) => Boolean(beforeOf(item)?.media && afterOf(item))
  const isCode = (media) => media.type === "code" || (media.type !== "html" && !IMAGE.has(extOf(media.path ?? "")) && !isVideo(media) && media.type !== "gif" && media.type !== "png")
  const compareKind = (item) => {
    const after = afterOf(item)
    return isVideo(after) ? "video" : isCode(after) ? "code" : "media"
  }
  const MODES = ["both", "before", "after"]
  let compareMode = "both"

  function renderCompare(item, subject) {
    const before = beforeOf(item).media
    const after = afterOf(item)
    const kind = compareKind(item)
    if (kind === "code") return renderDiff(item, before, after, subject)
    subject.innerHTML = `<div class="q-compare" data-mode="${compareMode}">${kind === "video" ? `<div class="q-player"></div>` : ""}</div>`
    const root = subject.querySelector(".q-compare")
    if (kind === "video") {
      renderPlayer(root.querySelector(".q-player"), after, { before, ...notesOf(item) })
      return syncMode(root)
    }
    const pane = (cls, label, media) => {
      const type = media.type || extOf(media.path)
      const name = media.path.split("/").pop()
      const body =
        type === "html"
          ? `<iframe class="q-frame" sandbox="allow-scripts" src="${esc(frameUrl(media.path))}" title="${esc(`${label}: ${name}`)}"></iframe>`
          : `<img class="q-img" src="${esc(fileUrl(media.path))}" alt="${esc(`${label}: ${name}`)}">`
      return `<figure class="q-pane ${cls}"><figcaption><b>${label}</b> <span class="q-path" title="${esc(media.path)}">${esc(name)}</span></figcaption><div class="q-media">${body}</div></figure>`
    }
    root.innerHTML = `<div class="q-panes">${pane("before", "Before", before)}${pane("after", "After", after)}</div><div class="q-transport"><span class="q-spacer"></span><span class="q-mode">${kbd("b")} <b>Both</b></span></div>`
    syncMode(root)
  }

  function cycleCompare() {
    const root = card?.querySelector(".q-compare")
    if (!root) return
    compareMode = MODES[(MODES.indexOf(compareMode) + 1) % MODES.length]
    syncMode(root)
  }
  function syncMode(root) {
    root.dataset.mode = compareMode
    const label = root.querySelector(".q-mode b")
    if (label) label.textContent = { both: "Both", before: "Before", after: "After" }[compareMode]
  }

  async function renderDiff(item, before, after, subject) {
    subject.innerHTML = `<div class="q-file-head"><span class="q-path">${esc(after.path ?? before.path ?? "")}</span><span class="q-range q-diff-count"></span></div><div class="q-code-scroll"><div class="q-code q-diff loading">Loading…</div></div>`
    const target = subject.querySelector(".q-diff")
    const textOf = async (media) => (media.text != null ? { ok: true, text: String(media.text) } : loadFile(media.path))
    const [old, now] = await Promise.all([textOf(before), textOf(after)])
    if (!target.isConnected) return
    target.classList.remove("loading")
    if (!old.ok || !now.ok) {
      target.innerHTML = `<p class="q-error">${esc(old.ok ? now.text : old.text)}</p>`
      return
    }
    const slice = (text, media) => {
      const lines = text.replace(/\r\n?/g, "\n").split("\n")
      if (lines.length > 1 && lines.at(-1) === "") lines.pop()
      const from = Math.max(1, Number(media.from) || 1)
      return { lines: lines.slice(from - 1, Number(media.to) || lines.length), from }
    }
    const a = slice(old.text, before)
    const b = slice(now.text, after)
    const ext = extOf(after.path ?? before.path ?? "")
    // Will's earlier line notes ("L42: …") mark those lines on the old side.
    const pinned = new Map()
    for (const match of saidOf(item).matchAll(/\bL(\d+)(?:[-–]L?(\d+))?:?\s*([^\n]*)/g))
      for (let line = Number(match[1]); line <= Number(match[2] ?? match[1]); line++) pinned.set(line, match[3].trim())
    const line = (text) => tokens(text, ext).map(([cls, value]) => (cls ? `<span class="t${cls}">${esc(value)}</span>` : esc(value))).join("") || " "
    const ops = diffLines(a.lines, b.lines)
    let added = 0
    let removed = 0
    const rows = []
    const CONTEXT = 3
    const changed = ops.map((op) => op[0] !== "=")
    const near = (index) => changed.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some(Boolean)
    for (let index = 0; index < ops.length; index++) {
      const [kind, i, j] = ops[index]
      if (kind === "=" && !near(index)) {
        let end = index
        while (end + 1 < ops.length && ops[end + 1][0] === "=" && !near(end + 1)) end++
        rows.push(`<div class="q-line q-fold"><span class="q-ln"></span><span class="q-ln"></span><span class="q-sign"></span><span class="q-lc">⋯ ${end - index + 1} unchanged</span></div>`)
        index = end
        continue
      }
      const oldNumber = i >= 0 ? i + a.from : ""
      const newNumber = j >= 0 ? j + b.from : ""
      if (kind === "+") added++
      if (kind === "-") removed++
      const note = oldNumber !== "" && pinned.has(oldNumber) ? pinned.get(oldNumber) : null
      rows.push(
        `<div class="q-line ${kind === "+" ? "add" : kind === "-" ? "del" : "ctx"}${note != null ? " pinned" : ""}"${note ? ` title="${esc(`L${oldNumber}: ${note}`)}"` : ""}><span class="q-ln">${oldNumber}</span><a class="q-ln"${newNumber !== "" ? ` data-line="${newNumber}"` : ""}>${newNumber}</a><span class="q-sign">${kind === "=" ? " " : kind}</span><span class="q-lc">${line(kind === "+" ? b.lines[j] : a.lines[i])}</span></div>`,
      )
      if (note) rows.push(`<div class="q-line q-pin-row"><span class="q-ln"></span><span class="q-ln"></span><span class="q-sign"></span><span class="q-lc">You said: ${esc(note)}</span></div>`)
    }
    target.innerHTML = rows.join("") || `<p class="q-empty-subject">No change.</p>`
    subject.querySelector(".q-diff-count").innerHTML = `<span class="q-add-count">+${added}</span> <span class="q-del-count">−${removed}</span>`
  }

  // A line diff: the longest common subsequence of the lines between a shared head and tail.
  function diffLines(a, b) {
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    let endA = a.length
    let endB = b.length
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--
      endB--
    }
    const ops = []
    for (let index = 0; index < start; index++) ops.push(["=", index, index])
    const n = endA - start
    const m = endB - start
    if (n * m > 25_000_000) {
      for (let index = start; index < endA; index++) ops.push(["-", index, -1])
      for (let index = start; index < endB; index++) ops.push(["+", -1, index])
    } else {
      const width = m + 1
      const table = new Uint32Array((n + 1) * width)
      for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--) table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (a[start + i] === b[start + j]) ops.push(["=", start + i++, start + j++])
        else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) ops.push(["-", start + i++, -1])
        else ops.push(["+", -1, start + j++])
      }
      while (i < n) ops.push(["-", start + i++, -1])
      while (j < m) ops.push(["+", -1, start + j++])
    }
    for (let index = 0; endA + index < a.length; index++) ops.push(["=", endA + index, endB + index])
    return ops
  }

  // ---------------------------------------------------------------------------------------------------------
  // Syntax colour, by hand: comments, strings, numbers, keywords, types and calls.

  const JS_KW = new Set(
    "as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield declare keyof infer namespace abstract override".split(" "),
  )
  const GO_KW = new Set("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota".split(" "))
  const PY_KW = new Set("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield".split(" "))
  const RS_KW = new Set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split(" "))
  const C_LIKE = /(\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*)|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\[\s\S]|[^`\\])*`?)|(\b0x[\da-fA-F_]+n?\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b)|([A-Za-z_$][\w$]*)/g
  const HASH = /(#[^\n]*)|("""[\s\S]*?(?:"""|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][\w]*)/g
  const CSS = /(\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|rem|em|ms|s|%|vh|vw|fr|deg)?\b)|(--[\w-]+|@[\w-]+|[a-z-]+(?=\s*:))/g
  const MARKUP = /(<!--[\s\S]*?(?:-->|$))|("(?:[^"\n])*"?|'(?:[^'\n])*'?)|(&\w+;)|(<\/?[\w-]+|\/?>)/g
  const MD = /(^#{1,6} [^\n]*)|(`[^`\n]*`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]*\]\([^)\n]*\))/gm
  const JSON_RE = /("(?:\\.|[^"\\\n])*"(?=\s*:))|("(?:\\.|[^"\\\n])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)/g

  function tokens(text, ext) {
    const out = []
    let last = 0
    const push = (cls, value) => value && out.push([cls, value])
    const run = (re, classify) => {
      re.lastIndex = 0
      let match
      while ((match = re.exec(text))) {
        if (match[0] === "") {
          re.lastIndex++
          continue
        }
        push("", text.slice(last, match.index))
        push(classify(match, re.lastIndex), match[0])
        last = re.lastIndex
      }
      push("", text.slice(last))
    }
    const word = (keywords) => (match, end) => {
      if (match[1]) return "c"
      if (match[2]) return "s"
      if (match[3]) return "n"
      const name = match[4]
      if (keywords.has(name)) return "k"
      if (/^[A-Z]/.test(name)) return "t"
      if (text[end] === "(") return "f"
      return ""
    }
    if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "swift", "zig", "java", "c", "h", "cc", "cpp", "kt", "scala"].includes(ext)) run(C_LIKE, word(JS_KW))
    else if (ext === "go") run(C_LIKE, word(GO_KW))
    else if (ext === "rs") run(C_LIKE, word(RS_KW))
    else if (["py", "sh", "bash", "zsh", "toml", "yaml", "yml", "nix", "bzl", "star"].includes(ext)) run(HASH, word(PY_KW))
    else if (["css", "scss", "less"].includes(ext)) run(CSS, (match) => (match[1] ? "c" : match[2] ? "s" : match[3] ? "n" : "k"))
    else if (["html", "htm", "xml", "svg", "vue"].includes(ext)) run(MARKUP, (match) => (match[1] ? "c" : match[2] ? "s" : match[3] ? "n" : "k"))
    else if (["md", "mdx"].includes(ext)) run(MD, (match) => (match[1] ? "k" : match[2] ? "s" : match[3] ? "t" : "f"))
    else if (["json", "jsonc", "jsonl"].includes(ext)) run(JSON_RE, (match) => (match[1] ? "k" : match[2] ? "s" : match[3] ? "n" : "t"))
    else push("", text)
    return out
  }

  // The file's tokens per line, [class, text]; a token that spans lines is split per line.
  function lineTokens(text, path) {
    const lines = [[]]
    for (const [cls, value] of tokens(text.replace(/\r\n?/g, "\n"), extOf(path))) {
      value.split("\n").forEach((part, index) => {
        if (index > 0) lines.push([])
        if (part) lines.at(-1).push([cls, part])
      })
    }
    if (lines.length > 1 && lines.at(-1).length === 0) lines.pop()
    return lines
  }

  // Lines from..to (1-based, inclusive) with their real numbers.
  function codeHtml(text, path, from, to) {
    const lines = lineTokens(text, path)
    const start = Math.max(1, Number(from) || 1)
    const end = Math.min(lines.length, Number(to) || lines.length)
    const rows = []
    for (let number = start; number <= end; number++)
      rows.push(`<div class="q-line"><a class="q-ln" data-line="${number}">${number}</a><span class="q-lc">${lines[number - 1].map(([cls, value]) => (cls ? `<span class="t${cls}">${esc(value)}</span>` : esc(value))).join("") || " "}</span></div>`)
    return rows.join("")
  }

  // ---------------------------------------------------------------------------------------------------------
  // Showing an item, with the slide.

  function show(item, direction = "up") {
    const old = card
    picked = null
    scopeAll = item ? store.get(scopeKey(item.id)) === "all" : false
    fileIndex = 0
    mediaIndex = 0
    linkIndex = -1
    closeViewer()
    player = null
    view = null
    codeToken = null
    stampAdded = ""
    current = item
    if (!item) {
      card = document.createElement("article")
      card.className = "q-card q-empty"
      card.dataset.missing = String(missing)
      card.innerHTML = missing
        ? `<h1 class="q-title">No queue yet</h1><p class="q-why">The curator writes queue/queue.json; this page updates when it lands.</p>`
        : `<h1 class="q-title">Queue empty</h1><p class="q-why">${stats.doneToday} done today.</p>`
    } else card = render(item)
    card.classList.toggle("scope-all", scopeAll)
    stage.append(card)
    if (old) leave(old, direction)
    if (!reduced.matches) {
      card.classList.add(direction === "up" ? "enter-up" : "enter-down")
      requestAnimationFrame(() => requestAnimationFrame(() => card?.classList.remove("enter-up", "enter-down")))
    }
    header()
    footer()
    if (item) prefetch(item)
    const following = next()
    if (following) prefetch(following)
  }

  function leave(element, direction) {
    element.querySelector("video")?.pause()
    element.classList.add("leaving", direction === "up" ? "leave-up" : "leave-down")
    element.setAttribute("aria-hidden", "true")
    element.inert = true
    setTimeout(() => element.remove(), reduced.matches ? 0 : MOVE_MS + 40)
  }

  // ---------------------------------------------------------------------------------------------------------
  // Answering.

  async function submit(action, option) {
    if (!current || current.id === undefined) return
    const item = current
    const text = box()?.value ?? ""
    const scope = scopeAll
    const answer = { itemId: item.id, action, ...(action === "option" ? { option } : {}), ...(scope ? { scope: "all", kind: item.kind } : {}), text: bare(text) ? text.trim() : "", revision: item.revision ?? null, commit: item.commit ?? null, addedAt: item.addedAt ?? null, title: item.title }
    inFlight.add(item.id)
    items = items.filter((entry) => entry.id !== item.id)
    // Its own record: an earlier answer that fails later removes only itself.
    const { promise: settled, resolve: settle } = Promise.withResolvers()
    const record = { item, text, scope, saved: false, settled }
    sent.push(record)
    stats = { ...stats, doneToday: stats.doneToday + (action === "later" ? 0 : 1) }
    show(next(item.id), "up")
    try {
      await api("/api/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(answer) })
      record.saved = true
      store.set(draftKey(item.id), "")
      store.set(scopeKey(item.id), "")
      if (scope) say(`Sent for ${allOf(item.kind)}`)
      setTimeout(updateBetweenItems, MOVE_MS + 60)
    } catch (error) {
      // Not saved: put the item back first in line with his text, and under his hands unless he has started on the
      // card that replaced it. If the curator replaced the item, it comes back as the new version.
      const shown = error.status === 409 && error.body?.item?.id === item.id ? error.body.item : item
      inFlight.delete(item.id)
      sent.splice(sent.indexOf(record), 1)
      stats = { ...stats, doneToday: Math.max(0, stats.doneToday - (action === "later" ? 0 : 1)) }
      items = [shown, ...items.filter((entry) => entry.id !== item.id)]
      store.set(draftKey(item.id), text)
      const back = !current || !(hasDraft() || picked)
      if (back) show(shown, "down")
      else {
        header()
        footer()
      }
      say(shown === item ? `Not saved: ${error.message}` : `Not saved: the item changed since you opened it. ${back ? "This is" : "Next is"} the new version.`, true)
    } finally {
      settle()
    }
  }

  async function undo() {
    // Undo follows the newest answer onto the server's stack: wait for one still sending, and skip it if it fails.
    let local = sent.at(-1)
    while (local && !local.saved) {
      await local.settled
      local = sent.at(-1)
    }
    const itemId = local?.item.id ?? serverLast?.itemId
    if (!itemId) return say("Nothing to undo")
    try {
      await api("/api/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId, action: "undo", text: "" }) })
    } catch (error) {
      return say(`Undo failed: ${error.message}`, true)
    }
    if (local) {
      sent.splice(sent.indexOf(local), 1)
      if (local.text && !store.get(draftKey(itemId))) store.set(draftKey(itemId), local.text)
      if (local.scope) store.set(scopeKey(itemId), "all")
    }
    inFlight.delete(itemId)
    // Hold Will's current text before the item changes.
    if (current) store.set(draftKey(current.id), box()?.value ?? "")
    const [queue, freshStats] = await Promise.all([api("/api/queue"), api("/api/stats")]).catch(() => [null, null])
    if (queue) {
      items = queue.items.filter((item) => !inFlight.has(item.id))
      serverLast = queue.last
      stats = freshStats
    }
    const back = items.find((item) => item.id === itemId) ?? local?.item
    if (back && !items.some((item) => item.id === back.id)) items.unshift(back)
    show(back ?? items[0] ?? null, "down")
    say(`Undone: ${back?.title ?? itemId}`)
  }

  // An action key or click: empty box sends at once; with text, a key picks and ⌘Enter sends.
  function act(action, option, { click = false } = {}) {
    if (!current) return
    if (action === "option" && !(current.options ?? []).some((entry, index) => (entry.key ?? String(index + 1)) === option)) return
    const text = bare(box()?.value)
    if (action === "changes" && !text && !click) {
      pick(action, option)
      box()?.focus()
      return
    }
    if (!text || click) return submit(action, option)
    pick(action, option)
  }

  function toggleScope() {
    if (!current) return
    scopeAll = !scopeAll
    store.set(scopeKey(current.id), scopeAll ? "all" : "")
    card.classList.toggle("scope-all", scopeAll)
  }

  function pick(action, option) {
    picked = { action, option }
    for (const button of card.querySelectorAll("[data-action]"))
      button.classList.toggle("picked", button.dataset.action === action && (action !== "option" || button.dataset.option === option))
    card.classList.add("has-pick")
  }

  function sendWithText() {
    if (!current) return
    if (picked) return submit(picked.action, picked.option)
    if (!hasDraft()) return
    submit("changes")
  }

  // ---------------------------------------------------------------------------------------------------------
  // Inline viewer for links (o) and repository paths in the context.

  async function openViewer(path, label) {
    viewer.hidden = false
    const ext = extOf(path)
    const name = path.split("/").pop()
    const links = linkList()
    const counter = links.length > 1 && linkIndex >= 0 ? `<span class="q-range">${linkIndex + 1} / ${links.length} ${kbd("o")}</span>` : ""
    viewer.innerHTML = `<div class="q-viewer-box" role="dialog" aria-label="${esc(label || name)}"><div class="q-file-head"><span class="q-path">${esc(label && label !== path ? `${label} · ${path}` : path)}</span>${counter}<span class="q-close">${kbd("Esc")}</span></div><div class="q-viewer-body"><div class="q-code loading">Loading…</div></div></div>`
    const body = viewer.querySelector(".q-viewer-body")
    if (ext === "html") body.innerHTML = `<iframe class="q-frame" sandbox="allow-scripts" src="${esc(frameUrl(path))}" title="${esc(name)}"></iframe>`
    else if (IMAGE.has(ext)) body.innerHTML = `<div class="q-media"><img class="q-img" src="${esc(fileUrl(path))}" alt="${esc(name)}"></div>`
    else {
      const result = await loadFile(path)
      if (viewer.hidden) return
      body.innerHTML = result.ok ? `<div class="q-code">${codeHtml(result.text, path)}</div>` : `<p class="q-error">${esc(result.text)}</p>`
    }
  }
  function closeViewer() {
    viewer.hidden = true
    viewer.innerHTML = ""
  }
  const linkList = () => {
    const source = sourceOf(current)
    return [...(source ? [{ label: "Source", path: source.path }] : []), ...(current?.links ?? [])]
  }
  function cycleLink() {
    const links = linkList()
    if (!links.length) return
    linkIndex = (linkIndex + 1) % links.length
    openViewer(links[linkIndex].path, links[linkIndex].label)
  }

  // ---------------------------------------------------------------------------------------------------------
  // Key sheet, toast, scrolling, full screen.

  const SHEET = [
    ["1–4", "Choose an option"],
    ["a", "Approve, looks good"],
    ["r", "Request changes (types in the box)"],
    ["l", "Later: snooze 24 hours"],
    ["u", "Undo the last answer"],
    ["i  /", "Type in the box"],
    ["Esc", "Leave the box"],
    ["⌘ Enter", "Send with text"],
    ["j k  ↓ ↑", "Scroll"],
    ["J K", "Next or previous file"],
    ["n p", "Next or previous media"],
    ["o", "Open a referenced file"],
    ["c", "Hide or show comments in code"],
    ["z Z", "Fold every body, or unfold all"],
    ["O", "Outline: filter, ↑ ↓ pick, Enter jumps"],
    ["g", "The note applies to every item of this kind"],
    ["b", "Before and after: both, before, after"],
    ["space", "Play or pause a recording"],
    ["← →", "Back or ahead 2 seconds"],
    [", .", "Back or ahead one frame"],
    ["[ ]", "Previous or next chapter"],
    ["< >", "Slower or faster, 0.5× to 2×"],
    ["0", "Back to the start"],
    ["f", "Full screen"],
    ["?", "This sheet"],
  ]
  function toggleSheet(force) {
    const open = force ?? sheet.hidden
    sheet.hidden = !open
    if (open)
      sheet.innerHTML = `<div class="q-sheet-box" role="dialog" aria-label="Keys"><h2>Keys</h2><dl>${SHEET.map(([key, label]) => `<div><dt>${key.split(/\s{2}/).map((part) => part.split(" ").map(kbd).join(" ")).join(" ")}</dt><dd>${esc(label)}</dd></div>`).join("")}</dl><p>With an empty box an action key sends at once. With text in the box it picks; ${kbd("⌘")} ${kbd("Enter")} sends.</p></div>`
  }

  let toastTimer = null
  function say(message, error = false) {
    toast.textContent = message
    toast.classList.toggle("error", error)
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.hidden = true), error ? 6000 : 2200)
  }

  const scroller = () => {
    if (!viewer.hidden) return viewer.querySelector(".q-viewer-body")
    const code = card?.querySelector(".q-code-scroll") ?? card?.querySelector(".q-doc")
    if (code) return code
    return card?.querySelector(".q-subject") ?? card?.querySelector(".q-side")
  }
  function scroll(lines) {
    const element = scroller()
    if (!element) return
    // An iframe scrolls itself; Will clicks into it for that.
    element.scrollBy({ top: lines * 22, behavior: reduced.matches ? "auto" : "smooth" })
  }

  function fullScreen() {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    else document.documentElement.requestFullscreen?.().catch(() => {})
  }

  function switchFile(step) {
    if (!current?.files?.length || current.files.length < 2) return
    fileIndex = (fileIndex + step + current.files.length) % current.files.length
    renderCode(current, card.querySelector(".q-subject"))
    footer()
  }
  function switchMedia(step) {
    if (!current?.media?.length || current.media.length < 2 || comparing(current)) return
    linkIndex = -1
    mediaIndex = (mediaIndex + step + current.media.length) % current.media.length
    renderMedia(current, card.querySelector(".q-subject"))
    footer()
  }

  // ---------------------------------------------------------------------------------------------------------
  // Input.

  document.addEventListener("keydown", (event) => {
    // The outline's filter: ↑ ↓ pick a symbol, Enter jumps to it and hands the keys back to the queue.
    if (event.target instanceof HTMLInputElement && event.target.classList.contains("q-outline-filter") && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        return pickSymbol(event.key === "ArrowDown" ? 1 : -1)
      }
      if (event.key === "Enter") {
        event.preventDefault()
        event.target.blur()
        return openSymbol(view?.selected ?? 0)
      }
    }
    const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement
    const send = event.key === "Enter" && (event.metaKey || event.ctrlKey)
    if (typing) {
      if (event.key === "Escape") {
        event.preventDefault()
        event.target.blur()
      } else if (send) {
        event.preventDefault()
        sendWithText()
      }
      return
    }
    if (send) {
      event.preventDefault()
      return sendWithText()
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (!sheet.hidden) {
      if (event.key === "Escape" || event.key === "?") {
        event.preventDefault()
        toggleSheet(false)
      }
      return
    }
    if (!viewer.hidden) {
      const handled = { Escape: closeViewer, o: cycleLink, j: () => scroll(3), k: () => scroll(-3), ArrowDown: () => scroll(3), ArrowUp: () => scroll(-3), f: fullScreen }[event.key]
      if (handled) {
        event.preventDefault()
        handled()
      }
      return
    }
    const key = event.key
    if (Object.hasOwn(playerKeys, key) && activePlayer()) {
      event.preventDefault()
      return playerKeys[key]()
    }
    const handlers = {
      a: () => act("approve"),
      r: () => act("changes"),
      l: () => act("later"),
      u: undo,
      i: () => box()?.focus(),
      "/": () => box()?.focus(),
      j: () => scroll(3),
      k: () => scroll(-3),
      ArrowDown: () => scroll(3),
      ArrowUp: () => scroll(-3),
      J: () => switchFile(1),
      K: () => switchFile(-1),
      n: () => switchMedia(1),
      p: () => switchMedia(-1),
      o: cycleLink,
      c: toggleComments,
      z: () => foldAll(true),
      Z: () => foldAll(false),
      O: toggleOutline,
      g: toggleScope,
      b: cycleCompare,
      f: fullScreen,
      "?": () => toggleSheet(true),
      Escape: () => {
        if (picked) {
          picked = null
          card?.classList.remove("has-pick")
          for (const button of card?.querySelectorAll(".picked") ?? []) button.classList.remove("picked")
        }
      },
    }
    if (/^[1-9]$/.test(key)) {
      event.preventDefault()
      return act("option", key)
    }
    const handler = handlers[key]
    if (!handler) return
    event.preventDefault()
    handler()
  })

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    if (target === viewer) return closeViewer()
    if (target === sheet || target.closest(".q-sheet")) return toggleSheet(false)
    // The player: a chapter or tick seeks to its start, the bar to where it was clicked.
    if (activePlayer() && player.root.contains(target)) {
      const mark = target.closest("[data-t]")
      if (mark) return seek(Number(mark.dataset.t))
      const bar = target.closest("[data-seek]")
      if (bar) {
        const rect = bar.getBoundingClientRect()
        const duration = player.video.duration
        if (Number.isFinite(duration)) seek(((event.clientX - rect.left) / rect.width) * duration)
        return
      }
      if (target.closest("[data-player=toggle]")) return playerKeys[" "]()
    }
    const button = target.closest("[data-action]")
    if (button && card?.contains(button)) return act(button.dataset.action, button.dataset.option, { click: true })
    const tab = target.closest("[data-file]")
    if (tab && card?.contains(tab)) {
      fileIndex = Number(tab.dataset.file)
      renderCode(current, card.querySelector(".q-subject"))
      return footer()
    }
    // The code tools, a fold's chevron or dots, a row of the outline, a line reference in the guide.
    const tool = target.closest("[data-tool]")
    if (tool && card?.contains(tool)) return { comments: toggleComments, fold: () => foldAll(true), unfold: () => foldAll(false), outline: toggleOutline }[tool.dataset.tool]?.()
    const fold = target.closest("[data-fold]")
    if (fold && card?.contains(fold)) return toggleFold(Number(fold.dataset.fold))
    const symbol = target.closest("[data-sym]")
    if (symbol && card?.contains(symbol)) return openSymbol(Number(symbol.dataset.sym))
    const ref = target.closest("a.q-ref")
    if (ref && card?.contains(ref)) {
      event.preventDefault()
      return goToLine(Number(ref.dataset.refFile), Number(ref.dataset.refLine))
    }
    // Links in a rendered README open in a new tab; its own #anchors scroll the page.
    const docLink = target.closest(".q-md a[href]")
    if (docLink && card?.contains(docLink)) {
      const href = docLink.getAttribute("href")
      if (href.startsWith("#")) {
        event.preventDefault()
        let id = href.slice(1)
        try {
          id = decodeURIComponent(id)
        } catch {}
        ;[...card.querySelectorAll(".q-md [id]")].find((element) => element.id === id)?.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" })
      }
      return
    }
    const link = target.closest("[data-link]")
    if (link && card?.contains(link)) {
      linkIndex = Number(link.dataset.link) + (sourceOf(current) ? 1 : 0)
      return openViewer(current.links[linkIndex].path, current.links[linkIndex].label)
    }
    // A line number starts a note about that line.
    const line = target.closest(".q-ln")
    if (line && card?.contains(line)) {
      const area = box()
      if (!area) return
      const file = current.files?.[fileIndex]
      const prefix = `${area.value && !area.value.endsWith("\n") ? "\n" : ""}${current.files?.length > 1 && file ? `${file.path.split("/").pop()} ` : ""}L${line.dataset.line}: `
      area.value += prefix
      area.dispatchEvent(new Event("input", { bubbles: true }))
      area.focus()
      area.setSelectionRange(area.value.length, area.value.length)
      return
    }
    const anchor = target.closest("a.file")
    if (anchor && card?.contains(anchor)) {
      event.preventDefault()
      return openViewer(anchor.getAttribute("title") || new URL(anchor.href).searchParams.get("path"))
    }
  })

  // Typing about a recording pins the moment: the video pauses and the note starts with its time and chapter.
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLTextAreaElement && card?.contains(event.target)) stampNote(event.target)
  })
  document.addEventListener("focusout", (event) => {
    if (event.target instanceof HTMLTextAreaElement && card?.contains(event.target)) unstampNote(event.target)
  })

  // Drafts survive reloads and crashes.
  document.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.classList.contains("q-outline-filter") && view) {
      view.selected = 0
      return renderOutline()
    }
    if (event.target instanceof HTMLTextAreaElement && current && card?.contains(event.target)) {
      store.set(draftKey(current.id), event.target.value)
      if (!bare(event.target.value) && picked) {
        picked = null
        card.classList.remove("has-pick")
        for (const button of card.querySelectorAll(".picked")) button.classList.remove("picked")
      }
    }
  })

  // ---------------------------------------------------------------------------------------------------------
  // Live updates.

  let source = null
  let clientVersion = null
  let updateReady = false
  // A new version of this page loads between items, never under Will's hands; drafts live in localStorage.
  function updateBetweenItems() {
    if (!updateReady || hasDraft() || picked) return
    if (current) history.replaceState(null, "", `#${encodeURIComponent(current.id)}`)
    location.reload()
  }
  function listen() {
    source?.close()
    source = new EventSource("/api/events")
    source.addEventListener("queue", () => refresh())
    source.addEventListener("client", (event) => {
      const { version } = JSON.parse(event.data)
      clientVersion ??= version
      if (version !== clientVersion) updateReady = true
    })
    source.addEventListener("open", () => refresh())
  }
  // A click into a design's frame sends keys there; say so until focus comes back.
  addEventListener("blur", () =>
    setTimeout(() => {
      if (document.activeElement instanceof HTMLIFrameElement) document.body.classList.add("frame-focus")
    }),
  )
  addEventListener("focus", () => document.body.classList.remove("frame-focus"))

  // `#<item id>` jumps to that item, for links from elsewhere.
  addEventListener("hashchange", () => {
    const wanted = decodeURIComponent(location.hash.slice(1))
    const item = items.find((entry) => entry.id === wanted)
    if (item && item.id !== current?.id) show(item, "up")
  })

  listen()
  refresh()
  window.__queue = { get current() {
    return current
  }, get items() {
    return items
  } }
})()
