import { Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui"
import { draftStatusLine } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import {
  CODE,
  codePath,
  DELETE,
  draftPath,
  EDIT,
  NEEDS_SANDBOX,
  NEW_FLOW,
  NEW_FLOW_PATH,
  NO_FLOWS,
  RUN,
} from "../contract"
import { draftLabel } from "../draftLabels"
import { useFlowsUi } from "./FlowsUiContext"

// Your own flows (decision 0014 §5, `/app/flows`): each one's name and description with Run, Edit, Code and Delete,
// then the drafts not saved yet, each with Delete, and New flow. A flow whose code needs a machine can't run yet: Run is
// off, and the row says why. Any other flow, drafted or edited, runs in the QuickJS realm.
export function FlowsPage() {
  const { queries, actions } = useFlowsUi()
  const { data: flows } = useLiveQuery(queries.flows)
  const { data: drafts } = useLiveQuery(queries.drafts)
  return (
    <div className="flows-page">
      <div className="flows-page-actions">
        <Button asChild>
          <Link to={NEW_FLOW_PATH}>{NEW_FLOW}</Link>
        </Button>
      </div>
      {flows === undefined || flows.length === 0 ? <EmptyState title={NO_FLOWS} /> : (
        <Table aria-label="Flows">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {flows.map((flow) => (
              <TableRow key={flow.id}>
                <TableCell>{flow.name}</TableCell>
                <TableCell>{flow.description}</TableCell>
                <TableCell>
                  <Button
                    aria-label={`${RUN} ${flow.name}`}
                    disabled={flow.placement === "sandbox"}
                    onClick={() => actions.run(flow.name, flow.revision)}
                  >
                    {RUN}
                  </Button>
                  {flow.placement === "sandbox" ? <span>{NEEDS_SANDBOX}</span> : null}
                  <Button aria-label={`${EDIT} ${flow.name}`} variant="ghost" onClick={() => actions.edit(flow.name)}>{EDIT}</Button>
                  <Button asChild variant="ghost">
                    <Link aria-label={`${CODE} ${flow.name}`} to={codePath(flow.name) as never}>{CODE}</Link>
                  </Button>
                  <Button aria-label={`${DELETE} ${flow.name}`} variant="ghost" onClick={() => actions.remove(flow.id)}>
                    {DELETE}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {drafts === undefined || drafts.length === 0 ? null : (
        <Table aria-label="Drafts">
          <TableBody>
            {drafts.map((draft) => (
              <TableRow key={draft.id}>
                <TableCell>
                  <Link to={draftPath(draft.id) as never}>{draftLabel(draft, drafts)}</Link>
                </TableCell>
                <TableCell>{draftStatusLine(draft.status, draft.round)}</TableCell>
                <TableCell>
                  <Button
                    aria-label={`${DELETE} draft ${draftLabel(draft, drafts)}`}
                    variant="ghost"
                    onClick={() => actions.deleteDraft(draft.id)}
                  >
                    {DELETE}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
