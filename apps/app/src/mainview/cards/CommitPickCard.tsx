import { flowAction, flowProps } from "../flows/FlowAction"
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"

type CommitPickCard = Extract<Card, { kind: "commit-pick" }>

/*
 * The commit picker (onboarding SCRIPT v4 beats 6 and 8): the commits a run
 * made, bottom to top, each with a checkbox. The checked set is what ships;
 * the locked row is the fix itself and stays in. Every control is a flow:
 * the checkbox is `change.pick <row>`, the button is `change.open`, so the
 * pill, the digit keys and the agent all take the same door.
 *
 * The rows wear the commit list's shell (.commit-rows / .commit-row): the
 * picker's own rules in cards.css carry only what picking adds.
 */
export const CommitPickBody = ({ card, onRunCommand }: { readonly card: CommitPickCard; readonly onRunCommand: RunCommand }) => {
  const { repo, branch, targetBookmark, rows, picked } = card.payload
  const chosen = rows.filter((row) => picked.includes(row.index))
  return (
    <section className="commit-pick" aria-label="Commit picker" data-picked={picked.join(" ")}>
      <p className="commit-list-head commit-pick-head">{rows.length} {rows.length === 1 ? "commit" : "commits"} on <code>{branch}</code>{branch === targetBookmark ? null : <> · onto <code>{targetBookmark}</code></>}</p>
      <ol className="commit-rows commit-pick-rows">
        {rows.map((row) => {
          const on = picked.includes(row.index)
          return (
            <li key={row.index} className="commit-row commit-pick-row" data-pick-row={row.index} data-picked={on} data-locked={row.locked}>
              <label>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={row.locked}
                  {...flowProps("change.pick")}
                  aria-keyshortcuts={String(row.index)}
                  onChange={() => onRunCommand("change.pick", String(row.index))}
                />
                <kbd aria-hidden="true">{row.index}</kbd>
                <code className="commit-pick-id" data-commit-id={row.commitId}>{row.commitId.slice(0, 7)}</code>
                <span className="commit-pick-message">{row.message}</span>
                <span className="commit-pick-stat">+{row.additions} −{row.deletions}</span>
                {row.hint !== undefined ? <span className="commit-pick-hint">{row.hint}</span> : null}
              </label>
            </li>
          )
        })}
      </ol>
      <Button
        variant="solid"
        className="commit-pick-open"
        disabled={chosen.length === 0}
        {...flowAction(onRunCommand, "change.open", `${repo} ${chosen.map((row) => row.commitId).join(" ")}`)}
      >
        Make the Change with {chosen.length} {chosen.length === 1 ? "commit" : "commits"}
      </Button>
    </section>
  )
}

export const commitPickCardFamily: CardFamily<"commit-pick"> = {
  "commit-pick": {
    render: (card, actions) => <CommitPickBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: () => ""
  }
}
