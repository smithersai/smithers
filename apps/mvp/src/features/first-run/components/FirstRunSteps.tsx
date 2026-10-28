import { Badge, Button, Input } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate } from "@tanstack/react-router"
import { OPEN_SETTINGS } from "../../auth/contract"
import { useAuth } from "../../auth/components/AuthContext"
import { SignInButton } from "../../auth/components/SignInButton"
import { INSTALL } from "../../repo/contract"
import { DONE, GET_STARTED, OPEN, REPOSITORY, REPOSITORY_FIELD, REPOSITORY_PLACEHOLDER, STEP_TITLES } from "../contract"
import type { Step } from "../schema"
import { repositoryNamed } from "../view"
import { useFirstRun } from "./FirstRunContext"
import "./first-run.css"

const MARK = { done: "success", next: "default", later: "muted" } as const

// The first run's steps (decision 0121), just above the composer's place on `/app` until the person has a conversation
// of their own: each step's mark (✓ once done, else its number) and title, and the current step's one action. Sign in
// is sign-in's own link; Open settings goes to Your model; at Ask, the composer's Chat ⌘K under the list is the button.
// For a person who may not ask in `/app`'s conversation (ruling AUTH-8), Open your repository takes the repository's
// name and opens its page, beside Install, the Smithers GitHub App's installation, when the deployment has one.
export function FirstRunSteps() {
  const { queries, actions } = useFirstRun()
  const { data: session } = useLiveQuery(useAuth().queries.session)
  const navigate = useNavigate()
  const { data: firstRun } = useLiveQuery(queries.state)
  if (firstRun?.show !== "steps") return null
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
    if (step.id !== "model") return null
    return (
      <Button
        size="sm"
        onClick={() => {
          actions.press("model")
          void navigate({ to: "/app/settings" })
        }}
      >
        {OPEN_SETTINGS}
      </Button>
    )
  }
  return (
    <section className="first-run" aria-label={GET_STARTED}>
      <ol className="first-run-steps">
        {firstRun.steps.map((step, index) => (
          <li
            key={step.id}
            className="first-run-step"
            data-step={step.id}
            data-state={step.state}
            aria-current={step.state === "next" ? "step" : undefined}
            {...(step.id === "model" && step.state === "next" ? { "data-add-model": "" } : {})}
          >
            {step.state === "done"
              ? <Badge variant={MARK.done} role="img" aria-label={DONE}>✓</Badge>
              : <Badge variant={MARK[step.state]} aria-hidden="true">{index + 1}</Badge>}
            <span className="first-run-title">{STEP_TITLES[step.id]}</span>
            {action(step)}
          </li>
        ))}
      </ol>
    </section>
  )
}
