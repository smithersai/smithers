import { fromMarkdown } from "mdast-util-from-markdown"

/**
 * Split Markdown into alternating prose and code blocks, starting with prose.
 * Parser offsets preserve the original bytes, including fence markers and
 * indentation inside lists and blockquotes.
 */
export function splitMarkdownCodeBlocks(source) {
  const parts = []
  let offset = 0
  const visit = (node) => {
    if (node.type === "code") {
      let start = node.position.start.offset
      const lineStart = source.lastIndexOf("\n", start - 1) + 1
      if (/^[ \t]*$/.test(source.slice(lineStart, start))) start = lineStart
      const end = node.position.end.offset
      parts.push(source.slice(offset, start), source.slice(start, end))
      offset = end
    } else {
      for (const child of node.children ?? []) visit(child)
    }
  }
  // MDX wrapper tags must not hide the Markdown examples they contain.
  visit(fromMarkdown(source, { extensions: [{ disable: { null: ["htmlFlow"] } }] }))
  parts.push(source.slice(offset))
  return parts
}

/** Rewrite an already identified prose region without changing inline code. */
export function mapInlineProse(source, rewrite) {
  const code = /(`+)(?!`)[^\n]*?\1(?!`)/g
  let result = ""
  let offset = 0
  for (const match of source.matchAll(code)) {
    result += rewrite(source.slice(offset, match.index)) + match[0]
    offset = match.index + match[0].length
  }
  return result + rewrite(source.slice(offset))
}

/** Apply a prose rewrite without changing fenced, indented or inline Markdown code. */
export function mapMarkdownProse(source, rewrite) {
  return splitMarkdownCodeBlocks(source).map((part, index) =>
    index % 2 === 1 ? part : mapInlineProse(part, rewrite)).join("")
}

/** Convert the site's supported MDX components to portable Markdown. */
export function docsText(source, { raw = {}, versions = {} } = {}) {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, "")
  // Preserve code verbatim: its imports are part of the example, not MDX setup.
  return splitMarkdownCodeBlocks(body).map((part, index) => {
    if (index % 2 === 1) return part
    const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? ""
    return mapInlineProse(part, (prose) => prose.replace(/\{\/\*[\s\S]*?\*\/\}/g, ""))
      .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
      .replace(/<DocsDiagram\b[\s\S]*?\/>/g, (tag) => `**${attr(tag, "title")}**\n\n${attr(tag, "caption")}`)
      .replace(/<AppScreenshot\b[\s\S]*?\/>/g, (tag) => `![${attr(tag, "alt")}](${attr(tag, "src")})\n\n${attr(tag, "caption")}`)
      .replace(/<LinkCard\b[\s\S]*?\/>/g, (tag) => `- [${attr(tag, "title")}](${attr(tag, "href")}): ${attr(tag, "description")}`)
      .replace(/<LinkButton\b([^>]*)>([^<]*)<\/LinkButton>/g, (_, attrs, label) => `[${label}](${attr(attrs, "href")})`)
      .replace(/<Code\b[\s\S]*?\/>/g, (tag) => {
        const name = tag.match(/\bcode=\{(\w+)\}/)?.[1]
        const literal = tag.match(/\bcode=\{`([\s\S]*?)`\}/)?.[1]
        let code = name === undefined ? literal : raw[name]
        if (code === undefined) throw new Error(`Cannot export Code component: ${tag}`)
        if ((attr(tag, "lang") || "text") === "text") code = code.split("\n").map((line) => line.trimEnd()).join("\n")
        return `\n\`\`\`${attr(tag, "lang") || "text"}\n${code.trimEnd()}\n\`\`\`\n`
      })
      .replace(/<img\b[^>]*\/>/g, (tag) => `![${attr(tag, "alt")}](${attr(tag, "src")})`)
      .replace(/<TabItem\b[^>]*label="([^"]+)"[^>]*>/g, "\n**$1**\n")
      .replace(/<\/?(?:CardGrid|FileTree|Steps|Tabs|TabItem|picture|source)\b[^>]*>/g, "")
      .replace(/\{versions\.(\w+)\}/g, (_, key) => {
        if (!(key in versions)) throw new Error(`Unknown version field: ${key}`)
        return String(versions[key])
      })
      .replace(/^[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
  }).join("").trim()
}
