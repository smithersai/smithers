import { isWriterOwnershipError, type WriterOwnershipError } from "./state/StorageRecoveryContract"
import { useSmithersHere } from "./state/WriterOwnership"
import { useState, type CSSProperties } from "react"
import { errorMessage } from "./state/ClientErrors"
import { createStartupRecovery, mountStartupRecovery } from "./StartupRecovery"
import { BootstrapFailure } from "./runtime/Runtime"
import { switchBackendTarget } from "./runtime/BackendTargetSelection"

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
type StartupFailure = { readonly kind: "generic"; readonly message: string } | WriterOwnershipError | BootstrapFailure

const startupFailure = (reason: unknown): StartupFailure =>
  isWriterOwnershipError(reason) || reason instanceof BootstrapFailure
    ? reason : { kind: "generic", message: startupErrorMessage(reason) }

function BootstrapErrorPanel({ failure }: { readonly failure: BootstrapFailure }) {
  const [choosing, setChoosing] = useState(false)
  const [invalid, setInvalid] = useState(false)
  return <main style={PANEL_STYLE}>
    <h1>Backend unavailable</h1>
    <p>{failure.message}</p>
    <button type="button" onClick={() => window.location.reload()}>Retry</button>{" "}
    <button type="button" onClick={() => setChoosing(true)}>Switch backend</button>
    {choosing && <form onSubmit={async (event) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget)
      const origin = String(data.get("origin") ?? "").trim()
      const token = String(data.get("token") ?? "").trim()
      try {
        const native = window.__electrobun !== undefined
        if (native) {
          const { nativeSwitchBackendTarget } = await import("./native/NativeBridge")
          await nativeSwitchBackendTarget(origin, token)
          window.location.reload()
          return
        }
        if (token === "") {
          const url = new URL(origin)
          if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error()
          window.location.assign(url.origin)
          return
        }
        switchBackendTarget(origin, token, window.location.origin)
        window.location.reload()
      } catch { setInvalid(true) }
    }}>
      <label>Backend URL <input name="origin" type="url" required placeholder="https://backend.example" /></label>
      <label>Access token <input name="token" type="password" autoComplete="off" /></label>
      <button type="submit">Connect</button>
      {invalid && <p role="alert">Invalid backend URL.</p>}
    </form>}
  </main>
}

export function StartupErrorPanel({ message, reason = message }: { readonly message?: string; readonly reason?: unknown }) {
  const failure = startupFailure(reason)
  switch (failure.kind) {
    case "unreachable":
    case "missing":
    case "server":
    case "invalid": return <BootstrapErrorPanel failure={failure} />
    case "writer-held":
      return <main style={PANEL_STYLE}>
        <h1>Smithers is open in another tab</h1>
        <p>Use Smithers here or close that tab and reload.</p>
        <button type="button" onClick={useSmithersHere}>Use Smithers here</button>{" "}
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </main>
    case "writer-moved":
      return <main style={PANEL_STYLE}>
        <h1>Smithers moved to another tab</h1>
        <button type="button" onClick={useSmithersHere}>Use Smithers here</button>
      </main>
    case "generic": break
    default: { const exhaustive: never = failure; return exhaustive }
  }
  return (
    <main style={PANEL_STYLE}>
      <h1>{HEADING}</h1>
      <pre style={DETAIL_STYLE}>{failure.message}</pre>
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
