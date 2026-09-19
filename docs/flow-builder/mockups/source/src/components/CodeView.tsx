import { useMemo, useRef } from "react"

/**
 * A small TypeScript highlighter. The product renders code through
 * `CodeFileView` (Shiki) in `@smthrs/ui/adapters/code-view`; the mock only needs
 * to look like it, in one file, with no grammar to ship.
 */

type TokenKind = "plain" | "comment" | "string" | "keyword" | "number" | "fn" | "type" | "prop" | "punct"

interface Token {
  readonly kind: TokenKind
  readonly text: string
}

const KEYWORDS = new Set([
  "import", "from", "export", "default", "const", "let", "return", "if", "else", "await", "async",
  "new", "as", "type", "interface", "readonly", "function", "true", "false", "null", "undefined", "typeof"
])

const tokenizeLine = (line: string, state: { block: boolean; template: boolean }): Token[] => {
  const tokens: Token[] = []
  let index = 0
  const push = (kind: TokenKind, text: string) => {
    if (text) tokens.push({ kind, text })
  }

  while (index < line.length) {
    if (state.block) {
      const end = line.indexOf("*/", index)
      if (end === -1) { push("comment", line.slice(index)); return tokens }
      push("comment", line.slice(index, end + 2)); index = end + 2; state.block = false; continue
    }
    if (state.template) {
      const end = line.indexOf("`", index)
      if (end === -1) { push("string", line.slice(index)); return tokens }
      push("string", line.slice(index, end + 1)); index = end + 1; state.template = false; continue
    }
    const rest = line.slice(index)
    if (rest.startsWith("//")) { push("comment", rest); return tokens }
    if (rest.startsWith("/*")) { state.block = true; continue }
    const char = rest[0]
    if (char === '"' || char === "'") {
      let end = 1
      while (end < rest.length && rest[end] !== char) end += rest[end] === "\\" ? 2 : 1
      push("string", rest.slice(0, end + 1)); index += end + 1; continue
    }
    if (char === "`") {
      const end = rest.indexOf("`", 1)
      if (end === -1) { push("string", rest); state.template = true; return tokens }
      push("string", rest.slice(0, end + 1)); index += end + 1; continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (word) {
      const text = word[0]
      const after = rest.slice(text.length)
      const kind: TokenKind = KEYWORDS.has(text)
        ? "keyword"
        : /^\s*\(/.test(after)
          ? "fn"
          : /^[A-Z]/.test(text)
            ? "type"
            : /^\s*:/.test(after) && !/^\s*::/.test(after)
              ? "prop"
              : "plain"
      push(kind, text); index += text.length; continue
    }
    const number = /^\d[\d_]*(\.\d+)?/.exec(rest)
    if (number) { push("number", number[0]); index += number[0].length; continue }
    const space = /^\s+/.exec(rest)
    if (space) { push("plain", space[0]); index += space[0].length; continue }
    push("punct", char); index += 1
  }
  return tokens
}

interface CodeViewProps {
  readonly text: string
  readonly highlight?: readonly [number, number]
  readonly startLine?: number
  readonly maxHeight?: number
}

export const CodeView = ({ text, highlight, startLine = 1, maxHeight }: CodeViewProps) => {
  const lines = useMemo(() => {
    const state = { block: false, template: false }
    return text.replace(/\n$/, "").split("\n").map((line) => tokenizeLine(line, state))
  }, [text])

  const scroller = useRef<HTMLDivElement>(null)
  const anchor = (element: HTMLDivElement | null) => {
    const parent = element?.parentElement
    if (!element || !parent) return
    parent.scrollTop = Math.max(0, element.offsetTop - 54)
  }

  return (
    <div className="code" ref={scroller} style={maxHeight ? { maxHeight } : undefined}>
      {lines.map((tokens, index) => {
        const lineNumber = index + startLine
        const lit = highlight !== undefined && lineNumber >= highlight[0] && lineNumber <= highlight[1]
        const first = highlight !== undefined && lineNumber === highlight[0]
        return (
          <div className="code-line" data-lit={lit ? "true" : undefined} key={lineNumber} ref={first ? anchor : undefined}>
            <span className="code-gutter">{lineNumber}</span>
            <span className="code-text">
              {tokens.length === 0 ? " " : tokens.map((token, tokenIndex) => (
                <span className={`tk-${token.kind}`} key={tokenIndex}>{token.text}</span>
              ))}
            </span>
          </div>
        )
      })}
    </div>
  )
}
