import { useLiveQuery } from "@tanstack/react-db"
import { useChat } from "../../../AppContext"
import { engineStopped } from "../engineAvailability"

export function useEngineStopped() {
  const { data: connection } = useLiveQuery(useChat().queries.connection)
  return engineStopped(connection)
}
