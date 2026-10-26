import { Button, Textarea } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import { type BugsTab, MAX_WHAT } from "../tab"
import "./bugs.css"

// The form (docs/features/bugs.md#the-form): one field and Send. The report also carries the page before this
// one, the build, and the tab's latest run ids, trace ids and failure codes, never chat. Once it is filed, Sent and
// GitHub's prefilled form for it, which files nothing until the person submits it there.
export function Report({ tab }: { readonly tab: BugsTab }) {
  const { sending } = tab.queries
  const state = useSyncExternalStore(sending.subscribe, sending.current)
  return (
    <form
      className="bugs-form"
      aria-label="Report a bug"
      onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const what = new FormData(form).get("what")
        if (typeof what !== "string") return
        tab.actions.send(what)
        form.reset()
      }}
    >
      <Textarea
        name="what"
        aria-label="What happened?"
        placeholder="What happened?"
        required
        maxLength={MAX_WHAT}
        rows={6}
        autoFocus
      />
      <div className="bugs-form-row">
        <Button type="submit" disabled={state.status === "sending"}>Send</Button>
        <p className="bugs-form-status" role="status" aria-live="polite">
          {state.status === "sending" ? "Sending" : null}
          {state.status === "refused" ? "Not sent" : null}
          {state.status === "sent"
            ? (
              <>
                Sent{" "}
                <a href={state.report.github} target="_blank" rel="noopener noreferrer">Open on GitHub</a>
              </>
            )
            : null}
        </p>
      </div>
    </form>
  )
}
