/**
 * The fenced cell blocks of a model reply, read consistently for settled
 * replies (`Cell.extract`), streaming replies (`DoneText.project`), and the
 * prose around cells (`Supervisor.prose`).
 *
 * @since 1.0.0-rc.16
 */

const fenced = /^```(?<info>[^\n`]*)\r?\n(?<body>[\s\S]*?)(?:\n?(?<close>^```[ \t]*(?=\r?$))|(?![\s\S]))/gm

const languageOf = (info: string): "javascript" | "typescript" | undefined => {
  const tokens = new Set(info.trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0))
  if (tokens.has("ts") || tokens.has("typescript")) return "typescript"
  if (tokens.has("cell") || tokens.has("js") || tokens.has("javascript")) return "javascript"
  return undefined
}

/**
 * One fenced block tagged as a cell.
 *
 * @since 1.0.0-rc.16
 * @private
 */
export interface Block {
  readonly language: "javascript" | "typescript"
  readonly body: string
  readonly start: number
  readonly end: number
  /** False for a block the reply ended inside: only the last block can be open. */
  readonly closed: boolean
}

/**
 * Every fenced block tagged `cell`, `js`, `javascript`, `ts` or `typescript`,
 * in reply order. Blocks with any other info string are skipped.
 *
 * @since 1.0.0-rc.16
 * @private
 */
export const cellBlocks = (text: string): ReadonlyArray<Block> => {
  const blocks: Array<Block> = []
  for (const match of text.matchAll(fenced)) {
    /* v8 ignore next -- `info` is a mandatory group of `fenced`, outside any alternation or quantifier, so it participates in every match; the default only discharges the optional type TypeScript gives `RegExpMatchArray.groups` */
    const language = languageOf(match.groups?.info ?? "")
    if (language === undefined) continue
    /* v8 ignore next -- `body` is likewise mandatory in `fenced`; a match that reached here already produced `info`, so `groups` is present and carries both */
    const body = match.groups?.body ?? ""
    blocks.push({
      language,
      body,
      start: match.index,
      end: match.index + match[0].length,
      closed: match.groups?.close !== undefined
    })
  }
  return blocks
}

/**
 * The reply around its cells, preserving every other fenced block verbatim.
 *
 * @since 0.1.0
 * @private
 */
export const stripCells = (text: string): string => {
  const parts: Array<string> = []
  let offset = 0
  for (const block of cellBlocks(text)) {
    parts.push(text.slice(offset, block.start))
    offset = block.end
  }
  parts.push(text.slice(offset))
  return parts.join("")
}
