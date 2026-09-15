import { repoKeyOf } from "./AppState"
import type { Card, StarredTarget } from "./AppState"
import type { Repo } from "@smthrs/rpc/LocalApp"
import { notificationWasRead, type NotificationReadReceipt, type RepositoryNotification } from "./RepositoryNotifications"

/** Current personal stars join a saved target list by repository identity. */
export const projectTargetStars = (
  card: Extract<Card, { kind: "targets" }>,
  repos: ReadonlyArray<Repo>,
  stars: ReadonlyArray<StarredTarget>
): Extract<Card, { kind: "targets" }> => {
  const repo = repos.find(row => row.id === card.payload.repoId)
  const key = card.payload.repoKey ?? (repo === undefined ? undefined : repoKeyOf(repo.path))
  // Legacy cards without any recoverable repository identity remain snapshots.
  if (key === undefined) return card
  const starred = stars.filter(row => row.repoKey === key).map(row => row.label).sort()
  return { ...card, payload: { ...card.payload, repoKey: key, starred } }
}

/** Saved activity content joins exact-version read receipts and current tags without rewriting history. */
export const projectRepositoryUpdate = (
  card: Extract<Card, { kind: "repo-update" }>,
  notifications: ReadonlyArray<RepositoryNotification>,
  receipts: ReadonlyArray<NotificationReadReceipt>
): Extract<Card, { kind: "repo-update" }> => {
  const current = new Map(notifications.map(row => [row.id, row]))
  const read = new Set(receipts.map(row => row.id))
  return { ...card, payload: { ...card.payload, items: card.payload.items.map(item => ({
    ...item,
    read: notificationWasRead(read, item.id, item.version),
    tags: [...(current.get(item.id)?.tags ?? item.tags)]
  })) } }
}
