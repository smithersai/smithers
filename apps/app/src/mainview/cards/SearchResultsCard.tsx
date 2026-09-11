/*
 * The search-results card (Search and Command Palette Spec 2026-09-07 §3,
 * §6): the rows one `search.*` flow answered, embedded in the chat at
 * conversation width. A person invoked the flow from the slash menu, or the
 * agent surfaced what it found; either way every row carries the same
 * actions the palette offers, each the button door of a registered flow,
 * dispatched through onRunCommand with its args. The card is re-runnable:
 * its header runs the same flow with the same query again.
 */
import type { SearchAction, SearchItem, SearchItemKind } from "@smthrs/rpc/Cards"
import { Button } from "@smthrs/ui"
import { GROUP_LABELS, KIND_ORDER } from "../flows/SearchQuery"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { runtimeFlowName } from "../flows/FlowName"

type SearchResultsCard = Extract<Card, { kind: "search-results" }>

export interface SearchResultsCardActions {
  readonly onRunCommand: RunCommand
}

/** The items grouped by kind, in the ranking's kind order, each group in the answer's order. */
export const groupByKind = (items: ReadonlyArray<SearchItem>): ReadonlyArray<{ readonly kind: SearchItemKind; readonly items: ReadonlyArray<SearchItem> }> => {
  const groups = new Map<SearchItemKind, Array<SearchItem>>()
  for (const item of items) {
    const bucket = groups.get(item.kind) ?? []
    bucket.push(item)
    groups.set(item.kind, bucket)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => KIND_ORDER.indexOf(left) - KIND_ORDER.indexOf(right))
    .map(([kind, rows]) => ({ kind, items: rows }))
}

const ActionButton = ({ action, onRunCommand }: { readonly action: SearchAction } & SearchResultsCardActions) => (
  <Button
    variant="ghost"
    size="sm"
    data-flow={action.flow}
    data-role={action.role}
    data-testid={`search-action-${action.flow}`}
    onClick={() => onRunCommand(runtimeFlowName(action.flow), action.args)}
  >
    {action.label}
  </Button>
)

export const SearchResultsCardBody = ({ card, onRunCommand }: { readonly card: SearchResultsCard } & SearchResultsCardActions) => {
  const { payload } = card
  const groups = groupByKind(payload.items)
  return (
    <div className="world-card-list search-results">
      <div className="world-card-row">
        <span className="world-card-path" data-testid="search-results-query">
          /{payload.flow}
          {payload.args === undefined ? "" : ` ${payload.args}`} · {payload.items.length} result{payload.items.length === 1 ? "" : "s"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          data-flow={payload.flow}
          data-testid="search-results-rerun"
          onClick={() => onRunCommand(runtimeFlowName(payload.flow), payload.args)}
        >
          Search again
        </Button>
      </div>
      {groups.length === 0 ?
        <p className="world-card-empty" data-testid="search-results-empty">No results for {payload.query === "" ? "an empty query" : payload.query}.</p> :
        groups.map((group) => (
          <section key={group.kind} className="search-results-group" data-kind={group.kind}>
            <h4 className="search-results-group-label">{GROUP_LABELS[group.kind]}</h4>
            <ol className="search-results-items">
              {group.items.map((item) => (
                <li key={`${item.kind}:${item.ref}`} className="search-results-item" data-testid={`search-item-${item.kind}-${item.ref}`}>
                  <div className="world-card-row">
                    <span className="world-card-title">{item.title}</span>
                    {item.subtitle === undefined ? null : <span className="world-card-path">{item.subtitle}</span>}
                  </div>
                  {item.actions.length === 0 ? null : (
                    <div className="search-results-actions">
                      {item.actions.map((action) => <ActionButton key={`${action.flow}:${action.args ?? ""}`} action={action} onRunCommand={onRunCommand} />)}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
    </div>
  )
}

/** The family slice: the one kind this file owns. */
export const searchResultsCardFamily: CardFamily<"search-results"> = {
  "search-results": {
    render: (card, actions) => <SearchResultsCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
