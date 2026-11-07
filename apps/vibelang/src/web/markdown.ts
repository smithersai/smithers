// The little Markdown the agent writes: paragraphs, fenced code blocks and inline code. Text becomes text nodes, never
// HTML, so a reply can't inject markup.
import type { Html, HtmlBuilder } from "foldkit/html"

/** One block of a reply: prose, or a fenced code block with its language. */
export type Block =
  | { readonly kind: "prose"; readonly text: string }
  | { readonly kind: "code"; readonly language: string; readonly text: string }

/** `text` split into prose and fenced code blocks. An unclosed fence runs to the end, as it does while streaming. */
export function blocks(text: string): ReadonlyArray<Block> {
  const result: Array<Block> = []
  const lines = text.split("\n")
  let prose: Array<string> = []
  let code: Array<string> | undefined
  let language = ""
  const flushProse = () => {
    const joined = prose.join("\n").trim()
    if (joined !== "") for (const paragraph of joined.split(/\n{2,}/)) result.push({ kind: "prose", text: paragraph })
    prose = []
  }
  for (const line of lines) {
    const fence = /^```\s*([\w-]*)\s*$/.exec(line)
    if (fence) {
      if (code === undefined) {
        flushProse()
        code = []
        language = fence[1] ?? ""
      } else {
        result.push({ kind: "code", language, text: code.join("\n") })
        code = undefined
      }
      continue
    }
    if (code === undefined) prose.push(line)
    else code.push(line)
  }
  if (code !== undefined) result.push({ kind: "code", language, text: code.join("\n") })
  flushProse()
  return result
}

/** A paragraph's text split at backticks: even pieces are text, odd ones inline code. */
export function inline(text: string): ReadonlyArray<{ readonly code: boolean; readonly text: string }> {
  return text.split("`").map((piece, index) => ({ code: index % 2 === 1, text: piece })).filter((piece) => piece.text !== "")
}

/** The reply as Foldkit nodes. */
export function render<Message>(h: HtmlBuilder<Message>, text: string): ReadonlyArray<Html> {
  return blocks(text).map((block) =>
    block.kind === "code"
      ? h.pre([h.Class("vl-code"), h.DataAttribute("language", block.language)], [h.code([], [block.text])])
      : h.p([], inline(block.text).map((piece) => piece.code ? h.code([], [piece.text]) : piece.text))
  )
}
