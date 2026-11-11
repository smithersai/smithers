/**
 * Small, dependency-free HTML renderers for web retrieval.
 *
 * @since 1.0.0
 */

const entities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }

// Each search advances past what it consumed. A missing delimiter ends the
// search, so repeated unclosed openers never rescan the remaining document.
const dropComments = (html: string): string => {
  let output = ""
  let cursor = 0
  let start = html.indexOf("<!--")
  while (start !== -1) {
    const end = html.indexOf("-->", start + 4)
    if (end === -1) break
    output += html.slice(cursor, start)
    cursor = end + 3
    start = html.indexOf("<!--", cursor)
  }
  return output + html.slice(cursor)
}

// Opening patterns match only fixed tag names, never unbounded attributes.
const replaceTags = (html: string, opening: RegExp, replacement: string): string => {
  let output = ""
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = opening.exec(html)) !== null) {
    const end = html.indexOf(">", opening.lastIndex)
    if (end === -1) break
    output += html.slice(cursor, match.index) + replacement
    cursor = end + 1
    opening.lastIndex = cursor
  }
  return output + html.slice(cursor)
}

const replaceElements = (
  html: string,
  opening: RegExp,
  render: (tag: string, text: string, href: string) => string
): string => {
  const lower = html.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const closings = new Map<string, number>()
  let output = ""
  let cursor = 0
  let end = -1
  let hrefEnd = -1
  let hrefStart = -1
  let href = ""
  let hrefTagEnd = -1
  let attributeEnd = -1
  let lastAnchorClose: number | undefined
  const quotes = /["']/g
  let match: RegExpExecArray | null
  while ((match = opening.exec(html)) !== null) {
    // Multiple malformed openers can share one >. Cache that search too.
    if (end < opening.lastIndex) end = html.indexOf(">", opening.lastIndex)
    if (end === -1) break
    const tag = match[1]!.toLowerCase()
    let tagEnd = end
    if (tag === "a") {
      lastAnchorClose ??= lower.lastIndexOf("</a>")
      if (lastAnchorClose <= end) continue
      if (hrefEnd !== end) {
        hrefEnd = end
        hrefStart = -1
        // Consider every href prefix before the first >. Its quoted value
        // can itself contain >, and the last complete attribute wins.
        for (const attribute of html.slice(opening.lastIndex, end).matchAll(/href=["']/gi)) {
          const valueStart = opening.lastIndex + attribute.index + attribute[0].length
          quotes.lastIndex = valueStart
          const quote = quotes.exec(html)
          if (quote === null) break
          const quoteEnd = quote.index
          if (quoteEnd === valueStart) continue
          if (attributeEnd <= quoteEnd) attributeEnd = html.indexOf(">", quoteEnd + 1)
          if (attributeEnd === -1 || attributeEnd >= lastAnchorClose) break
          hrefStart = opening.lastIndex + attribute.index
          href = html.slice(valueStart, quoteEnd)
          hrefTagEnd = attributeEnd
        }
      }
      if (hrefStart < opening.lastIndex) continue
      tagEnd = hrefTagEnd
    }
    const marker = `</${tag}>`
    let close = closings.get(tag)
    if (close === undefined || (close !== -1 && close <= tagEnd)) {
      close = lower.indexOf(marker, tagEnd + 1)
      closings.set(tag, close)
    }
    if (close === -1) continue
    output += html.slice(cursor, match.index) + render(tag, html.slice(tagEnd + 1, close), href)
    cursor = close + marker.length
    opening.lastIndex = cursor
  }
  return output + html.slice(cursor)
}

// Match a whole whitespace run even when no newline follows it.
const trimLineEnds = (text: string): string =>
  text.replace(/[ \t]+/g, (space, offset: number) => text[offset + space.length] === "\n" ? "" : space)

const dropSkipped = (html: string): string => {
  const lower = html.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const opening = /<(head|script|style|noscript|iframe|object|embed)\b/gi
  let output = ""
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = opening.exec(html)) !== null) {
    output += html.slice(cursor, match.index)
    const marker = `</${match[1]!.toLowerCase()}`
    let close = lower.indexOf(marker, opening.lastIndex)
    while (close !== -1) {
      let end = close + marker.length
      while (/\s/.test(lower[end] ?? "")) end++
      if (lower[end] === ">") {
        cursor = end + 1
        opening.lastIndex = cursor
        break
      }
      close = lower.indexOf(marker, close + marker.length)
    }
    if (close === -1) return output
  }
  return output + html.slice(cursor)
}

const decode = (value: string): string =>
  value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const number = Number.parseInt(
        entity.slice(entity[1]!.toLowerCase() === "x" ? 2 : 1),
        entity[1]!.toLowerCase() === "x" ? 16 : 10
      )
      return number <= 0x10ffff
          && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number)
        : match
    }
    const key = entity.toLowerCase()
    return Object.hasOwn(entities, key) ? entities[key]! : match
  })

const source = (html: string): string => dropSkipped(dropComments(html))

/**
 * Extracts readable text while dropping executable and presentation-only elements.
 *
 * @category rendering
 * @since 1.0.0
 */
export const toText = (html: string): string => {
  const lines = replaceTags(source(html), /<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b/gi, "\n")
  return trimLineEnds(decode(replaceTags(lines, /</g, " ")))
    .replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim()
}

/**
 * Converts a conservative subset of HTML into readable Markdown.
 *
 * @category rendering
 * @since 1.0.0
 */
export const toMarkdown = (html: string): string => {
  const headings = replaceElements(
    source(html),
    /<(h[1-6])\b/gi,
    (tag, text) => `\n\n${"#".repeat(Number(tag[1]))} ${toText(text)}\n\n`
  )
  const strong = replaceElements(headings, /<(strong|b)\b/gi, (_tag, text) => `**${text}**`)
  const emphasis = replaceElements(strong, /<(em|i)\b/gi, (_tag, text) => `*${text}*`)
  const links = replaceElements(emphasis, /<(a)\b/gi, (_tag, text, href) => `[${toText(text)}](${href})`)
  const items = replaceTags(links, /<li\b/gi, "\n- ")
  const blocks = replaceTags(items, /<\/?(ul|ol|p|div|section|article|main|blockquote|pre|tr)\b/gi, "\n")
  const lines = replaceTags(blocks, /<br\b/gi, "\n")
  return trimLineEnds(decode(replaceTags(lines, /</g, ""))).replace(/\n{3,}/g, "\n\n").trim()
}
