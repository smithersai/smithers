/*
 * The repository welcome card and its three answers (controller/onboarding.ts).
 * Every button is the button door of a registered flow, dispatched through
 * onRunCommand with its args carried (a button never meets the form, except
 * the two contributor doors the brief names as doors ONTO a form: report an
 * issue and prototype a feature request). Every interactive element carries
 * data-flow with its flow name. Nothing is rendered that the payload does
 * not state: no activity sentence without the route's answer, no guide
 * document the repository does not hold.
 */
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { ACTIVITY_UNAVAILABLE, NO_CONTRIBUTING_GUIDE, welcomeSentence } from "../state/controller/onboarding"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { runtimeFlowName } from "../flows/FlowName"
import type { FlowName } from "../flows/FlowName"

type OnboardingCard = Extract<Card, { kind: "repo-onboarding" }>

export interface OnboardingCardActions {
  readonly onRunCommand: RunCommand
}

/** The maintainer's reads by flow name: the label the button wears and the args it carries. */
const MAINTAINER_DOORS: Readonly<Record<string, { readonly label: string; readonly args: (repo: string) => string }>> = {
  "issues.list": { label: "view issues", args: (repo) => `open ${repo}` },
  "prs.list": { label: "view pull requests", args: (repo) => repo },
  "runs.list": { label: "view runs", args: (repo) => repo },
  "triggers.list": { label: "view triggers", args: (repo) => repo }
}

const Door = ({
  flow,
  args,
  label,
  onRunCommand
}: { readonly flow: FlowName; readonly args?: string; readonly label: string } & OnboardingCardActions) => (
  <Button variant="ghost" size="sm" data-flow={flow} data-testid={`onboarding-${flow}`} onClick={() => onRunCommand(flow, args)}>
    {label}
  </Button>
)

export const RepoOnboardingCardBody = ({ card, onRunCommand }: { readonly card: OnboardingCard } & OnboardingCardActions) => {
  const { payload } = card
  const { repo } = payload
  if (payload.stage === "welcome") {
    return (
      <div className="repo-onboarding" data-stage="welcome">
        <p data-testid="onboarding-welcome">{welcomeSentence(repo, payload.summary)}</p>
        <p>I am</p>
        <div className="flow-run-actions">
          <Door flow="repo.maintain" args={repo} label="maintaining this repo" onRunCommand={onRunCommand} />
          <Door flow="repo.contribute" args={repo} label="contributing to this repo" onRunCommand={onRunCommand} />
          <Door flow="repo.explore" args={repo} label="just exploring" onRunCommand={onRunCommand} />
        </div>
      </div>
    )
  }
  if (payload.stage === "maintain") {
    return (
      <div className="repo-onboarding" data-stage="maintain">
        <p data-testid="onboarding-activity">{payload.activity?.sentence ?? payload.reason ?? ACTIVITY_UNAVAILABLE}</p>
        <div className="flow-run-actions">
          {payload.flows.flatMap((flow) => {
            const door = MAINTAINER_DOORS[flow]
            return door === undefined
              ? []
              : [<Door key={flow} flow={runtimeFlowName(flow)} args={door.args(repo)} label={door.label} onRunCommand={onRunCommand} />]
          })}
        </div>
      </div>
    )
  }
  if (payload.stage === "contribute") {
    return (
      <div className="repo-onboarding" data-stage="contribute">
        <div className="flow-run-actions">
          <Door flow="issues.create" label="report an issue" onRunCommand={onRunCommand} />
          <Door flow="feature.prototype" label="prototype a new feature request" onRunCommand={onRunCommand} />
          {payload.guide === null
            ? null
            : <Door flow="files.read" args={`${payload.guide} ${repo}`} label="learn more about contributing" onRunCommand={onRunCommand} />}
        </div>
        {payload.guide === null
          ? <p className="smithers-card-note" data-testid="onboarding-no-guide">{payload.reason ?? NO_CONTRIBUTING_GUIDE}</p>
          : null}
      </div>
    )
  }
  return (
    <div className="repo-onboarding" data-stage="explore">
      <p data-testid="onboarding-wiki">The wiki is {repo}'s generated guide for humans and agents.</p>
      {payload.guides.length === 0
        ? <p className="smithers-card-note" data-testid="onboarding-no-guides">{payload.reason}</p>
        : (
          <>
            <p className="smithers-card-note">Smithers has not generated a wiki for {repo} yet. These are the guide documents the repository holds.</p>
            <ul className="world-card-list" data-testid="onboarding-guides">
              {payload.guides.map((guide) => (
                <li key={guide.path} className="world-card-row">
                  <Door flow="files.read" args={`${guide.path} ${repo}`} label={guide.path} onRunCommand={onRunCommand} />
                </li>
              ))}
            </ul>
          </>
        )}
      <p data-testid="onboarding-ask">Ask any question about {repo} in the chat.</p>
    </div>
  )
}

/* The repository welcome and its answers are read once; their buttons open other flows. */
export const onboardingCardFamily: CardFamily<"repo-onboarding"> = {
  "repo-onboarding": {
    render: (card, actions) => <RepoOnboardingCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
