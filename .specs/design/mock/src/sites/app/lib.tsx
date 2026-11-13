/* Shared UI primitives for the repo app mock. */
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link } from "../core/router"

export const Icon = ({ name, size = 16 }: { name: string; size?: number }) => {
  const paths: Record<string, ReactNode> = {
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>,
    dir: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
    folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
    issue: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /></>,
    "issue-closed": <><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
    change: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5v3a2 2 0 0 1-2 2H9" /></>,
    check: <path d="m4.5 12.5 5 5 10-11" />,
    x: <path d="M6 6l12 12M18 6L6 18" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>,
    chevron: <path d="m9 6 6 6-6 6" />,
    "chevron-down": <path d="m6 9 6 6 6-6" />,
    send: <path d="M12 19V5m-7 7 7-7 7 7" />,
    maximize: <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />,
    restore: <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />,
    dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] ?? null}
    </svg>
  )
}

export const CopyButton = ({ text, label = "Copy", small = false }: { text: string; label?: string; small?: boolean }) => {
  const { copied, failed, copy } = useCopied()
  return (
    <button type="button" className={`app-btn app-btn-secondary${small ? " app-btn-sm" : ""}`} onClick={() => copy(text)} aria-live="polite">
      <Icon name={failed ? "x" : copied ? "check" : "copy"} size={14} /> {failed ? "Copy failed. Retry" : copied ? "Copied" : label}
    </button>
  )
}

export type PillTone = "brand" | "warning" | "danger" | "success" | "neutral"
export const Pill = ({ tone, pulse = false, children }: { tone: PillTone; pulse?: boolean; children: ReactNode }) => (
  <span className={`app-pill app-pill-${tone}${pulse ? " app-pill-pulse" : ""}`}><span className="app-pill-dot" />{children}</span>
)

export const Avatar = ({ who }: { who: "maya" | "guest" | "smithers" | "bot" | "will" | "cora" }) => {
  if (who === "smithers") return <span className="app-avatar app-avatar-smithers" aria-label="Smithers">S</span>
  if (who === "bot") return <span className="app-avatar app-avatar-bot" aria-label="Coding agent">S</span>
  if (who === "maya") return <span className="app-avatar app-avatar-maya" aria-label="Maya Okafor">M</span>
  if (who === "will") return <span className="app-avatar app-avatar-will" aria-label="Will">W</span>
  if (who === "cora") return <span className="app-avatar app-avatar-cora" aria-label="Cora">C</span>
  return <span className="app-avatar app-avatar-guest" aria-label="You">Y</span>
}

export const Card = ({ id, title, pill, tag, onClose, children }: {
  id?: string
  title?: ReactNode
  pill?: ReactNode
  tag?: string
  onClose?: () => void
  children: ReactNode
}) => {
  const [large, setLarge] = useState(false)
  return (
    <section className="app-card" id={id} data-large={large || undefined}>
      {(title !== undefined || onClose !== undefined) && (
        <header className="app-card-head">
          <h2 className="app-card-title">{title}</h2>
          {pill}
          {tag !== undefined && <span className="app-card-tag">{tag}</span>}
          <span className="app-card-head-spacer" />
          <button type="button" className="app-icon-btn" aria-label={large ? "Restore" : "Maximize"} onClick={() => setLarge(!large)}>
            <Icon name={large ? "restore" : "maximize"} size={14} />
          </button>
          {onClose !== undefined && (
            <button type="button" className="app-icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
          )}
        </header>
      )}
      {children}
    </section>
  )
}

/* Syntax highlighting: one small tokenizer for TS, VibeLang, Go, JSON and shell. */
const KEYWORDS = new Set(("import export from const let var function return if else for while new class interface type extends implements throw throws try catch await async public private readonly of in as typeof service error schema control provide handle when match default mutable wire fork join resume abandon sync callback sleep retry timeout all forEach race pipe using yield static package func go defer select case range map struct chan nil true false undefined null this export default").split(" "))

type Tok = { text: string; cls: string | null }
const tokenize = (line: string, state: { block: boolean }): Tok[] => {
  const out: Tok[] = []
  let rest = line
  while (rest.length > 0) {
    if (state.block) {
      const end = rest.indexOf("*/")
      if (end === -1) { out.push({ text: rest, cls: "app-tok-c" }); rest = ""; continue }
      out.push({ text: rest.slice(0, end + 2), cls: "app-tok-c" }); rest = rest.slice(end + 2); state.block = false; continue
    }
    let m = rest.match(/^(\/\/.*)$/) ?? rest.match(/^(\/\*)/)
    if (m) {
      if (m[1] === "/*") { state.block = true; const end = rest.indexOf("*/", 2); if (end === -1) { out.push({ text: rest, cls: "app-tok-c" }); rest = "" } else { out.push({ text: rest.slice(0, end + 2), cls: "app-tok-c" }); rest = rest.slice(end + 2); state.block = false } continue }
      out.push({ text: m[1], cls: "app-tok-c" }); rest = rest.slice(m[1].length); continue
    }
    m = rest.match(/^("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)/)
    if (m) { out.push({ text: m[1], cls: "app-tok-s" }); rest = rest.slice(m[1].length); continue }
    m = rest.match(/^(\d[\d_]*(?:\.\d+)?)/)
    if (m) { out.push({ text: m[1], cls: "app-tok-n" }); rest = rest.slice(m[1].length); continue }
    m = rest.match(/^([A-Za-z_$][\w$]*)([(!])?/)
    if (m) {
      const word = m[1]
      const cls = KEYWORDS.has(word) ? "app-tok-k" : m[2] === "(" ? "app-tok-f" : /^[A-Z]/.test(word) ? "app-tok-t" : null
      out.push({ text: word + (m[2] ?? ""), cls }); rest = rest.slice(word.length + (m[2] ?? "").length); continue
    }
    out.push({ text: rest[0], cls: null }); rest = rest.slice(1)
  }
  return out
}

/** Highlight one code string into per-line React nodes (line numbers stay outside). */
export const highlightLines = (code: string): ReactNode[] => {
  const state = { block: false }
  return code.replace(/\n$/, "").split("\n").map((line, i) => {
    const toks = tokenize(line, state)
    return <span key={i}>{toks.map((tok, j) => tok.cls === null ? tok.text : <span key={j} className={tok.cls}>{tok.text}</span>)}{"\n"}</span>
  })
}

export const CodeBlock = ({ code }: { code: string }) => (
  <div className="app-code"><div className="app-code-scroll"><pre><code>{highlightLines(code)}</code></pre></div></div>
)

/* A small Markdown renderer: headings, lists, quotes, fences, tables-as-text, inline code, bold, links. */
type DocLink = { kind: "route"; to: string } | { kind: "external"; href: string } | { kind: "text" }
export type LinkResolver = (href: string) => DocLink

const inline = (text: string, resolve: LinkResolver, keyBase: string): ReactNode[] => {
  const out: ReactNode[] = []
  let rest = text
  let i = 0
  while (rest.length > 0) {
    const m = rest.match(/^(.*?)(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/)
    if (!m) { out.push(rest); break }
    if (m[1]) out.push(m[1])
    const tok = m[2]
    const key = `${keyBase}-${i++}`
    if (tok.startsWith("`")) out.push(<code key={key}>{tok.slice(1, -1)}</code>)
    else if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>)
    else {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!
      const link = resolve(lm[2])
      if (link.kind === "route") out.push(<Link key={key} to={link.to}>{lm[1]}</Link>)
      else if (link.kind === "external") out.push(<a key={key} href={link.href} target="_blank" rel="noopener noreferrer">{lm[1]}</a>)
      else out.push(lm[1])
    }
    rest = rest.slice(m[0].length)
  }
  return out
}

export const Markdown = ({ source, resolve, dense = false }: { source: string; resolve: LinkResolver; dense?: boolean }) => {
  const blocks: ReactNode[] = []
  const lines = source.replace(/\n+$/, "").split("\n")
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^```(\w*)/)
    if (fence) {
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i].startsWith("```")) { buf.push(lines[i]); i += 1 }
      i += 1
      blocks.push(<pre key={key++}><code>{highlightLines(buf.join("\n"))}</code></pre>)
      continue
    }
    const head = line.match(/^(#{1,4})\s+(.*)$/)
    if (head) {
      const level = head[1].length
      const content = inline(head[2], resolve, `h${key}`)
      if (level === 1) blocks.push(<h1 key={key++}>{content}</h1>)
      else if (level === 2) blocks.push(<h2 key={key++}>{content}</h2>)
      else blocks.push(<h3 key={key++}>{content}</h3>)
      i += 1
      continue
    }
    if (/^---+$/.test(line.trim())) { i += 1; continue }
    if (line.startsWith(">")) {
      const buf: string[] = []
      while (i < lines.length && lines[i].startsWith(">")) { buf.push(lines[i].replace(/^>\s?/, "")); i += 1 }
      blocks.push(<blockquote key={key++}>{inline(buf.join(" "), resolve, `q${key}`)}</blockquote>)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i += 1 }
      blocks.push(<ul key={key++}>{items.map((item, j) => <li key={j}>{inline(item, resolve, `l${key}-${j}`)}</li>)}</ul>)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i += 1 }
      blocks.push(<ol key={key++}>{items.map((item, j) => <li key={j}>{inline(item, resolve, `o${key}-${j}`)}</li>)}</ol>)
      continue
    }
    if (line.trim() === "") { i += 1; continue }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|```|>|\s*[-*]\s|\s*\d+\.\s|---+$)/.test(lines[i])) { buf.push(lines[i]); i += 1 }
    blocks.push(<p key={key++}>{inline(buf.join(" "), resolve, `p${key}`)}</p>)
  }
  return <div className={`app-md${dense ? " app-md-dense" : ""}`}>{blocks}</div>
}

/** Acknowledges a completed clipboard write for 1.5 s; failures remain retryable. */
export const useCopied = () => {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const copying = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async (text: string) => {
    if (copying.current) return
    copying.current = true
    clearTimeout(timer.current)
    setCopied(false)
    setFailed(false)
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(text)
      setCopied(true)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      setFailed(true)
    } finally {
      copying.current = false
    }
  }
  return { copied, failed, copy }
}

/** A live seconds counter, frozen for screenshots. */
export const useElapsed = (baseSeconds: number, live: boolean) => {
  const [extra, setExtra] = useState(0)
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setExtra(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [live])
  const total = baseSeconds + extra
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes} m ${seconds} s` : `${seconds} s`
}

export const SkeletonRows = ({ rows = 5 }: { rows?: number }) => (
  <div aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => (
      <div className="app-skel-row" key={i}><span className="app-skel-dot" /><span className="app-skel" style={{ width: `${34 + (i * 17) % 40}%` }} /></div>
    ))}
  </div>
)

export const ReadError = ({ what, onRetry }: { what: string; onRetry: () => void }) => (
  <div className="app-error">
    <p className="app-error-title">Couldn't read {what}.</p>
    <p className="app-error-body">Check your connection, then try again.</p>
    <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={onRetry}>Retry</button>
  </div>
)
