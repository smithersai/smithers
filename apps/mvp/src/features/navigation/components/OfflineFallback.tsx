import { Button, EmptyState } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useChat } from "../../../AppContext"

/** An uncached page cannot finish offline; retain a way to the device's home. */
export function OfflineFallback({ children }: { readonly children: ReactNode }) {
  const { queries } = useChat()
  const { data: connection } = useLiveQuery(queries.connection)
  return connection?.status === "offline"
    ? <EmptyState title="Offline" action={<Button asChild variant="outline"><Link to="/app">Back to chat</Link></Button>} />
    : children
}
