import { Button, Card, CardContent, CardHeader, CardTitle, FlowFormView, Input, Label } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { BRANCH, REFUSAL_WORDS, RUN } from "../contract"
import type { RepoRunForm } from "../schema"
import { useRuns } from "./RunsContext"

// The runs page's Run card (docs/features/actions.md#running-a-flow-by-hand): a button per flow the repository lets a
// person run by hand; the branch it starts at, which reads the chosen flow's form again once left; and that form,
// drawn from the flow's payload schema, or a Run button for a flow that takes no inputs. A repository with no such
// flow shows no card.
export function RepoFlowsView() {
  const { queries, actions } = useRuns()
  const { data } = useLiveQuery(queries.form)
  const form = data?.[0] as RepoRunForm | undefined
  if (form === undefined || form.flows.length === 0) return null
  const busy = form.state === "loading" || form.state === "starting"
  const title = form.flows.find((flow) => flow.name === form.flow)?.title ?? form.flow ?? ""
  const inputs = form.schema as { readonly properties?: Readonly<Record<string, unknown>> } | null
  return (
    <Card className="repo-flows">
      <CardHeader>
        <CardTitle>{RUN}</CardTitle>
      </CardHeader>
      <CardContent className="repo-flows-content">
        <div className="repo-flows-list">
          {form.flows.map((flow) => (
            <Button
              key={flow.name}
              variant={form.flow === flow.name ? "default" : "outline"}
              disabled={busy}
              onClick={() => actions.chooseRepoFlow(flow.name)}
            >
              {flow.title ?? flow.name}
            </Button>
          ))}
        </div>
        {form.flow === null ? null : (
          <div className="repo-flows-branch">
            <Label htmlFor="repo-flows-branch">{BRANCH}</Label>
            <Input
              id="repo-flows-branch"
              value={form.ref ?? ""}
              disabled={busy}
              onChange={(event) => actions.setRunRef(event.currentTarget.value)}
              onBlur={() => actions.reloadRepoFlow()}
              onKeyDown={(event) => {
                if (event.key === "Enter") actions.reloadRepoFlow()
              }}
            />
          </div>
        )}
        {form.flow === null || inputs === null ? null : Object.keys(inputs.properties ?? {}).length === 0 ? (
          <Button disabled={busy} onClick={() => actions.runRepoFlow({})}>{RUN}</Button>
        ) : (
          <FlowFormView
            key={`${form.flow}@${form.ref}`}
            title={title}
            schema={inputs}
            submitLabel={RUN}
            size="full"
            onSubmit={(submission) => actions.runRepoFlow(submission.data)}
          />
        )}
        {form.refusal === null ? null : <p role="alert">{REFUSAL_WORDS[form.refusal] ?? form.refusal}</p>}
      </CardContent>
    </Card>
  )
}
