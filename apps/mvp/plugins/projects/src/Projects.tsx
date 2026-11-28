import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, StatusPill } from "@smthrs/ui"
import { Link } from "@tanstack/react-router"
import { useSyncExternalStore } from "react"
import type { ProjectSummary } from "../../../src/features/projects/schema"
import { projectsInAttentionOrder } from "./order"
import type { ProjectsTab } from "./tab.vibe"
import "./projects.css"

function ProjectCounts({ summary, pending }: {
  readonly summary: ProjectSummary | undefined
  readonly pending: boolean
}) {
  if (pending) return <span role="status" className="sui-sr-only" aria-label="Loading project counts" />
  if (summary?.access === "restricted") return <StatusPill status="idle" label="Member access required" />
  if (summary?.access !== "member") return <StatusPill status="idle" label="Access and counts unavailable" />
  return (
    <dl className="projects-counts">
      <div><dt>Open TODOs</dt><dd>{summary.openTodos ?? "Unavailable"}</dd></div>
      <div className={summary.needsAttention ? "projects-needs-you" : undefined}><dt>Needs attention</dt><dd>{summary.needsAttention ?? "Unavailable"}</dd></div>
      <div><dt>Open plan items</dt><dd>{summary.openPlanNodes ?? "Unavailable"}</dd></div>
    </dl>
  )
}

function Project({ project, summary, pending }: {
  readonly project: string
  readonly summary: ProjectSummary | undefined
  readonly pending: boolean
}) {
  const [owner, repo] = project.split("/") as [string, string]
  return (
    <Card className="projects-card" aria-label={project}>
      <CardHeader>
        <CardTitle className="projects-name">{project}</CardTitle>
      </CardHeader>
      <CardContent className="projects-detail">
        <ProjectCounts summary={summary} pending={pending} />
        <div className="projects-links">
          <Button asChild size="sm" variant="outline">
            <Link to="/$owner/$repo/workbench" params={{ owner, repo }} aria-label={`${project} Workbench`}>Workbench</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/$owner/$repo/runs" params={{ owner, repo }} aria-label={`${project} Runs`}>Runs</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function Projects({ tab }: { readonly tab: ProjectsTab }) {
  const source = tab.queries.projects
  const [snapshot] = useSyncExternalStore(source.subscribe, source.current, source.current)
  const summaries = new Map(snapshot?.summaries.map((summary) => [summary.project, summary]))
  const ordered = projectsInAttentionOrder(snapshot?.projects ?? [], summaries)
  const loading = snapshot === undefined || snapshot.status === "loading"
  return (
    <>
      {loading ? <span role="status" className="sui-sr-only" aria-label="Loading projects" />
        : snapshot.status === "unavailable" ? <EmptyState title="Projects unavailable" />
        : snapshot.projects.length === 0 ? <EmptyState title="No saved projects" />
        : <ul className="projects-list">
            {ordered.map((project) => (
              <li key={project}>
                <Project project={project} summary={summaries.get(project)} pending={snapshot.summariesPending && !summaries.has(project)} />
              </li>
            ))}
          </ul>}
    </>
  )
}
