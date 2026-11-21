import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Label } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { DEFAULT_LANES, DEFAULT_MAX_OPEN, MAX_LANES, MAX_OPEN_LIMIT, type StackBase } from "../contract"
import { useTodos } from "./TodosContext"

// Admin stack settings on /$owner/$repo/settings: lanes, max open TODOs, and default base (stacked vs independent).
// Uses pure flux state on TodosStore.view.settingsOutcome (no useState/useEffect).
export function StackSettings({ owner, repo }: { readonly owner: string; readonly repo: string }) {
  const { queries, actions } = useTodos()
  const { data: view } = useLiveQuery(queries.view)
  const outcome = view?.settingsOutcome

  return (
    <Card className="stack-settings">
      <CardHeader>
        <CardTitle>TODO stack</CardTitle>
        <CardDescription>Control parallel lanes, open TODO limit, and default stacking base.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="stack-settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const lanes = Number(data.get("lanes"))
            const maxOpen = Number(data.get("maxOpen"))
            const base = data.get("base") === "independent" ? "independent" : ("stacked" satisfies StackBase)
            if (!Number.isInteger(lanes) || lanes < 1 || lanes > MAX_LANES) return
            if (!Number.isInteger(maxOpen) || maxOpen < 1 || maxOpen > MAX_OPEN_LIMIT) return
            void actions.configure(owner, repo, { lanes, maxOpen, base })
          }}
        >
          <Field>
            <Label htmlFor="stack-lanes">Parallel lanes</Label>
            <Input id="stack-lanes" name="lanes" type="number" min={1} max={MAX_LANES} defaultValue={DEFAULT_LANES} required />
          </Field>
          <Field>
            <Label htmlFor="stack-max-open">Max open TODOs</Label>
            <Input id="stack-max-open" name="maxOpen" type="number" min={1} max={MAX_OPEN_LIMIT} defaultValue={DEFAULT_MAX_OPEN} required />
          </Field>
          <Field>
            <Label htmlFor="stack-base">Default base</Label>
            <select id="stack-base" name="base" defaultValue="stacked">
              <option value="stacked">Stacked on previous TODO</option>
              <option value="independent">Independent from base branch</option>
            </select>
          </Field>
          <div className="stack-settings-actions">
            <Button type="submit" size="sm" disabled={outcome?.status === "saving"}>
              {outcome?.status === "saving" ? "Saving…" : "Save stack settings"}
            </Button>
            {outcome?.status === "saved" ? <span role="status">Saved</span> : null}
            {outcome?.status === "failed" ? <span role="alert">Not saved ({outcome.code ?? "unavailable"})</span> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
