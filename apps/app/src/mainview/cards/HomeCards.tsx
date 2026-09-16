import { flowAction } from "../flows/FlowAction"
/* Repository-declared blocks and featured flow buttons. Unmeasured benchmarks stay hidden. */
import { Button } from "@smthrs/ui"
import type { HomeBlock } from "@smthrs/rpc/HomePane"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import type { FlowName } from "../flows/FlowName"

type HomeCard = Extract<Card, { kind: "repo-home" }>

export interface HomeCardActions {
  readonly onRunCommand: RunCommand
}

const Door = ({
  flow,
  args,
  label,
  title,
  onRunCommand
}: { readonly flow: FlowName; readonly args: string; readonly label: string; readonly title?: string } & HomeCardActions) => (
  <Button title={title} variant="ghost" size="sm"  data-testid={`home-${flow}`} {...flowAction(onRunCommand, flow, args)}>
    {label}
  </Button>
)

const BlockBody = ({ block, card, onRunCommand }: { readonly block: HomeBlock; readonly card: HomeCard } & HomeCardActions) => {
  const { repo, featuredFlows, featuredReason } = card.payload
  switch (block.type) {
    case "text":
      return <p data-testid="home-text">{block.text}</p>
    case "links":
      return (
        <ul className="world-card-list" data-testid="home-links">
          {block.links.map((link) => (
            <li key={link.url} className="world-card-row">
              <a className="repo-home-link" href={link.url} target="_blank" rel="noreferrer">{link.label}</a>
            </li>
          ))}
        </ul>
      )
    case "flows":
      return featuredFlows === null
        ? <p className="smithers-card-note" data-testid="home-no-flows">{featuredReason}</p>
        : featuredFlows.length === 0
        ? <p className="smithers-card-note" data-testid="home-no-flows">{repo} features no flows yet.</p>
        : (
          <ul className="world-card-list" data-testid="home-flows">
            {featuredFlows.map((flow) => (
              <li key={flow.id} className="repo-home-flow">
                <Door flow="flow.run" args={`${flow.id} ${repo}`} label={`/${flow.id}`} title={flow.summary ?? undefined} onRunCommand={onRunCommand} />
              </li>
            ))}
          </ul>
        )
    case "ci-benchmark":
      return null
  }
}

export const RepoHomeCardBody = ({ card, onRunCommand }: { readonly card: HomeCard } & HomeCardActions) => (
  <div className="repo-home" data-testid="repo-home">
    {card.payload.blocks.filter(block => block.type !== "ci-benchmark").map((block, index) => (
      <section key={index} className="repo-home-block" data-block={block.type}>
        {block.title === undefined ? null : <h4>{block.title}</h4>}
        <BlockBody block={block} card={card} onRunCommand={onRunCommand} />
      </section>
    ))}
  </div>
)

/* The home pane is read once; its buttons open other flows. */
export const homeCardFamily: CardFamily<"repo-home"> = {
  "repo-home": {
    render: (card, actions) => <RepoHomeCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
