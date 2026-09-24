import type { ControllerContext } from "./context"

export interface ConnectorController {
  readonly makeConnectorReadOnly: (id: string) => string | void
  readonly askConnectorRemoval: (id: string) => string | void
  readonly cancelConnectorRemoval: () => void
  readonly removeConnector: (id: string) => string | void
}

export const createConnectorController = (
  ctx: ControllerContext
): ConnectorController => {
  const { store } = ctx

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
    makeConnectorReadOnly,
    askConnectorRemoval,
    cancelConnectorRemoval,
    removeConnector
  }
}
