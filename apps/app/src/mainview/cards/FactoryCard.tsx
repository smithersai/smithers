/*
 * The factory card (factory.show): how a repository builds itself, in the
 * two sections the design session fixed (2026-09-07 §4, mock 3). Wiki: the
 * generated wiki's stats, or "No generated wiki yet" while none exists; the
 * notes the Wiki store holds; the Librarian's answers and misses, or the
 * honest absence of a log. Box, infra as code: one row per declared file,
 * present with an Open button that runs files.read for that path, absent
 * when the tree lacks it, unreadable with the backend's reason. No row is
 * ever invented and no absent file is dropped.
 */
import { Button } from "@smthrs/ui"
import { fileArgs } from "../flows/FileArgs"
import type { Card } from "../state/AppState"
import { WIKI_DISPLAY_NAME } from "../state/AppState"
import { timeLabel } from "../Timestamps"
import type { CardActions, CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"

type FactoryCard = Extract<Card, { kind: "factory" }>
type InfraRow = FactoryCard["payload"]["infra"][number]

/** What each declared file holds, the mock's own words. */
const INFRA_ROLE: Readonly<Record<string, string>> = {
  ".smithers/WORKSPACE.ts": "runtime, package manager, Nix environment, sandboxes",
  "flake.nix": "the closure every box boots",
  "PACKAGE.ts": "targets, factory, home"
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

const generatedLine = (generated: NonNullable<FactoryCard["payload"]["wiki"]["generated"]>): string =>
  [
    `${plural(generated.pages, "generated page")} · fresh at ${generated.sha}`,
    ...(generated.coverage === undefined ? [] : [generated.coverage]),
    ...(generated.generatedAt === undefined ? [] : [`last generated ${timeLabel(generated.generatedAt)}`])
  ].join(" · ")

const infraState = (row: InfraRow): string => {
  if (row.state === "present") return INFRA_ROLE[row.path] ?? ""
  if (row.state === "absent") return "not in the repository"
  return row.reason === undefined ? "could not be read" : `could not be read: ${row.reason}`
}

export const FactoryCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: FactoryCard
  readonly onRunCommand: CardActions["onRunCommand"]
}) => {
  const { repo, wiki, infra } = card.payload
  return (
    <div className="factory-card">
      <section className="factory-section" aria-label={WIKI_DISPLAY_NAME}>
        <h3 className="factory-section-title">{WIKI_DISPLAY_NAME}</h3>
        <ul className="workflow-list" data-testid="factory-wiki">
          <li className="workflow-list-row" data-testid="factory-wiki-generated">
            <span className="workflow-list-text">
              <strong>{wiki.generated === null ? "No generated wiki yet" : generatedLine(wiki.generated)}</strong>
            </span>
          </li>
          <li className="workflow-list-row" data-testid="factory-wiki-notes">
            <span className="workflow-list-text">
              <strong>{plural(wiki.notes, "note")}</strong>
            </span>
          </li>
          <li className="workflow-list-row" data-testid="factory-wiki-librarian">
            <span className="workflow-list-text">
              <strong>
                {wiki.librarian === null
                  ? "No Librarian answers recorded yet"
                  : `Librarian · ${plural(wiki.librarian.answers, "answer")} · ${wiki.librarian.misses} found no note`}
              </strong>
            </span>
          </li>
        </ul>
      </section>
      <section className="factory-section" aria-label="Box, infra as code">
        <h3 className="factory-section-title">Box · infra as code</h3>
        <ul className="workflow-list" data-testid="factory-infra">
          {infra.map((row) => (
            <li key={row.path} className="workflow-list-row" data-infra={row.path} data-state={row.state}>
              <span className="workflow-list-text">
                <strong>{row.path}</strong>
                <span>{infraState(row)}</span>
              </span>
              {row.state === "present"
                ? (
                  <Button
                    size="sm"
                    variant="outline"
                    data-flow="files.read"
                    aria-label={`Open ${row.path}`}
                    onClick={() => onRunCommand("files.read", fileArgs(row.path, repo))}
                  >
                    Open
                  </Button>
                )
                : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export const factoryCardFamily: CardFamily<"factory"> = {
  factory: { render: (card, actions) => <FactoryCardBody card={card} onRunCommand={actions.onRunCommand} />, pill: settledPill }
}
