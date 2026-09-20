import { graphTabArgs, type FlowInput } from "../../flows/FlowArgs"
/*
 * What the drawer's tab strip does with a key.
 *
 * The ARIA tabs pattern is one tab stop into the strip and then the arrows
 * along it, which needs a roving tabindex: every tab but the one showing is
 * out of the tab order, so without the arrows the rest would be unreachable
 * by keyboard. The move is the same flow a click runs (THE THREE-DOOR LAW),
 * so nothing here holds a cursor of its own — the tab on the card is the
 * cursor, and this answers which one the key asked for.
 *
 * Pure, so the strip's behaviour is provable without a DOM.
 */

/**
 * The flows a graph card's drawer is steered through.
 *
 * `Tab` is the flow's own name, not `string`: what comes back out is what the
 * card hands the run command, and a widened name would not be a flow the
 * registry has.
 */
export interface TabDoors<Flow extends "runs.graph.tab" | "flow.plan.tab" = "runs.graph.tab" | "flow.plan.tab"> {
  readonly tab: Flow
  readonly target: string
}

/**
 * The tab one key asks for, as the act that opens it.
 *
 * The strip does not wrap: the end of it is the end, the same way an arrow
 * off the end of the graph runs nothing (FlowGraphDrawer.graphKeyAct).
 */
export const drawerTabAct = <Tab extends FlowInput["flow.plan.tab"]["tab"], Flow extends "runs.graph.tab" | "flow.plan.tab">(
  key: string,
  strip: {
    /** The tabs this node has evidence for, in strip order. */
    readonly tabs: ReadonlyArray<Tab>
    /** The one showing, which is the strip's only tab stop. */
    readonly shown: Tab
    readonly doors: TabDoors<Flow>
  }
): { readonly flow: Flow; readonly args: string } | undefined => {
  const { tabs, shown, doors } = strip
  const at = tabs.indexOf(shown)
  if (at === -1) return undefined
  const wanted = key === "Home"
    ? 0
    : key === "End"
    ? tabs.length - 1
    : key === "ArrowRight" || key === "ArrowDown"
    ? at + 1
    : key === "ArrowLeft" || key === "ArrowUp"
    ? at - 1
    : undefined
  if (wanted === undefined) return undefined
  const next = tabs[wanted]
  return next === undefined || next === shown ? undefined : { flow: doors.tab, args: graphTabArgs(doors, next) }
}
