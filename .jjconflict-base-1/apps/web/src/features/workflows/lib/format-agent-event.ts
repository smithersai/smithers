import type { WorkflowAuthoringAgentEvent } from "@burns/shared"

function capitalize(value: string) {
  if (!value) {
    return value
  }

  return `${value[0]!.toUpperCase()}${value.slice(1)}`
}

export function formatWorkflowAuthoringAgentEvent(event: WorkflowAuthoringAgentEvent) {
  if (event.eventType === "started") {
    return event.resume
      ? `[${event.engine}] started session ${event.resume}`
      : `[${event.engine}] started`
  }

  if (event.eventType === "completed") {
    if (event.ok) {
      return `[${event.engine}] completed`
    }

    return `[${event.engine}] failed: ${event.error ?? "unknown error"}`
  }

  const phasePrefix = event.phase ? `${capitalize(event.phase)} ` : ""
  const title = event.title || event.actionKind || "event"
  const details = event.message?.trim()

  if (details) {
    return `[${event.engine}] ${phasePrefix}${title}: ${details}`
  }

  return `[${event.engine}] ${phasePrefix}${title}`
}
