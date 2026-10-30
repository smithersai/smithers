import type { Contribution } from "@smthrs/plugin"
import { Button, Kbd, Textarea } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { draftKey, fresh } from "../schema"
import { usePlugins } from "./PluginsContext"

type View = Contribution.Contributions["views"][number]

// The host's action strip (decision 0017, "The host owns person-only actions"): under a plugin's view, in host UI, the
// buttons for the item the view selected, each with its key, and one text box that fills every note. A press is the
// person's own door; plugin code never sends these. While a press is on its way the strip says Sending; a press that
// failed says Not sent and keeps the note, and pressing again retries.
export function ActionStrip({ view }: { readonly view: View }) {
  const { queries } = usePlugins()
  const { data: rows } = useLiveQuery(queries.views)
  const state = rows.find((row) => row.id === view.id) ?? fresh(view.id)
  return state.query === null
    ? null
    : <Strip key={JSON.stringify([state.query, state.params])} view={view} state={state} />
}

/** The strip over the query the view selected from. */
function Strip({ view, state }: { readonly view: View; readonly state: ReturnType<typeof fresh> }) {
  const { queries, actions } = usePlugins()
  const core = actions.core(state.query!, state.params)!
  const { data: items } = useLiveQuery(core.rows)
  const { data: notes } = useLiveQuery(queries.notes)
  const item = (items as ReadonlyArray<Readonly<Record<string, unknown>>>).find((row) => row[core.key] === state.item)
  const strip = actions.strip(view, item)
  const note = notes.find((row) => row.id === draftKey(view.id, state.item!))?.text ?? ""
  if (strip.buttons.length === 0 && !strip.note) return null
  return (
    <section className="action-strip" aria-label="Actions" data-slot="action-strip" data-sending={state.sending}>
      {strip.note
        ? (
          <Textarea
            aria-label="Note"
            aria-keyshortcuts="i"
            value={note}
            onChange={(event) => actions.setDraft(view.id, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") event.currentTarget.blur()
            }}
          />
        )
        : null}
      <div className="action-strip-buttons">
        {strip.buttons.map((button) => (
          <Button
            key={`${button.event}:${button.label}`}
            variant="outline"
            disabled={state.sending}
            onClick={() => actions.press(view.id, button, item)}
          >
            {button.label}
            {button.key === undefined ? null : <Kbd>{button.key}</Kbd>}
          </Button>
        ))}
      </div>
      {state.sending ? <p role="status">Sending</p> : state.failed ? <p role="alert">Not sent</p> : null}
    </section>
  )
}
