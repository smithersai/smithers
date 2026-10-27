import { Button, Textarea } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import { type BugsTab, MAX_WHAT, reasonOf } from "../tab"
import "./bugs.css"

// The form (docs/features/bugs.md#the-form): one field and Send. The report also carries the page before this
// one, the build, and the tab's latest run ids, trace ids and failure codes, never chat. Once it is filed, Sent and
// GitHub's prefilled form for it, which files nothing until the person submits it there. A report that wasn't sent
// says why and keeps the words, and the button sends it again.
export function Report({ tab }: { readonly tab: BugsTab }) {
  const { sending } = tab.queries
  const state = useSyncExternalStore(sending.subscribe, sending.current)
  return (
    <form
      className="bugs-form"
      data-page-focus=""
      aria-label="Report a bug"
      onSubmit={(event) => {
        event.preventDefault()
        const what = new FormData(event.currentTarget).get("what")
        if (typeof what === "string") tab.actions.send(what)
      }}
    >
      {/* The words stay until their report is Sent; then the field starts empty for the next one. A report sent right
          after another starts the field again with its own words. */}
      <Textarea
        key={state.status === "sent" ? state.report.id : "draft"}
        defaultValue={state.status === "sending" || state.status === "failed" || state.status === "invalid" ? state.what : ""}
        name="what"
        aria-label="What happened?"
        placeholder="What happened?"
        required
        maxLength={MAX_WHAT}
        rows={6}
        autoFocus
      />
      <div className="bugs-form-row">
        <Button type="submit" disabled={state.status === "sending"}>{state.status === "failed" ? "Retry" : "Send"}</Button>
        <p className="bugs-form-status" role="status" aria-live="polite">
          {state.status === "sending" ? "Sending" : null}
          {state.status === "invalid" ? (state.code === "empty" ? "Write what happened" : "Report too long") : null}
          {state.status === "failed" ? `Not sent · ${reasonOf(state.code)}` : null}
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
