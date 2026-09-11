import { Check } from "lucide-react"
import type { ReactNode } from "react"

/*
 * Human instructions, numbered. A lesson that asks the human for a gesture
 * names the action button in its steps — "1. Click Log in to GitHub" —
 * so the ask reads as something to do, not a paragraph to decode. The steps
 * are the props; any lesson can use it.
 */
export function GuideSteps({ steps, done = false }: { steps: ReadonlyArray<ReactNode>; done?: boolean }) {
  return (
    <ol className="guide-steps">
      {steps.map((step, index) => (
        <li key={index}>
          <span className="guide-step-number" aria-hidden="true">{index + 1}</span>
          <span className="guide-step-body">{step}</span>
          {done && <Check className="guide-step-done" size={16} aria-label="Done" role="img" style={{ color: "var(--success)" }} />}
        </li>
      ))}
    </ol>
  )
}
