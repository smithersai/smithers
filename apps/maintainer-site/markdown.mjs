// A small CommonMark + GFM renderer: headings, paragraphs, nested lists, task items, tables, fenced and
// indented code, blockquotes and GitHub alerts, links, reference links, images, autolinks, wikilinks,
// emphasis, strikethrough, inline code and hard breaks. Raw HTML is sanitized to an allowlist; everything
// else is escaped.
//
//   renderMarkdown(source, { link, image, wikilink }) → { html, title, headings, sections, links }
//
// `link(href)` and `image(src)` resolve a destination as written; `wikilink(target)` resolves `[[target]]`.
// Each returns { href, cls?, title?, note?, anchor? } (href null renders an unlinked, broken reference).
// A returned `note` is recorded in `links` with the text of the block it came from, for backlinks.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char])

// Text keeps valid character references (`&amp;`, `&#8212;`) and escapes everything else.
const ENTITY = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/
const escapeText = (value) =>
  String(value).replace(/[&<>"']/g, (char, index, all) => (char === "&" && ENTITY.test(all.slice(index)) ? "&" : ESCAPES[char]))

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©" }
export const decodeEntities = (value) =>
  value.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�"
    }
    return NAMED[name] ?? match
  })

export const htmlToText = (html) =>
  decodeEntities(html.replace(/<(?:br|\/p|\/li|\/h[1-6]|\/tr|\/td|\/th|\/pre|\/blockquote)\b[^>]*>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim()

// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, duplicates numbered.
export const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-")

const SAFE_URL = /^(?:[a-z][a-z0-9+.-]*:)/i
export const safeUrl = (url) => {
  const trimmed = String(url).trim()
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  const scheme = trimmed.match(SAFE_URL)?.[0].toLowerCase()
  if (!scheme) return trimmed
  if (["http:", "https:", "mailto:", "tel:"].includes(scheme)) return trimmed
  if (scheme === "data:" && /^data:image\/(?:png|gif|jpe?g|webp);/i.test(trimmed)) return trimmed
  return null
}

// ---------------------------------------------------------------------------------------------------------
// HTML sanitizing: allowlisted tags and attributes survive; every other `<`, `>` and quote is escaped.

const ALLOWED_TAGS = new Set(
  "a abbr b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q s samp small source span strong sub summary sup table tbody td tfoot th thead tr u ul var".split(
    " ",
  ),
)
const ALLOWED_ATTRS = new Set(["align", "title", "alt", "width", "height", "colspan", "rowspan", "start", "open", "name"])
const URL_ATTRS = new Set(["href", "src", "srcset"])
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

const sanitizeTag = (match, ctx) => {
  const [, close, rawName, attrs, selfClose] = match
  const name = rawName.toLowerCase()
  if (!ALLOWED_TAGS.has(name)) return escapeText(match[0])
  if (close) return `</${name}>`
  const kept = []
  for (const [, rawKey, double, single, bare] of attrs.matchAll(ATTR)) {
    const key = rawKey.toLowerCase()
    const value = decodeEntities(double ?? single ?? bare ?? "")
    if (URL_ATTRS.has(key)) {
      if (key === "srcset") continue
      const resolved = key === "src" ? ctx.image(value) : ctx.link(value)
      if (resolved?.href) kept.push(`${key}="${escapeHtml(resolved.href)}"`)
      if (key === "href" && resolved?.cls) kept.push(`class="${escapeHtml(resolved.cls)}"`)
    } else if (ALLOWED_ATTRS.has(key)) kept.push(double === undefined && single === undefined && bare === undefined ? key : `${key}="${escapeHtml(value)}"`)
  }
  return `<${name}${kept.map((attr) => ` ${attr}`).join("")}${selfClose ? " /" : ""}>`
}

export const sanitizeHtml = (html, ctx) => {
  let out = ""
  let index = 0
  const source = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
  while (index < source.length) {
    const char = source[index]
    if (char === "<") {
      TAG.lastIndex = index
      const match = TAG.exec(source)
      if (match) {
        out += sanitizeTag(match, ctx)
        index += match[0].length
        continue
      }
    }
    out += char === "&" ? (ENTITY.test(source.slice(index)) ? "&" : "&amp;") : (ESCAPES[char] ?? char)
    index++
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Blocks.

const isBlank = (line) => /^[ \t]*$/.test(line)
const indentOf = (line) => line.match(/^ */)[0].length
const expandTabs = (line) => {
  if (!line.includes("\t")) return line
  let out = ""
  for (const char of line) out += char === "\t" ? " ".repeat(4 - (out.length % 4)) : char
  return out
}

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const QUOTE = /^ {0,3}> ?/
const BULLET = /^( {0,3})([-+*])(?:([ \t]+)(.*)|$)/
const ORDERED = /^( {0,3})(\d{1,9})([.)])(?:([ \t]+)(.*)|$)/
const BLOCK_TAGS =
  "address|article|aside|blockquote|body|center|details|dialog|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|section|summary|table|tbody|td|tfoot|th|thead|tr|ul"
const HTML_RAW = /^ {0,3}<(pre|script|style|textarea)(?:[\s>]|$)/i
const HTML_COMMENT = /^ {0,3}<!--/
const HTML_BLOCK = new RegExp(`^ {0,3}</?(?:${BLOCK_TAGS})(?:[\\s/>]|$)`, "i")
const HTML_ANY = /^ {0,3}<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>\s*$/
const DEFINITION = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/

const listMarker = (line) => {
  let match = line.match(BULLET)
  if (match) {
    const [, indent, marker, spaces = "", rest = ""] = match
    return { ordered: false, marker, indent: indent.length, width: 1, spaces: spaces.length, rest }
  }
  match = line.match(ORDERED)
  if (match) {
    const [, indent, number, delimiter, spaces = "", rest = ""] = match
    return { ordered: true, marker: delimiter, start: Number(number), indent: indent.length, width: number.length + 1, spaces: spaces.length, rest }
  }
  return null
}

const splitRow = (line) => {
  let row = line.trim()
  if (row.startsWith("|")) row = row.slice(1)
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1)
  const cells = []
  let cell = ""
  for (let index = 0; index < row.length; index++) {
    if (row[index] === "\\" && row[index + 1] === "|") {
      cell += "|"
      index++
    } else if (row[index] === "|") {
      cells.push(cell.trim())
      cell = ""
    } else cell += row[index]
  }
  cells.push(cell.trim())
  return cells
}

const delimiterRow = (line) => {
  if (!line || !line.includes("-") || !/^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line)) return null
  return splitRow(line).map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""))
}

const startsTable = (lines, index) => {
  const header = lines[index]
  if (!header.includes("|")) return false
  const align = delimiterRow(lines[index + 1])
  return align !== null && align.length === splitRow(header).length
}

// Whether a line ends a paragraph (CommonMark's "can interrupt a paragraph").
const interrupts = (line) => {
  if (ATX.test(line) || HR.test(line) || QUOTE.test(line) || HTML_RAW.test(line) || HTML_COMMENT.test(line) || HTML_BLOCK.test(line)) return true
  const fence = line.match(FENCE)
  if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) return true
  const marker = listMarker(line)
  return marker !== null && marker.rest.trim() !== "" && (!marker.ordered || marker.start === 1)
}

export function parseBlocks(lines, refs) {
  const blocks = []
  let index = 0
  let blank = false
  const push = (block) => {
    block.blankBefore = blank && blocks.length > 0
    blocks.push(block)
    blank = false
  }
  while (index < lines.length) {
    const line = lines[index]
    if (isBlank(line)) {
      blank = true
      index++
      continue
    }

    const fence = line.match(FENCE)
    if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) {
      const [, indent, marker, info] = fence
      const body = []
      index++
      while (index < lines.length) {
        const close = lines[index].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
          index++
          break
        }
        body.push(lines[index].replace(new RegExp(`^ {0,${indent.length}}`), ""))
        index++
      }
      push({ type: "code", lang: info.trim().split(/\s+/)[0] ?? "", text: body.join("\n") })
      continue
    }

    const atx = line.match(ATX)
    if (atx) {
      push({ type: "heading", level: atx[1].length, text: (atx[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim() })
      index++
      continue
    }

    if (HR.test(line)) {
      push({ type: "hr" })
      index++
      continue
    }

    if (QUOTE.test(line)) {
      const body = []
      while (index < lines.length) {
        const next = lines[index]
        if (QUOTE.test(next)) body.push(next.replace(QUOTE, ""))
        else if (!isBlank(next) && body.length > 0 && !isBlank(body.at(-1)) && !interrupts(next)) body.push(next)
        else break
        index++
      }
      const alert = body[0]?.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i)
      push({ type: "quote", alert: alert ? alert[1].toLowerCase() : null, children: parseBlocks(alert ? body.slice(1) : body, refs) })
      continue
    }

    if (HTML_RAW.test(line) || HTML_COMMENT.test(line) || HTML_BLOCK.test(line) || HTML_ANY.test(line)) {
      const raw = line.match(HTML_RAW)
      const end = raw ? new RegExp(`</${raw[1]}>`, "i") : HTML_COMMENT.test(line) ? /-->/ : null
      const body = []
      while (index < lines.length) {
        const next = lines[index]
        if (!end && isBlank(next)) break
        body.push(next)
        index++
        if (end && end.test(next)) break
      }
      push({ type: "html", html: body.join("\n") })
      continue
    }

    const marker = listMarker(line)
    if (marker) {
      const list = { type: "list", ordered: marker.ordered, start: marker.start, items: [], loose: false }
      let blankAfter = false
      while (index < lines.length) {
        const item = listMarker(lines[index])
        if (!item || item.ordered !== marker.ordered || item.marker !== marker.marker) break
        // Content starts after the marker and one to four spaces; five or more begin indented code.
        const pad = item.rest === "" ? 1 : item.spaces > 4 ? 1 : item.spaces
        const contentIndent = item.indent + item.width + pad
        const body = [item.spaces > 4 ? " ".repeat(item.spaces - 1) + item.rest : item.rest]
        let inFence = FENCE.test(body[0])
        index++
        while (index < lines.length) {
          const next = lines[index]
          if (isBlank(next)) {
            body.push("")
            index++
            continue
          }
          if (indentOf(next) >= contentIndent) {
            body.push(next.slice(contentIndent))
            if (FENCE.test(next.slice(contentIndent))) inFence = !inFence
            index++
            continue
          }
          // Lazy continuation: an unindented line that continues the item's open paragraph.
          if (!inFence && !isBlank(body.at(-1)) && !interrupts(next) && !listMarker(next) && !startsTable(lines, index)) {
            body.push(next.trimStart())
            index++
            continue
          }
          break
        }
        let trailing = 0
        while (body.length > 1 && isBlank(body.at(-1))) {
          body.pop()
          trailing++
        }
        const children = parseBlocks(body, refs)
        let task = null
        const first = children[0]
        if (first?.type === "para") {
          const box = first.text.match(/^\[([ xX])\][ \t]+/)
          if (box) {
            task = box[1] !== " "
            first.text = first.text.slice(box[0].length)
          }
        }
        list.items.push({ children, task })
        if (children.some((child, childIndex) => childIndex > 0 && child.blankBefore)) list.loose = true
        const following = lines[index]
        const sibling = following === undefined ? null : listMarker(following)
        const sameList = sibling !== null && sibling.ordered === marker.ordered && sibling.marker === marker.marker
        if (trailing > 0 && sameList) list.loose = true
        blankAfter = trailing > 0
        if (!sameList) break
      }
      push(list)
      blank = blankAfter
      continue
    }

    if (indentOf(line) >= 4) {
      const body = []
      while (index < lines.length && (isBlank(lines[index]) || indentOf(lines[index]) >= 4)) {
        body.push(lines[index].slice(4))
        index++
      }
      while (body.length > 0 && isBlank(body.at(-1))) body.pop()
      push({ type: "code", lang: "", text: body.join("\n") })
      continue
    }

    if (startsTable(lines, index)) {
      const head = splitRow(line)
      const align = delimiterRow(lines[index + 1])
      const rows = []
      index += 2
      while (index < lines.length && !isBlank(lines[index]) && !interrupts(lines[index])) {
        const cells = splitRow(lines[index])
        rows.push(head.map((_, cellIndex) => cells[cellIndex] ?? ""))
        index++
      }
      push({ type: "table", align, head, rows })
      continue
    }

    const definition = refs && line.match(DEFINITION)
    if (definition) {
      const key = definition[1].trim().toLowerCase().replace(/\s+/g, " ")
      if (!refs.has(key)) refs.set(key, { href: definition[2], title: definition[3] ?? definition[4] ?? definition[5] ?? null })
      index++
      continue
    }

    const paragraph = [line.trimStart()]
    index++
    let setext = 0
    while (index < lines.length) {
      const next = lines[index]
      if (isBlank(next)) break
      if (/^ {0,3}=+[ \t]*$/.test(next)) setext = 1
      else if (/^ {0,3}-+[ \t]*$/.test(next)) setext = 2
      if (setext) {
        index++
        break
      }
      if (interrupts(next) || startsTable(lines, index)) break
      paragraph.push(next.trimStart())
      index++
    }
    const text = paragraph.join("\n").trimEnd()
    push(setext ? { type: "heading", level: setext, text } : { type: "para", text })
  }
  return blocks
}

// ---------------------------------------------------------------------------------------------------------
// Inlines.

const PUNCTUATION = /[\p{P}\p{S}]/u
const WHITESPACE = /\s/u
const ESCAPABLE = /[!-/:-@[-`{-~]/

const codeSpanEnd = (source, start, length) => {
  let search = start
  while (search < source.length) {
    const found = source.indexOf("`", search)
    if (found < 0) return -1
    const run = source.slice(found).match(/^`+/)[0].length
    if (run === length) return found
    search = found + run
  }
  return -1
}

// The index of the `]` that closes the `[` at `start`, skipping code spans, escapes and nested brackets.
const closingBracket = (source, start) => {
  let depth = 0
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (char === "\\") index++
    else if (char === "`") {
      const run = source.slice(index).match(/^`+/)[0].length
      const end = codeSpanEnd(source, index + run, run)
      if (end >= 0) index = end + run - 1
      else index += run - 1
    } else if (char === "[") depth++
    else if (char === "]" && --depth === 0) return index
  }
  return -1
}

// `(destination "title")` after a link's `]`, or null.
const inlineDestination = (source, start) => {
  if (source[start] !== "(") return null
  let index = start + 1
  while (/[ \t\n]/.test(source[index] ?? "")) index++
  let href = ""
  if (source[index] === "<") {
    const end = source.indexOf(">", index)
    if (end < 0 || source.slice(index, end).includes("\n")) return null
    href = source.slice(index + 1, end)
    index = end + 1
  } else {
    let depth = 0
    while (index < source.length) {
      const char = source[index]
      if (char === "\\" && ESCAPABLE.test(source[index + 1] ?? "")) {
        href += source[index + 1]
        index += 2
        continue
      }
      if (/\s/.test(char)) break
      if (char === "(") depth++
      if (char === ")" && depth-- === 0) break
      href += char
      index++
    }
  }
  while (/[ \t\n]/.test(source[index] ?? "")) index++
  let title = null
  const open = source[index]
  if (open === '"' || open === "'" || open === "(") {
    const close = open === "(" ? ")" : open
    const end = source.indexOf(close, index + 1)
    if (end < 0) return null
    title = source.slice(index + 1, end)
    index = end + 1
    while (/[ \t\n]/.test(source[index] ?? "")) index++
  }
  if (source[index] !== ")") return null
  return { href: decodeEntities(href), title: title === null ? null : decodeEntities(title), end: index + 1 }
}

const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<?!.,:*_~'"]/
const trimUrl = (url) => {
  // A closing parenthesis without its opening one belongs to the sentence.
  while (url.endsWith(")") && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) url = url.slice(0, -1)
  return url.replace(/[?!.,:*_~'"]+$/, "")
}

const linkHtml = (resolved, inner, title) => {
  const attrs = []
  if (resolved?.href) attrs.push(`href="${escapeHtml(resolved.href)}"`)
  if (resolved?.cls) attrs.push(`class="${escapeHtml(resolved.cls)}"`)
  const tip = title ?? resolved?.title
  if (tip) attrs.push(`title="${escapeHtml(tip)}"`)
  return `<a${attrs.map((attr) => ` ${attr}`).join("")}>${inner}</a>`
}

export function renderInline(source, ctx, state = { inLink: false }) {
  const tokens = []
  let text = ""
  const flush = () => {
    if (text) tokens.push({ type: "text", value: text })
    text = ""
  }
  const html = (value) => {
    flush()
    tokens.push({ type: "html", value })
  }
  const record = (resolved, label) => {
    if (resolved?.note && !state.inLink && ctx.record) ctx.record({ note: resolved.note, anchor: resolved.anchor ?? "", label })
  }

  let index = 0
  while (index < source.length) {
    const char = source[index]
    const rest = source.slice(index)

    if (char === "\\") {
      const next = source[index + 1]
      if (next === "\n") {
        html("<br>\n")
        index += 2
        continue
      }
      if (next !== undefined && ESCAPABLE.test(next)) {
        text += next
        index += 2
        continue
      }
    }

    if (char === "`") {
      const run = rest.match(/^`+/)[0].length
      const end = codeSpanEnd(source, index + run, run)
      if (end >= 0) {
        let code = source.slice(index + run, end).replace(/\n/g, " ")
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1)
        html(`<code>${escapeHtml(code)}</code>`)
        index = end + run
        continue
      }
      text += "`".repeat(run)
      index += run
      continue
    }

    if (char === "[" && source[index + 1] === "[" && !state.inLink) {
      const wiki = rest.match(/^\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/)
      if (wiki) {
        const target = wiki[1].trim()
        const resolved = ctx.wikilink ? ctx.wikilink(target) : null
        const label = wiki[2]?.trim() || resolved?.label || target
        record(resolved, label)
        html(linkHtml(resolved ?? { cls: "broken", title: `No note named ${target}` }, escapeText(label), null).replace("<a ", `<a data-wikilink="${escapeHtml(target)}" `))
        index += wiki[0].length
        continue
      }
    }

    const image = char === "!" && source[index + 1] === "["
    if ((char === "[" && !state.inLink) || image) {
      const open = image ? index + 1 : index
      const close = closingBracket(source, open)
      if (close > 0) {
        const label = source.slice(open + 1, close)
        let target = inlineDestination(source, close + 1)
        let end = target?.end
        if (!target && ctx.refs) {
          // Full `[text][ref]`, collapsed `[text][]` and shortcut `[text]` references.
          const full = source.slice(close + 1).match(/^\[([^\]]*)\]/)
          const key = (full && full[1] ? full[1] : label).trim().toLowerCase().replace(/\s+/g, " ")
          const ref = ctx.refs.get(key)
          if (ref) {
            target = ref
            end = close + 1 + (full ? full[0].length : 0)
          }
        }
        if (target) {
          if (image) {
            const src = ctx.image ? ctx.image(target.href) : { href: safeUrl(target.href) }
            const alt = htmlToText(renderInline(label, ctx, { inLink: true }))
            html(
              src?.href
                ? `<img src="${escapeHtml(src.href)}" alt="${escapeHtml(alt)}"${target.title ? ` title="${escapeHtml(target.title)}"` : ""} loading="lazy">`
                : `<span class="broken" title="Missing image">${escapeText(alt)}</span>`,
            )
          } else {
            const resolved = ctx.link ? ctx.link(target.href) : { href: safeUrl(target.href) }
            const inner = renderInline(label, ctx, { inLink: true })
            record(resolved, htmlToText(inner))
            html(linkHtml(resolved, inner, target.title))
          }
          index = end
          continue
        }
      }
      if (image) {
        text += "!"
        index++
        continue
      }
    }

    if (char === "<") {
      const auto = rest.match(/^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/) ?? rest.match(/^<([^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>/)
      if (auto && !state.inLink) {
        const href = auto[1].includes(":") ? auto[1] : `mailto:${auto[1]}`
        const resolved = ctx.link ? ctx.link(href) : { href: safeUrl(href) }
        html(linkHtml(resolved, escapeText(auto[1]), null))
        index += auto[0].length
        continue
      }
      const comment = rest.match(/^<!--[\s\S]*?-->/)
      if (comment) {
        index += comment[0].length
        continue
      }
      TAG.lastIndex = 0
      const tag = TAG.exec(rest)
      if (tag) {
        html(sanitizeTag(tag, ctx))
        index += tag[0].length
        continue
      }
    }

    if ((char === "h" || char === "w") && !state.inLink && (index === 0 || /[\s(*_~]/.test(source[index - 1]))) {
      const bare = rest.match(BARE_URL)
      if (bare) {
        const url = trimUrl(bare[0])
        const href = url.startsWith("www.") ? `http://${url}` : url
        const resolved = ctx.link ? ctx.link(href) : { href: safeUrl(href) }
        html(linkHtml(resolved, escapeText(url), null))
        index += url.length
        continue
      }
    }

    if (char === "*" || char === "_" || char === "~") {
      const run = rest.match(char === "*" ? /^\*+/ : char === "_" ? /^_+/ : /^~+/)[0].length
      if (char === "~" && run !== 2) {
        text += "~".repeat(run)
        index += run
        continue
      }
      const before = index === 0 ? " " : source[index - 1]
      const after = source[index + run] ?? " "
      const left = !WHITESPACE.test(after) && (!PUNCTUATION.test(after) || WHITESPACE.test(before) || PUNCTUATION.test(before))
      const right = !WHITESPACE.test(before) && (!PUNCTUATION.test(before) || WHITESPACE.test(after) || PUNCTUATION.test(after))
      const canOpen = char === "_" ? left && (!right || PUNCTUATION.test(before)) : left
      const canClose = char === "_" ? right && (!left || PUNCTUATION.test(after)) : right
      flush()
      tokens.push({ type: "delim", char, count: run, original: run, canOpen, canClose })
      index += run
      continue
    }

    if (char === "\n") {
      const hard = / {2,}$/.test(text)
      text = text.replace(/ +$/, "")
      if (hard) html("<br>\n")
      else text += "\n"
      index++
      continue
    }

    text += char
    index++
  }
  flush()
  processEmphasis(tokens)
  return tokens.map(tokenHtml).join("")
}

const tokenHtml = (token) => (token.type === "text" ? escapeText(token.value) : token.type === "html" ? token.value : token.char.repeat(token.count))

// CommonMark's delimiter algorithm, including the rule of three; `~~` pairs only with `~~`.
function processEmphasis(tokens) {
  for (let closerIndex = 0; closerIndex < tokens.length; closerIndex++) {
    const closer = tokens[closerIndex]
    if (closer.type !== "delim" || !closer.canClose) continue
    let openerIndex = -1
    for (let search = closerIndex - 1; search >= 0; search--) {
      const opener = tokens[search]
      if (opener.type !== "delim" || opener.char !== closer.char || !opener.canOpen) continue
      if (closer.char === "~" && opener.count !== closer.count) continue
      if (
        closer.char !== "~" &&
        (opener.canClose || closer.canOpen) &&
        (opener.original + closer.original) % 3 === 0 &&
        !(opener.original % 3 === 0 && closer.original % 3 === 0)
      )
        continue
      openerIndex = search
      break
    }
    if (openerIndex < 0) continue
    const opener = tokens[openerIndex]
    const used = closer.char === "~" ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1
    const tag = closer.char === "~" ? "del" : used === 2 ? "strong" : "em"
    const inner = tokens.slice(openerIndex + 1, closerIndex).map(tokenHtml).join("")
    opener.count -= used
    closer.count -= used
    const replacement = []
    if (opener.count > 0) replacement.push(opener)
    replacement.push({ type: "html", value: `<${tag}>${inner}</${tag}>` })
    if (closer.count > 0) replacement.push(closer)
    tokens.splice(openerIndex, closerIndex - openerIndex + 1, ...replacement)
    closerIndex = openerIndex + (opener.count > 0 ? 1 : 0)
  }
}

// ---------------------------------------------------------------------------------------------------------
// Document.

const ALERT_TITLES = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" }

export function renderMarkdown(source, options = {}) {
  const refs = new Map()
  const lines = source.replace(/\r\n?/g, "\n").replace(/^﻿/, "").split("\n").map(expandTabs)
  const blocks = parseBlocks(lines, refs)
  const headings = []
  const links = []
  const slugs = new Map()
  const sections = [{ id: "", heading: "", level: 0, text: "" }]
  let currentBlock = ""
  const ctx = {
    refs,
    link: options.link,
    image: options.image ?? ((src) => ({ href: safeUrl(src) })),
    wikilink: options.wikilink,
    record: (link) => links.push({ ...link, block: currentBlock }),
  }
  ctx.link ??= (href) => ({ href: safeUrl(href) })

  const inline = (text) => {
    currentBlock = text
    return renderInline(text, ctx)
  }
  const uniqueSlug = (text) => {
    const base = slugify(text) || "section"
    const seen = slugs.get(base) ?? 0
    slugs.set(base, seen + 1)
    return seen === 0 ? base : `${base}-${seen}`
  }

  const render = (list, tight = false) =>
    list
      .map((block) => {
        switch (block.type) {
          case "para":
            return tight ? inline(block.text) : `<p>${inline(block.text)}</p>`
          case "heading": {
            const inner = inline(block.text)
            const text = htmlToText(inner)
            const id = uniqueSlug(text)
            headings.push({ level: block.level, id, text })
            return `<h${block.level} id="${escapeHtml(id)}">${inner}</h${block.level}>`
          }
          case "code":
            return `<pre${block.lang ? ` data-lang="${escapeHtml(block.lang)}"` : ""}><code${block.lang ? ` class="language-${escapeHtml(block.lang)}"` : ""}>${escapeHtml(block.text)}</code></pre>`
          case "quote":
            return block.alert
              ? `<div class="callout callout-${block.alert}"><p class="callout-title">${ALERT_TITLES[block.alert]}</p>${render(block.children)}</div>`
              : `<blockquote>${render(block.children)}</blockquote>`
          case "list": {
            const tag = block.ordered ? "ol" : "ul"
            const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : ""
            const items = block.items.map((item) => {
              const box = item.task === null ? "" : `<input type="checkbox" disabled${item.task ? " checked" : ""}> `
              return `<li${item.task === null ? "" : ' class="task"'}>${box}${render(item.children, !block.loose)}</li>`
            })
            return `<${tag}${start}>\n${items.join("\n")}\n</${tag}>`
          }
          case "table": {
            const cell = (tag, value, index) => {
              const align = block.align[index] ? ` style="text-align:${block.align[index]}"` : ""
              return `<${tag}${align}>${inline(value)}</${tag}>`
            }
            const head = `<thead><tr>${block.head.map((value, index) => cell("th", value, index)).join("")}</tr></thead>`
            const body = block.rows.length ? `<tbody>${block.rows.map((row) => `<tr>${row.map((value, index) => cell("td", value, index)).join("")}</tr>`).join("\n")}</tbody>` : ""
            return `<div class="table-wrap"><table>${head}${body}</table></div>`
          }
          case "hr":
            return "<hr>"
          case "html":
            currentBlock = ""
            return sanitizeHtml(block.html, ctx)
          default:
            return ""
        }
      })
      .join("\n")

  // Render top-level blocks one at a time so each heading starts a search section.
  const html = blocks
    .map((block) => {
      const out = render([block])
      if (block.type === "heading") sections.push({ id: headings.at(-1).id, heading: headings.at(-1).text, level: block.level, text: "" })
      else {
        const section = sections.at(-1)
        section.text = `${section.text} ${htmlToText(out)}`.trim()
      }
      return out
    })
    .join("\n")

  const title = headings.find((heading) => heading.level === 1)?.text ?? null
  return {
    html,
    title,
    headings,
    sections: sections.filter((section) => section.id !== "" || section.text !== ""),
    // The plain text of the block each link sits in, for backlink context.
    links: links.map((link) => ({ ...link, context: htmlToText(renderInline(link.block, { ...ctx, record: null })) })),
  }
}

// ---------------------------------------------------------------------------------------------------------
// Front matter: a leading `---` block of `key: value` lines, the subset of YAML the docs use. A value is a
// string, or a list written `[a, b]` or as indented `- item` lines. `body` keeps the rest of the file.

const unquote = (value) => {
  const text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'")
  return text.replace(/\s+#.*$/, "")
}

// Splits `a, "b, c", d` on the commas outside quotes.
const splitFlowList = (inner) => {
  const items = []
  let current = ""
  let quote = null
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === ",") {
      items.push(current)
      current = ""
      continue
    }
    current += char
  }
  items.push(current)
  return items.map(unquote).filter((item) => item !== "")
}

export function splitFrontmatter(source) {
  const lines = source.replace(/\r\n?/g, "\n").replace(/^﻿/, "").split("\n")
  const end = lines[0] === "---" ? lines.findIndex((line, index) => index > 0 && (line === "---" || line === "...")) : -1
  if (end < 0) return { data: null, body: source, errors: [] }
  const data = {}
  const errors = []
  let listKey = null
  lines.slice(1, end).forEach((line, index) => {
    if (/^\s*(#.*)?$/.test(line)) return
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && listKey !== null) {
      if (!Array.isArray(data[listKey])) data[listKey] = []
      data[listKey].push(unquote(item[1]))
      return
    }
    const pair = line.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/)
    if (!pair) {
      errors.push(`line ${index + 2}: ${line.trim()}`)
      listKey = null
      return
    }
    const [, key, value = ""] = pair
    const text = value.trim()
    listKey = text === "" ? key : null
    if (text.startsWith("[") && text.endsWith("]")) data[key] = splitFlowList(text.slice(1, -1))
    else data[key] = unquote(text)
  })
  return { data, body: lines.slice(end + 1).join("\n"), errors }
}
