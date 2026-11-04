import { Button, PageBody, PageHeader } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useParams } from "@tanstack/react-router"
import { useIssues } from "../../features/issues/components/IssuesContext"
import { IssueHeading } from "../../features/issues/components/IssueHeading"
import { earlySummaryOf } from "../../features/issues/view"
import { repoId } from "../../features/repo/contract"
import "./issues-screen.css"

/** The direct page reads its heading before the route finishes opening Electric collections. */
export function IssuePendingScreen() {
  const params = useParams({ strict: false })
  const owner = params.owner ?? ""
  const repo = params.repo ?? ""
  const number = Number(params.number)
  const { data: read } = useLiveQuery(useIssues().queries.searched)
  return (
    <main className="issues-screen">
      <PageHeader className="repo-header" width="wide" title={<Link to="/$owner/$repo" params={{ owner, repo }}>{owner} / {repo}</Link>} />
      <PageBody width="wide">
        <Button asChild variant="ghost"><Link to="/$owner/$repo/issues" params={{ owner, repo }}>Issues</Link></Button>
        <IssueHeading owner={owner} repo={repo} number={number} summary={earlySummaryOf(read?.[0], repoId(owner, repo), number)} />
      </PageBody>
    </main>
  )
}
