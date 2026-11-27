import { Badge, Button, Card, CardContent, Input } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useNavigate } from "@tanstack/react-router"
import { useAuth } from "../../auth/components/AuthContext"
import { SignInButton } from "../../auth/components/SignInButton"
import { formatUsd } from "../../billing/contract"
import { INSTALL } from "../../repo/contract"
import { DONE, GET_STARTED, OPEN, REPOSITORY, REPOSITORY_FIELD, REPOSITORY_PLACEHOLDER, STEP_TITLES } from "../contract"
import type { Step } from "../schema"
import { repositoryNamed } from "../view"
import { useFirstRun } from "./FirstRunContext"
import "./first-run.css"

const MARK = { done: "success", next: "default", later: "muted" } as const

// The first run's steps (decision 0121, 0175), just above the composer's place on `/app` until the person has a
// conversation of their own. For a 3rd-party contributor without a role on the deployment repo, it surfaces their two
// clear paths: fork a repo and bring their own agent for free over MCP, or add prepaid credits for cloud sandboxes.
export function FirstRunSteps() {
  const { queries, actions } = useFirstRun()
  const { data: session } = useLiveQuery(useAuth().queries.session)
  const navigate = useNavigate()
  const { data: firstRun } = useLiveQuery(queries.state)
  if (firstRun?.show !== "steps") return null
  const isContributorStep = firstRun.at === REPOSITORY
  const balance = session?.computeBalanceMicroUsd ?? 0
  const hasPaidCompute = session?.computeAccess === "paid"

  const action = (step: Step) => {
    if (step.state !== "next") return null
    if (step.id === "sign_in") return <SignInButton />
    if (step.id === REPOSITORY) {
      return (
        <form
          className="first-run-open"
          onSubmit={(event) => {
            event.preventDefault()
            const named = repositoryNamed(String(new FormData(event.currentTarget).get("repository") ?? ""))
            if (named === undefined) return
            actions.press(REPOSITORY)
            void navigate({ to: "/$owner/$repo", params: named })
          }}
        >
          <Input
            name="repository"
            aria-label={REPOSITORY_FIELD}
            placeholder={REPOSITORY_PLACEHOLDER}
            required
            pattern="\s*(https?:\/\/(www\.)?github\.com\/)?[^\/\s]+\/[^\/\s]+\/?\s*"
            autoComplete="off"
            spellCheck={false}
          />
          <Button size="sm" type="submit">{OPEN}</Button>
          {session?.install === undefined ? null : (
            <Button asChild size="sm" variant="outline">
              <a href={session.install} target="_blank" rel="noopener noreferrer">{INSTALL}</a>
            </Button>
          )}
        </form>
      )
    }
    return null
  }
  return (
    <section className="first-run" aria-label={GET_STARTED}>
      <Card>
        <CardContent>
          <ol className="first-run-steps">
            {firstRun.steps.map((step, index) => (
              <li
                key={step.id}
                className="first-run-step"
                data-step={step.id}
                data-state={step.state}
                aria-current={step.state === "next" ? "step" : undefined}
              >
                {step.state === "done"
                  ? <Badge variant={MARK.done} role="img" aria-label={DONE}>✓</Badge>
                  : <Badge variant={MARK[step.state]} aria-hidden="true">{index + 1}</Badge>}
                <span className="first-run-title">{STEP_TITLES[step.id]}</span>
                {action(step)}
              </li>
            ))}
          </ol>
          {isContributorStep ? (
            <div className="first-run-contributor" aria-label="Contributor options">
              <div className="first-run-quick-repos">
                <span>Browse &amp; fork:</span>
                <Link to="/$owner/$repo" params={{ owner: "smithersai", repo: "smithers" }}>smithersai/smithers</Link>
                <Link to="/$owner/$repo" params={{ owner: "smithersai", repo: "vibelang" }}>smithersai/vibelang</Link>
              </div>
              <div className="first-run-modes">
                <Button asChild size="sm" variant="outline">
                  <Link to="/app/settings">Connect your agent (Free)</Link>
                </Button>
                <Button asChild size="sm" variant={hasPaidCompute ? "outline" : "solid"}>
                  <Link to="/app/settings">
                    {hasPaidCompute ? `Cloud credits (${formatUsd(balance)})` : "Add cloud credits"}
                  </Link>
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  )
}
