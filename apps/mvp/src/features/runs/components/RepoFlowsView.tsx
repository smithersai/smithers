import { Button, Card, CardContent, CardHeader, CardTitle, FlowFormView, Input, Label, LoadingBar } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { BRANCH, repoFlowRefusalWords, RETRY, RUN } from "../contract"
import type { RunsActions } from "../runs.vibe"
import type { RepoRunForm } from "../schema"
import { useRuns } from "./RunsContext"

// The runs page's Run card (docs/features/actions.md#running-a-flow-by-hand): a button per flow the repository lets a
// person run by hand; the branch it starts at, which invalidates the old form when edited; and that form,
// drawn from the flow's payload schema, or a Run button for a flow that takes no inputs. A repository with no such
// flow shows no card after a successful read; a failed read keeps its reason and Retry.
export function RepoFlowsView() {
  const { queries, actions } = useRuns()
  const { data } = useLiveQuery(queries.form)
  const form = data?.[0] as RepoRunForm | undefined
  return form === undefined ? null : <RepoFlowCard form={form} actions={actions} />
}

export function RepoFlowCard({ form, actions }: {
  form: RepoRunForm
  actions: Pick<RunsActions, "chooseRepoFlow" | "setRunRef" | "reloadRepoFlow" | "runRepoFlow">
}) {
  if (form.state === "idle" || (form.state === "ready" && form.flows.length === 0)) return null
  const busy = form.state === "loading" || form.state === "starting"
  const title = form.flows.find((flow) => flow.name === form.flow)?.title ?? form.flow ?? ""
  const inputs = form.schema as { readonly properties?: Readonly<Record<string, unknown>> } | null
  return (
    <Card className="repo-flows" aria-busy={busy}>
      <CardHeader>
        <CardTitle>{RUN}</CardTitle>
      </CardHeader>
      <CardContent className="repo-flows-content">
        <LoadingBar loading={busy} placement="inline" label={form.state === "starting" ? "Starting run" : "Loading flows"} />
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
              disabled={form.state === "starting"}
              onChange={(event) => actions.setRunRef(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !busy && event.currentTarget.value.length > 0) actions.reloadRepoFlow()
              }}
            />
          </div>
        )}
        {form.flow === null ? null : inputs === null || Object.keys(inputs.properties ?? {}).length === 0 ? (
          <Button disabled={busy || !form.ref} onClick={() => actions.runRepoFlow({})}>{RUN}</Button>
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
        {form.refusal === null ? null : <p role="alert">{repoFlowRefusalWords(form.refusal, form.flows.length === 0)}</p>}
        {form.state === "refused" && form.flows.length === 0 ? <Button onClick={actions.reloadRepoFlow}>{RETRY}</Button> : null}
      </CardContent>
    </Card>
  )
}
