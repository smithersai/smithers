import { Input } from "@smthrs/ui"
import { useNavigate } from "@tanstack/react-router"
import { useLayoutEffect, useRef } from "react"
import { useIssues } from "./IssuesContext"

/**
 * The caret of the pending screen's box, as that screen went with the box focused: the list's box mounting in the same
 * commit, on the same repository, takes it. A microtask forgets it, so an abandoned load or a later page never does.
 */
let carried: { readonly owner: string; readonly repo: string; readonly start: number | null; readonly end: number | null } | undefined

/**
 * The issues list's search box, the same on the list's pending screen (`pending`) and on the list: `q` from the URL,
 * each keystroke written back to it, and, when `ask`, to the issues route (`actions.search`), so a search on a list
 * that hasn't synced doesn't wait for it. The list's pending screen shows it while the route still loads, so a cold page
 * takes a search as soon as the app renders; when the list replaces it, the list's own box takes its focus and caret.
 */
export function IssueSearchBox({ owner, repo, q, ask, pending = false }: {
  readonly owner: string
  readonly repo: string
  readonly q: string | undefined
  readonly ask: boolean
  readonly pending?: boolean
}) {
  const { actions } = useIssues()
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    const element = input.current
    if (!pending && element !== null && carried !== undefined && carried.owner === owner && carried.repo === repo) {
      element.focus()
      element.setSelectionRange(carried.start, carried.end)
      carried = undefined
    }
    return () => {
      if (pending && element !== null && element.ownerDocument.activeElement === element) {
        const caret = { owner, repo, start: element.selectionStart, end: element.selectionEnd }
        carried = caret
        queueMicrotask(() => {
          if (carried === caret) carried = undefined
        })
      }
    }
  }, [owner, repo, pending])
  return (
    <Input ref={input} aria-label="Search issues" placeholder="Search issues" value={q ?? ""}
      onChange={(event) => {
        const value = event.currentTarget.value
        if (ask) actions.search(owner, repo, value)
        void navigate({
          to: "/$owner/$repo/issues",
          params: { owner, repo },
          search: (previous: Record<string, unknown>) => ({ ...previous, q: value }),
          replace: true,
          resetScroll: false,
        })
      }} />
  )
}
