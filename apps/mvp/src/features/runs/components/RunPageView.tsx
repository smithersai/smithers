import { useMemo } from "react"
import {
  Button,
  EmptyState,
  JsonValue,
  RunHeader,
  RunJournal,
  RunWaterfall,
  FlowGraph,
  JournalScrubber,
  journalPosition,
  StepInspector,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import { ANSWER, OPEN, REFUSAL_WORDS, RESUME, RETRY, RETRY_FROM, RETRY_LATEST, STOP } from "../contract"
import { actsOf, journalOf, missingOf, repoRunStateOf, retriesFrom, selectedStep } from "../page"
import { headerStatusOf } from "../todoRun"
import { graphOf, runTitle } from "../graph"
import type { RunsActions } from "../runs"
import type { Inspection, RunTab, RunPage, RunView } from "../schema"
import { actionRunPath } from "../../actions/contract"
import { useRuns } from "./RunsContext"
import { RunSteers } from "./RunSteers"

// One run's page (decision 0014 §5): its header with Stop, Retry and Resume, then its steps with each one's input and
// output, its timeline and its journal. Every value is text the engine redacted and cut to 16 KiB before it left the
// engine; nothing here renders a value as markup. A run on Cloudflare (a TODO's, ruling TODO-3) reads the same, with
// `Cloud` in its header and Retry when failed, and lists the messages people sent its agent, with a composer while it works.
export function RunPageView() {
  const { queries, actions } = useRuns()
  const { data } = useLiveQuery(queries.page)
  const { data: repoRuns } = useLiveQuery(queries.repoRuns)
  if (data === undefined) return <Skeleton aria-label="Loading run" className="run-page-loading" />
  const { view, page } = data
  if (page.state === "loading") {
    const known = repoRuns.find((run) => run.execution === page.id)
    return known === undefined ? <Skeleton aria-label="Loading run" className="run-page-loading" /> : <RunHeader title={known.flow} state={repoRunStateOf(known.status)}
      startedAtMs={Date.parse(known.createdAt)} finishedAtMs={known.status === "running" ? null : Date.parse(known.updatedAt)}
      now={view.now ?? Date.now()} />
  }
  if (page.state !== "read") return <EmptyState title={missingOf(page, view.repo != null)} />
  return <ReadRunPage page={page} view={view} actions={actions} />
}

function ReadRunPage({ page, view, actions }: { page: RunPage; view: RunView; actions: RunsActions }) {
  const inspection = page.inspection as Inspection
  const { run } = inspection
  const now = view.now ?? Date.now()
  const at = view.at ?? null
  // The evidence fold is independent of the presentation clock; open bars use the current time below.
  const repo = view.repo ?? null
  // A repository's run opens the runs it started, its jobs, on its own pages (docs/features/actions.md).
  const frame = useMemo(
    () => graphOf(page, at, run.createdAtMs, repo === null ? undefined : (id) => actionRunPath(repo.owner, repo.name, id)),
    [page, at, run.createdAtMs, repo],
  )
  const graph = { ...frame, time: at === null ? now : frame.time }
  const steps = graph.steps
  const shown = selectedStep(steps, view.selected)
  const acts = actsOf(inspection, now, journalOf(page), repo !== null)
  const busy = view.acting !== null
  // Retry from here: the selected step, when it is this run's own and offers it.
  const from = shown?.node !== undefined && shown.node.runId === run.runId &&
      retriesFrom(inspection, repo !== null).has(shown.node.nodeId)
    ? shown.node.nodeId
    : null
  return (
    <div className="run-page" tabIndex={-1} onKeyDown={(event) => {
      const target = event.target as HTMLElement
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (target.closest("textarea,select,[contenteditable=true],input:not([type=range])")) return
      if (event.key === "[" || event.key === "]" || event.key === "{" || event.key === "}") {
        event.preventDefault()
        actions.scrub(journalPosition(graph.events, at, event.key === "[" || event.key === "{" ? -1 : 1, event.shiftKey))
      } else if (event.key.toLowerCase() === "l") {
        event.preventDefault(); actions.scrub(null)
      } else if (event.key === "Escape") actions.showInspector(false)
      else if (event.key === "i" && shown !== undefined) { event.preventDefault(); actions.inspectStep(shown.row.id) }
    }}>
      <RunHeader
        title={runTitle(run)}
        state={headerStatusOf(run)}
        cancelRequested={run.cancelRequestedAtMs !== null}
        startedAtMs={run.startedAtMs ?? run.createdAtMs}
        finishedAtMs={run.finishedAtMs}
        now={now}
        actions={
          <>
            {acts.stop ? <Button variant="outline" disabled={busy} onClick={actions.stop}>{STOP}</Button> : null}
            {acts.resume ? <Button variant="outline" disabled={busy} onClick={actions.resume}>{RESUME}</Button> : null}
            {acts.retry ? <Button disabled={busy} onClick={() => actions.retry("pinned")}>{RETRY}</Button> : null}
            {acts.retry && run.flowName === "flow/run"
              ? <Button variant="outline" disabled={busy} onClick={() => actions.retry("current")}>{RETRY_LATEST}</Button>
              : null}
            {run.waiting?.kind === "human"
              ? <Button asChild variant="outline"><Link to="/app">{ANSWER}</Link></Button>
              : null}
          </>
        }
      />
      {view.refusal === null ? null : <p role="alert">{REFUSAL_WORDS[view.refusal] ?? view.refusal}</p>}
      <RunSteers page={page} view={view} steps={steps} />
      <div className="run-page-values">
        <JsonValue label="Input" value={run.input} />
        {run.result === null ? null : <JsonValue label="Result" value={run.result} />}
      </div>
      <Tabs value={view.tab} onValueChange={(tab) => actions.showTab(tab as RunTab)}>
        <TabsList>
          <TabsTrigger value="steps" count={steps.length}>Steps</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="journal">Journal</TabsTrigger>
        </TabsList>
        <TabsContent value="steps">
          <JournalScrubber events={graph.events} at={at} onChange={actions.scrub} />
          <div className="run-page-graph" data-inspector={view.inspectorOpen !== false}>
            <FlowGraph nodes={graph.nodes} edges={graph.edges} selected={shown?.row.id ?? null} onSelect={actions.select} onInspect={actions.inspectStep} />
            {shown === undefined || view.inspectorOpen === false ? null : (
              <StepInspector key={shown.row.id} step={shown.row} attempts={shown.attempts} input={shown.input} output={shown.output}
                logs={shown.logs} wait={shown.wait} now={graph.time}
                actions={shown.href === null && from === null ? undefined : (
                  <>
                    {shown.href === null ? null : <Link to={shown.href as never}>{OPEN}</Link>}
                    {from === null
                      ? null
                      : <Button variant="outline" disabled={busy} onClick={() => actions.retryFrom(from)}>{RETRY_FROM}</Button>}
                  </>
                )} />
            )}
          </div>
          <RunWaterfall steps={graph.timeline.map((step) => step.row)} now={graph.time}
            cursorMs={at === null ? undefined : graph.time} selected={shown?.row.id ?? null} onSelect={actions.select}
            segments={graph.segments} />
        </TabsContent>
        <TabsContent value="timeline">
          <RunWaterfall
            steps={graph.timeline.map((step) => step.row)}
            now={graph.time}
            cursorMs={at === null ? undefined : graph.time}
            segments={graph.segments}
            selected={shown?.row.id ?? null}
            onSelect={actions.select}
          />
        </TabsContent>
        <TabsContent value="journal">
          <RunJournal events={journalOf(page)} originMs={run.createdAtMs} hasMore={page.hasMore} onMore={actions.more} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
