/*
 * The repository's home pane (controller/onboarding.ts repo.home): the first
 * card a repository shows, above the welcome. Every block is rendered from
 * the declared value the payload carries (@smthrs/rpc HomePane.ts refuses raw
 * HTML before it gets here); nothing is rendered that the payload does not
 * state. The featured flows are the catalog's rows or the honest line for
 * why they are absent; the CI benchmark names each measure and says "not
 * measured yet" until a number exists. Every button is the button door of a
 * registered flow through onRunCommand with its args carried and data-flow
 * set; links are anchors.
 */
import { Button } from "@smthrs/ui"
import { HOME_MEASURE_LABELS, NOT_MEASURED_YET } from "@smthrs/rpc/HomePane"
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
  onRunCommand
}: { readonly flow: FlowName; readonly args: string; readonly label: string } & HomeCardActions) => (
  <Button variant="ghost" size="sm" data-flow={flow} data-testid={`home-${flow}`} onClick={() => onRunCommand(flow, args)}>
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
              <a href={link.url} target="_blank" rel="noreferrer">{link.label}</a>
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
                <Door flow="flow.run" args={`${flow.id} ${repo}`} label={`/${flow.id}`} onRunCommand={onRunCommand} />
                {flow.summary === null ? null : <span className="world-card-path">{flow.summary}</span>}
              </li>
            ))}
          </ul>
        )
    case "ci-benchmark":
      return (
        <table className="repo-home-table" aria-label={block.title ?? "CI benchmark"} data-testid="home-ci-benchmark">
          <tbody>
            {block.measures.map((measure) => (
              <tr key={measure} data-measure={measure}>
                <td>{HOME_MEASURE_LABELS[measure]}</td>
                <td>{NOT_MEASURED_YET}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )
  }
}

export const RepoHomeCardBody = ({ card, onRunCommand }: { readonly card: HomeCard } & HomeCardActions) => (
  <div className="repo-home" data-testid="repo-home">
    {card.payload.blocks.map((block, index) => (
      <section key={index} className="repo-home-block" data-block={block.type}>
        {block.title === undefined ? null : <h4>{block.title}</h4>}
        <BlockBody block={block} card={card} onRunCommand={onRunCommand} />
      </section>
    ))}
    <p className="smithers-card-note" data-testid="home-source">
      Declared in .smithers/FACTORY.ts as <code>export const home</code>, projected to <code>{card.payload.path}</code>.{" "}
      <Door flow="files.read" args={`.smithers/FACTORY.ts ${card.payload.repo}`} label="Open FACTORY.ts" onRunCommand={onRunCommand} />
    </p>
  </div>
)

/* The home pane is read once; its buttons open other flows. */
export const homeCardFamily: CardFamily<"repo-home"> = {
  "repo-home": {
    render: (card, actions) => <RepoHomeCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
