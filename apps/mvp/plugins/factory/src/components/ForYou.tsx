import { Button, Markdown } from "@smthrs/ui"
import { type Decision, decisionsOf } from "../model"
import type { Host } from "@smthrs/plugin"
import type { FactoryTab } from "../tab"
import { Frame } from "./Frame"
import { Pill, Section, useWatched, type ViewProps } from "./parts"

// For you, for a maintainer: the decisions and reviews that wait on one, each with its body and links. The selected one
// is what the host's strip under the view answers through `feed/answer`, by option (`1`–`9`) with the note, or Answer
// (`⌘↵`) with the note alone; the factory never answers itself. Then the past decisions with the answer the collector
// read back, and the open spec questions.
export function ForYou({ tab, repository }: ViewProps) {
  return (
    <Frame tab={tab} repository={repository} view="factory/for-you">
      {(status) => {
        const { waiting, past } = decisionsOf(status)
        return (
          <>
            <Section title="Waiting" wide>
              {waiting.length === 0
                ? <p className="factory-muted">Nothing waiting</p>
                : <Waiting tab={tab} repository={repository!} waiting={waiting} />}
            </Section>
            <Section title="Past" wide>
              {past.map((decision) => (
                <details key={decision.id} className="factory-item" data-ask={decision.id}>
                  <summary><Header decision={decision} /></summary>
                  <Markdown content={decision.body} />
                  <Links decision={decision} />
                  {decision.answer === null ? null : (
                    <p className="factory-muted">
                      <b>{decision.answer.choice}</b>{decision.answer.text === "" ? null : `: ${decision.answer.text}`}
                    </p>
                  )}
                  {decision.decided === "" ? null : <p className="factory-muted">{decision.decided}</p>}
                </details>
              ))}
            </Section>
            <Section title="Open questions">
              <Button
                variant="outline"
                onClick={() => tab.actions.read(repository!, "report", "needs", "Open questions")}
              >
                Read
              </Button>
            </Section>
          </>
        )
      }}
    </Frame>
  )
}

/** The waiting decisions; the selected one is the strip's. */
function Waiting(
  { tab, repository, waiting }: {
    readonly tab: FactoryTab
    readonly repository: Host.Repository
    readonly waiting: ReadonlyArray<Decision>
  },
) {
  const selected = useWatched(tab.queries.selected)
  const asks = useWatched(tab.queries.asks(repository))
  return waiting.map((decision) => {
    const ask = asks.find((row) => row.item === decision.id)
    const chosen = ask !== undefined && ask.key === selected
    return (
      <article
        key={decision.id}
        className="factory-item"
        aria-label={decision.title}
        aria-current={chosen ? "true" : undefined}
        data-ask={decision.id}
      >
        <Header decision={decision} />
        <Markdown content={decision.body} />
        <Links decision={decision} />
        {ask === undefined || chosen ? null : <Button variant="outline" onClick={() => tab.actions.select(ask)}>Answer</Button>}
      </article>
    )
  })
}

function Header({ decision }: { readonly decision: Decision }) {
  return (
    <div className="factory-item-header">
      <b>{decision.title}</b>
      <Pill tone={decision.answer !== null || decision.decided !== "" ? "ok" : decision.kind === "decide" ? "warn" : "run"}>
        {decision.answer !== null || decision.decided !== "" ? "answered" : decision.kind}
      </Pill>
      {decision.due === "" ? null : <span className="factory-muted">{decision.due}</span>}
    </div>
  )
}

function Links({ decision }: { readonly decision: Decision }) {
  if (decision.links.length === 0) return null
  return (
    <p className="factory-links">
      {decision.links.map((link) => (
        <Button key={link.url} asChild variant="outline" size="sm">
          <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>
        </Button>
      ))}
    </p>
  )
}
