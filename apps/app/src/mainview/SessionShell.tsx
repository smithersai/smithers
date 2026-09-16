import type { CSSProperties,ReactNode } from "react";
import "./SessionShell.css";
import { WORDMARK } from "./Wordmark";

/** The entrance stays mounted while runtime-dependent content loads beneath it. */
export function SessionShell({ children, navigation }: { children?: ReactNode; navigation?: ReactNode }) {
  return (
    <div className="session-shell">
      {navigation ?? <div className="guide-wordmark" aria-label="Smithers">
        <pre aria-hidden="true">
          {WORDMARK.map((line, i) => (
            <span key={i} style={{ "--row": i } as CSSProperties}>
              {line}{"\n"}
            </span>
          ))}
        </pre>
      </div>}
      {children}
    </div>
  )
}
