import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "./ControllerContext"
import { WIKI_DISPLAY_NAME } from "./state/AppState"
import type { Session, WorldDocument } from "./state/AppState"
import { ConfirmDialog } from "./SurfaceChrome"

export const pendingWikiDeleteDocument = (
  session: Pick<Session, "pendingWorldDeleteId">,
  documents: ReadonlyArray<WorldDocument>
): WorldDocument | undefined => {
  const pendingId = session.pendingWorldDeleteId ?? null
  return pendingId === null ? undefined : documents.find((document) => document.id === pendingId)
}

/**
 * The one visible projection of the durable Wiki delete question. It lives at
 * the active shell level because `/wiki.delete` is available from embedded
 * cards and the guide as well as from the legacy expanded Wiki surface.
 */
export function WikiDeleteDialog() {
  const controller = useController()
  const { collections } = controller.store
  const { data: sessions } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      pendingWorldDeleteId: session.pendingWorldDeleteId
    }))
  )
  const { data: documents } = useLiveQuery(collections.worldDocuments)
  const fallbackSession = controller.store.session()
  const session = sessions[0] ?? fallbackSession
  const pending = pendingWikiDeleteDocument(session, documents) ??
    pendingWikiDeleteDocument(session, [...collections.worldDocuments.values()])

  return (
    <ConfirmDialog
      open={pending !== undefined}
      title={`Delete ${pending?.title ?? "note"}?`}
      body={`This note leaves the ${WIKI_DISPLAY_NAME}. You can write it again, but Smithers will treat it as new.`}
      confirmLabel="Delete"
      destructive
      onConfirm={() => controller.runCommand("wiki.delete.confirm")}
      onCancel={() => controller.runCommand("wiki.delete.cancel")}
    />
  )
}
