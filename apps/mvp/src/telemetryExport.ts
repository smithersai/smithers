import { routeTemplate } from "./apiRoutes"
import { BROWSER_TELEMETRY } from "./telemetry"

const fields = new Set([...BROWSER_TELEMETRY.fields, "service.version"])
const identifiers = new Set(["repo", "repoId", "owner", "repository", "branch", "branchId", "sha", "file", "path"])

/** The browser's privacy boundary, before any OTLP bytes leave the tab or engine worker. */
export const telemetryExport = (payload: unknown): unknown => {
  if (Array.isArray(payload)) return payload.map(telemetryExport)
  if (payload === null || typeof payload !== "object") return payload
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => {
    if (key === "attributes" && Array.isArray(value)) return [key, value.flatMap((attribute: { key: string; value: unknown }) => {
      if (!fields.has(attribute.key) || identifiers.has(attribute.key)) return []
      if (attribute.key === "url.path") {
        const path = (attribute.value as { stringValue?: unknown }).stringValue
        return typeof path === "string" ? [{ key: attribute.key, value: { stringValue: routeTemplate(path) } }] : []
      }
      return [attribute]
    })]
    if (key === "status" && value !== null && typeof value === "object") {
      const { message: _message, ...status } = value as Record<string, unknown>
      return [key, status]
    }
    return [key, telemetryExport(value)]
  }))
}
