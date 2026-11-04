import { Button, Card, CardContent, EmptyState, ItemConversation } from "@smthrs/ui"
import { SETTLED, SLOT } from "../../../firstPaint/settled"
import { githubIssueUrl } from "../contract"
import { conversationProps, type earlySummaryOf } from "../view"

/** A known heading, or the requested issue number while its early read is unanswered or unavailable. */
export function IssueHeading({ owner, repo, number, summary, unavailable = false, onRetry }: {
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly summary: ReturnType<typeof earlySummaryOf>
  readonly unavailable?: boolean
  readonly onRetry?: () => void
}) {
  return <>
    {summary === undefined
      ? <div {...(unavailable ? SETTLED : SLOT)}><h1 className="issue-unread-heading">Issue #{number}</h1></div>
      : <div {...SETTLED}><ItemConversation {...conversationProps({ ...summary, body: "" }, [], { owner, name: repo })} /></div>}
    {unavailable ? <Card><CardContent>
      <EmptyState title="Issue unavailable here" action={<>
        {onRetry === undefined ? null : <Button variant="outline" onClick={onRetry}>Try again</Button>}
        {" "}<Button asChild variant="outline"><a href={githubIssueUrl(owner, repo, number)} target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a></Button>
      </>} />
    </CardContent></Card> : null}
  </>
}
