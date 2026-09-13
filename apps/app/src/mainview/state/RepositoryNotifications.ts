import { z } from "zod"

/** Human inbox receipts, projected by the same persisted dispatcher as chat. */
export const RepositoryNotificationSchema = z.object({
  id: z.string(), scope: z.string(), repo: z.string(), source: z.string(), sourceId: z.string(),
  kind: z.enum(["issue", "pr", "notification"]), number: z.number().int().optional(),
  title: z.string(), state: z.string(), updatedAt: z.string().nullable(), version: z.string(),
  tags: z.array(z.string()), processedAt: z.number(), announcedVersion: z.string().optional(),
  readVersion: z.string().optional()
})
export type RepositoryNotification = z.infer<typeof RepositoryNotificationSchema>
export type RepositoryEvent = Omit<RepositoryNotification, "id" | "scope" | "repo" | "version" | "processedAt" | "announcedVersion" | "readVersion"> & { read?: boolean }

export function processRepositoryEvents(scope: string, repo: string, events: readonly RepositoryEvent[], previous: readonly RepositoryNotification[], at: number) {
  const old = new Map(previous.map(row => [row.id, row]))
  const rows = new Map<string, RepositoryNotification>(), fresh = new Map<string, RepositoryNotification>()
  for (const event of events) {
    const id = JSON.stringify([scope, repo, event.source, event.kind, event.sourceId])
    const prior = old.get(id)
    if (prior?.updatedAt && event.updatedAt && Date.parse(event.updatedAt) < Date.parse(prior.updatedAt)) continue
    const version = JSON.stringify([event.updatedAt, event.state, event.title])
    const row: RepositoryNotification = {
      ...event, id, scope, repo, version, processedAt: at,
      tags: [...new Set([...(prior?.tags ?? []), ...event.tags])],
      ...(prior?.announcedVersion ? { announcedVersion: prior.announcedVersion } : {}),
      ...(event.read ? { readVersion: version } : prior?.readVersion ? { readVersion: prior.readVersion } : {})
    }
    const baselineClosed = !prior && event.kind !== "notification" && event.state !== "open"
    if (row.announcedVersion !== version && row.readVersion !== version && !baselineClosed && !(prior?.version === version && prior.state !== "open" && !prior.announcedVersion)) fresh.set(id, row)
    else fresh.delete(id)
    rows.set(id, row)
    old.set(id, row)
  }
  return { rows: [...rows.values()], fresh: [...fresh.values()] }
}
