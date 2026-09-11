import type { CSSProperties } from "react"
import { errorMessage } from "./state/ClientErrors"
import { createStartupRecovery, mountStartupRecovery } from "./StartupRecovery"

/*
 * Both panels below render the same declarations. They are written once, as
 * React style objects, and the DOM builder derives its `style` attribute from
 * them — a cosmetic edit here reaches both paths. Every value is a string so
 * that neither path has to reproduce React's unit handling for numbers.
 */
const PANEL_STYLE = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  maxWidth: "44rem",
  margin: "4rem auto",
  padding: "2rem",
  color: "#1a1a1a"
} as const satisfies CSSProperties

const DETAIL_STYLE = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: "#f4f1ea",
  padding: "1rem",
  borderRadius: "8px"
} as const satisfies CSSProperties

const cssText = (style: Readonly<Record<string, string>>): string =>
  Object.entries(style)
    .map(([property, value]) => `${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}: ${value}`)
    .join("; ")

const HEADING = "Smithers failed to start"
const HINT = "Reload to try again. If this persists, share the error above with the team."

/**
 * The detail text one failure gets.
 *
 * Boot survives some errors — a dying OPFS worker is recovered by the
 * localStorage fallback — so an earlier error is offered as context rather than
 * stated as the cause.
 */
export const startupErrorMessage = (reason: unknown, earlier?: unknown): string =>
  earlier === undefined
    ? errorMessage(reason)
    : [
      errorMessage(reason),
      "",
      "Earliest error while the page was blank (some are recovered, so this may not be the cause):",
      errorMessage(earlier)
    ].join("\n")

/** The panel React renders when a boot failure reaches the error boundary. */
export function StartupErrorPanel({ message }: { readonly message: string }) {
  return (
    <main style={PANEL_STYLE}>
      <h1>{HEADING}</h1>
      <pre style={DETAIL_STYLE}>{message}</pre>
      <p>{HINT}</p>
      <div ref={mountStartupRecovery} />
    </main>
  )
}

/**
 * The same panel built as DOM, for the failure React cannot report: a boot that
 * never resolves, or a bundle that never ran at all.
 */
export const createStartupErrorElement = (documentTarget: Document, message: string) => {
  const panel = documentTarget.createElement("main")
  panel.setAttribute("style", cssText(PANEL_STYLE))
  const heading = documentTarget.createElement("h1")
  heading.textContent = HEADING
  const detail = documentTarget.createElement("pre")
  detail.setAttribute("style", cssText(DETAIL_STYLE))
  detail.textContent = message
  const hint = documentTarget.createElement("p")
  hint.textContent = HINT
  const recovery = createStartupRecovery(documentTarget)
  panel.append(heading, detail, hint, recovery.element)
  return { element: panel, dispose: recovery.dispose }
}
