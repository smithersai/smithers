import type { CSSProperties, ReactNode } from "react"
import { WORDMARK } from "./Wordmark"
import "./onboarding/guide.css"

/** The entrance stays mounted while runtime-dependent content loads beneath it. */
export function SessionShell({ children }: { children?: ReactNode }) {
  return (
    <div className="session-shell">
      <div className="guide-wordmark" aria-label="Smithers">
        <pre aria-hidden="true">
          {WORDMARK.map((line, i) => (
            <span key={i} style={{ "--row": i } as CSSProperties}>
              {line}{"\n"}
            </span>
          ))}
        </pre>
      </div>
      {children}
    </div>
  )
}
