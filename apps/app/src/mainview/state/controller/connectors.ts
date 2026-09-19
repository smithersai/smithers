import type { RepositoryAccess } from "@smthrs/rpc/NativeRepository"
import type { ControllerContext } from "./context"

export interface ConnectorController {
  readonly connectLocalRepository: (access: RepositoryAccess) => Promise<void>
  readonly makeConnectorReadOnly: (id: string) => string | void
  readonly askConnectorRemoval: (id: string) => string | void
  readonly cancelConnectorRemoval: () => void
  readonly removeConnector: (id: string) => string | void
}

export const createConnectorController = (
  ctx: ControllerContext
): ConnectorController => {
  const { store, repositories } = ctx

  const connectLocalRepository = async (access: RepositoryAccess): Promise<void> => {
    const operation = store.collections.connectorOperations.get("connector-operation")
    if (operation?.phase !== "idle") return
    store.dispatch({ type: "connector.local.requested", actor: "user", access })
    try {
      const result = await repositories.pickLocalRepository(access)
      switch (result.status) {
        // No host opens a repository on this machine any more
        // (docs/LOCAL-BACKEND-RETIREMENT.md); the picker only ever refuses.
        case "connected":
        case "cancelled":
          store.dispatch({ type: "connector.local.cancelled", actor: "user" })
          break
        case "error":
          store.dispatch({
            type: "connector.local.failed",
            actor: "system",
            message: result.message
          })
          break
      }
    } catch {
      store.dispatch({
        type: "connector.local.failed",
        actor: "system",
        message: "The native repository picker stopped responding. Try again."
      })
    }
  }

  /*
   * A connector is a record in this store, never a directory this host has
   * opened: no host serves `/api/repos`, `/api/repo/access` or
   * `/api/repo/close` any more (docs/LOCAL-BACKEND-RETIREMENT.md), so
   * narrowing or forgetting one is a store act alone. Rows restored from a
   * conversation saved before the cut still answer these two doors.
   */
  const reduceAccess = (id: string, disconnect: boolean): string | void => {
    if (store.collections.connectors.get(id) === undefined) return `There is no connector with id ${id}.`
    if (disconnect) store.dispatch({ type: "connector.removed", actor: "user", id })
    else store.dispatch({ type: "connector.access.changed", actor: "user", id, access: "read" })
  }

  const makeConnectorReadOnly = (id: string): string | void => reduceAccess(id, false)

  const askConnectorRemoval = (id: string): string | void => {
    if (store.collections.connectors.get(id) === undefined) return `There is no connector with id ${id}.`
    store.dispatch({ type: "connector.removal.asked", actor: "user", id })
  }

  const cancelConnectorRemoval = (): void => {
    if (store.session().pendingConnectorRemovalId === null) return
    store.dispatch({ type: "connector.removal.asked", actor: "user", id: null })
  }

  const removeConnector = (id: string): string | void => {
    if (store.session().pendingConnectorRemovalId !== id) return "Ask before disconnecting this repository."
    return reduceAccess(id, true)
  }

  return {
    connectLocalRepository,
    makeConnectorReadOnly,
    askConnectorRemoval,
    cancelConnectorRemoval,
    removeConnector
  }
}
