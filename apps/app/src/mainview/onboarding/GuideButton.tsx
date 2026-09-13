import type { ComponentProps, ReactNode } from "react"

/** Reserved tutorial controls; lesson keys must stay distinct from these. */
export const GUIDE_KEYS = { back: "b", dictation: "v", sound: "s", chat: "⌘K" } as const

export function guideShortcut(shortcut: string): string | undefined {
  if (shortcut === "⌘K") return "Meta+K Control+K"
  if (shortcut === "Tab ↵") return undefined
  return shortcut.toLowerCase() === "arrowright" ? "ArrowRight" : shortcut.toLowerCase()
}

export function GuideKey({ shortcut }: { shortcut: string }) {
  const label = shortcut === "⌘K" ? "⌘ K" : shortcut === "ArrowRight" ? "→" : shortcut
  return <kbd className="guide-button-key" aria-hidden="true"
    title={shortcut === "Tab ↵" ? "Tab to this button, then press Enter" : undefined}>{label}</kbd>
}

type GuideButtonProps = Omit<ComponentProps<"button">, "aria-keyshortcuts"> & {
  shortcut?: string
  children: ReactNode
}

/** One control presentation keeps the visible hint and accessible shortcut in sync. */
export function GuideButton({ shortcut, children, className = "", type = "button", ...props }: GuideButtonProps) {
  return <button {...props} type={type} className={`guide-button ${className}`.trim()}
    aria-keyshortcuts={shortcut === undefined ? undefined : guideShortcut(shortcut)}>
    <span className="guide-button-content">{children}</span>{" "}
    {shortcut !== undefined && <GuideKey shortcut={shortcut} />}
  </button>
}
