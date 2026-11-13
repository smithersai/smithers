import { file, repo, to, tree } from "../../fixtures"
import { stripFrontmatter } from "../../ui/markdown-source"
import type { DocPage } from "../../fixtures/types"

export type DocBlock =
  | { kind: "heading"; level: number; text: string; id: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "markdown"; text: string }

const headingText = (text: string) => text
  .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
  .replace(/[*`_]/g, "")
  .replace(/\s+#+\s*$/, "")

/** Headings and code fences use local blocks; prose keeps the shared Markdown renderer. */
export const documentBlocks = (body: string): DocBlock[] => {
  const lines = stripFrontmatter(body).split("\n")
  const blocks: DocBlock[] = []
  const used = new Set<string>()
  let prose: string[] = []
  const flush = () => {
    if (prose.join("\n").trim()) blocks.push({ kind: "markdown", text: prose.join("\n") })
    prose = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // A quoted fence is still a copyable code block. Keep source blobs verbatim;
    // remove only the quote markers when presenting that block's code.
    const quoteDepth = line.match(/^\s*(?:>\s*)+/)?.[0].match(/>/g)?.length ?? 0
    const unquote = (value: string) => {
      for (let depth = 0; depth < quoteDepth; depth++) value = value.replace(/^\s*> ?/, "")
      return value
    }
    const fence = unquote(line).match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fence) {
      flush()
      const code: string[] = []
      const marker = fence[1][0]
      const size = fence[1].length
      while (++i < lines.length) {
        const value = unquote(lines[i])
        const trimmed = value.trim()
        if (trimmed.startsWith(marker.repeat(size)) && !trimmed.replaceAll(marker, "").trim()) break
        code.push(value)
      }
      blocks.push({ kind: "code", lang: fence[2].trim().split(/\s+/)[0], text: code.join("\n") })
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (!heading) { prose.push(line); continue }
    flush()
    const text = headingText(heading[2])
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-") || "section"
    let id = base
    let suffix = 0
    while (used.has(id)) id = `${base}-${++suffix}`
    used.add(id)
    blocks.push({ kind: "heading", level: heading[1].length, text, id })
  }
  flush()
  return blocks
}

export const docSource = (page: DocPage): string | undefined => {
  const root = repo.config.docs?.root?.replace(/\/$/, "") ?? "docs"
  const candidates = [
    `${root}/${page.slug}.md`, `${root}/${page.slug}.mdx`,
    `${root}/${page.slug}/README.md`, ...(page.slug === "index" ? [`${root}/README.md`] : [])
  ]
  const direct = candidates.find(path => file(path))
  if (direct) return direct
  const exact = tree.find(entry => entry.kind === "file"
    && file(entry.path)?.content.trim() === page.body.trim())?.path
  if (exact) return exact
  const prefix = `${to()}/blob/`
  for (const match of page.body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^#\/?/, "")
    if (!target.startsWith(prefix)) continue
    const path = target.slice(prefix.length).split("/").slice(1).join("/").split("?")[0]
    if (file(path)) return path
  }
  const examples = documentBlocks(page.body).filter(block => block.kind === "code")
  return tree.find(entry => entry.kind === "file" && examples.some(example =>
    file(entry.path)?.content.trim() === example.text.trim()))?.path
}
