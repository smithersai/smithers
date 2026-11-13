/* Small shared UI for the front pages: buttons, icons, the copy-to-clipboard button. */
import { useEffect, useRef, useState, type ReactNode } from "react"

/* 16px inline SVGs, stroke currentColor, 1.5 stroke, no fill. */
const Svg = ({ children }: { children: ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)

export const IconCheck = () => <Svg><path d="M3 8.5l3.2 3.2L13 4.8" /></Svg>
export const IconX = () => <Svg><path d="M4 4l8 8M12 4l-8 8" /></Svg>
export const IconCopy = () => <Svg><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5" /></Svg>
export const IconExternal = () => <Svg><path d="M6.5 3.5h-3v9h9v-3" /><path d="M9.5 3.5h3v3" /><path d="M12.5 3.5L7 9" /></Svg>
export const IconChevron = () => <Svg><path d="M5 6.5l3 3 3-3" /></Svg>
export const IconClock = () => <Svg><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2.2 1.3" /></Svg>

/** One bordered 44 px command row: `$ command` in mono (scrolls inside on phone), Copy inside at the right end. */
export const CommandRow = ({ command, primary = false, copied = false, className = "" }: {
  command: string; primary?: boolean; copied?: boolean; className?: string
}) => (
  <div className={`front-cmd ${className}`}>
    <code className="front-cmd-text"><span className="front-cmd-prompt" aria-hidden="true">$ </span>{command}</code>
    <CopyButton text={command} primary={primary} initialCopied={copied} className="front-cmd-copy" />
  </div>
)

/** Copies text and shows `copiedLabel` for 1.5 s. Used for code, the install line and share links. */
export const CopyButton = ({ text, label = "Copy", copiedLabel = "Copied", primary = false, className = "", initialCopied = false }: {
  text: string; label?: string; copiedLabel?: string; primary?: boolean; className?: string; initialCopied?: boolean
}) => {
  const [copied, setCopied] = useState(initialCopied)
  const [failed, setFailed] = useState(false)
  const copying = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
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
  return (
    <button type="button" className={`front-btn ${primary ? "front-btn-primary" : "front-btn-secondary"} ${className}`} onClick={copy} aria-live="polite">
      {failed ? <IconX /> : copied ? <IconCheck /> : label === "Copy" ? <IconCopy /> : null}
      {failed ? "Copy failed. Retry" : copied ? copiedLabel : label}
    </button>
  )
}

/** Tracks the actual scrolling body so the right-edge cue clears at the end. */
export const CodeScroll = ({ children, table = false }: { children: ReactNode; table?: boolean }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    const root = ref.current
    const body = table ? root?.querySelector<HTMLElement>(".front-doc-tablewrap") : root?.querySelector<HTMLElement>("textarea") ?? root?.querySelector<HTMLElement>("pre")
    if (!root || !body) return
    const update = () => setHidden(body.scrollWidth - body.clientWidth - body.scrollLeft > 1)
    const observer = new ResizeObserver(update)
    observer.observe(body)
    const content = body.querySelector(table ? "table" : "code")
    if (content) observer.observe(content)
    body.addEventListener("scroll", update)
    update()
    return () => { observer.disconnect(); body.removeEventListener("scroll", update) }
  }, [children, table])
  return <div ref={ref} className="front-code-scroll" data-hidden-right={hidden}>{children}</div>
}
