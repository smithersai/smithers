import type { Lane, LaneRow } from "./state/ChatTimeline"

export const SubagentRow = ({ lane, row, first }: { readonly lane: Lane; readonly row: LaneRow; readonly first: boolean }) =>
  <div className="subagent-row" data-lane={lane.id} data-lane-color={lane.color}>
    {first && <div className="subagent-lane-label">↳ {lane.title}</div>}
    <div className="subagent-row-text">{row.text}</div>
  </div>
