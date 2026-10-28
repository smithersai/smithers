import { Badge, Button } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useTodos } from "./TodosContext"
import { DISCARD, EDIT } from "../contract"
import { notSentRows } from "../view"

/** One recovery surface on both the list and detail, including refused input storage. */
export function NotSentChanges({ repoId, number }: { readonly repoId: string; readonly number?: number }) {
  const { queries, actions } = useTodos()
  const { data: view } = useLiveQuery(queries.view)
  const { data: requested } = useLiveQuery(queries.requested)
  const { data: sending } = useLiveQuery(queries.sending)
  const failures = (view?.admissionFailures ?? []).filter(row => !requested.some(held => held.id === row.id))
  const notSent = notSentRows(repoId, [...requested, ...failures].filter(row => number === undefined || row.number === number), sending)
  return (
    <>
      {notSent.length === 0 ? null : (
        <ul className="stack-not-sent" aria-label="Not sent">
          {notSent.map((change) => (
            <li key={change.id} className="stack-not-sent-row">
              <span className="stack-not-sent-label">{change.label}</span>
              <Badge variant="destructive">{change.reason}</Badge>
              {change.reason === "Not sent" ? <Button variant="outline" size="sm" onClick={() => void actions.retryChange(change.id)}>Retry</Button> : null}
              {change.op === "commit" ? (
                <Button variant="outline" size="sm" onClick={() => actions.edit(change.id)}>{EDIT}</Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => actions.discard(change.id)}>{DISCARD}</Button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
