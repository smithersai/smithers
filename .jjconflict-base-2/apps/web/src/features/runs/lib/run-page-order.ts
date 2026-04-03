import type { NodeRunTimelineItem } from "./run-timeline"

function parseTimestamp(value?: string) {
  if (!value) {
    return null
  }

  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

type SortNodeTimelineForRunPageOptions = {
  pendingNodeIds?: Iterable<string>
  decidedAtByNodeId?: ReadonlyMap<string, string | undefined>
}

function getNodeSortTimestamp(
  nodeRun: NodeRunTimelineItem,
  decidedAtByNodeId: ReadonlyMap<string, string | undefined>
) {
  const approvalDecisionTimestamp = parseTimestamp(decidedAtByNodeId.get(nodeRun.nodeId))
  if (approvalDecisionTimestamp !== null) {
    return approvalDecisionTimestamp
  }

  if (nodeRun.status === "completed" || nodeRun.status === "failed") {
    return parseTimestamp(nodeRun.finishedAt) ?? parseTimestamp(nodeRun.startedAt)
  }

  return parseTimestamp(nodeRun.startedAt) ?? parseTimestamp(nodeRun.finishedAt)
}

export function sortNodeTimelineForRunPage(
  nodeTimeline: NodeRunTimelineItem[],
  options: SortNodeTimelineForRunPageOptions = {}
) {
  const pendingNodeIdSet = new Set(options.pendingNodeIds ?? [])
  const decidedAtByNodeId = options.decidedAtByNodeId ?? new Map<string, string | undefined>()

  return [...nodeTimeline].sort((left, right) => {
    const leftPending = pendingNodeIdSet.has(left.nodeId)
    const rightPending = pendingNodeIdSet.has(right.nodeId)

    if (leftPending !== rightPending) {
      return leftPending ? 1 : -1
    }

    const leftTimestamp = getNodeSortTimestamp(left, decidedAtByNodeId)
    const rightTimestamp = getNodeSortTimestamp(right, decidedAtByNodeId)

    if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
      return leftTimestamp - rightTimestamp
    }

    if (leftTimestamp !== null && rightTimestamp === null) {
      return -1
    }

    if (leftTimestamp === null && rightTimestamp !== null) {
      return 1
    }

    if (left.firstSeq !== right.firstSeq) {
      return left.firstSeq - right.firstSeq
    }

    if (left.iteration !== right.iteration) {
      return left.iteration - right.iteration
    }

    if (left.attempt !== right.attempt) {
      return left.attempt - right.attempt
    }

    return left.nodeId.localeCompare(right.nodeId)
  })
}
