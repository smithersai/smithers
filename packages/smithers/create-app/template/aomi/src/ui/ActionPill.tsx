// TEMP: delete this file and import the component from @smthrs/ui once that
// package exports one.
/**
 * A high-contrast ink pill under the composer. Distinct from `Suggestion` in
 * @smthrs/ui, which is a ghost chip: this one is a filled call to action with
 * an optional trailing shortcut hint.
 */
import type { ReactNode } from "react"

export interface ActionPillProps {
  readonly label: ReactNode
  /** Trailing keyboard hint, e.g. "⇧Tab". */
  readonly hint?: string
  readonly disabled?: boolean
  readonly onClick: () => void
}

export function ActionPill({ label, hint, disabled = false, onClick }: ActionPillProps) {
  return (
    <button type="button" className="aomi-action-pill" disabled={disabled} onClick={onClick}>
      <span>{label}</span>
      {hint === undefined ? null : <span className="aomi-action-pill-hint">{hint}</span>}
    </button>
  )
}
