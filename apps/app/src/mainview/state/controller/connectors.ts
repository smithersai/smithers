import type { RepositoryAccess } from "@smthrs/rpc/NativeRepository"
import { ReposResponseSchema } from "@smthrs/rpc/LocalApp"
import { adoptLocalRepository } from "./adoptLocalRepository"
import type { ControllerContext } from "./context"

export interface ConnectorController {
  readonly connectLocalRepository: (access: RepositoryAccess) => Promise<void>
  readonly makeConnectorReadOnly: (id: string) => Promise<string | void>
  readonly askConnectorRemoval: (id: string) => string | void
  readonly cancelConnectorRemoval: () => void
  readonly removeConnector: (id: string) => Promise<string | void>
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
        case "connected":
          await adoptLocalRepository(ctx, result.repository, access)
          break
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

  // Resolve canonical picker roots against the host's current open set, including
  // repositories restored on launch and connectors created by older clients.
  const loadHostRepos = async () => {
    const response = await ctx.boundedFetch(`${ctx.baseUrl}/api/repos`)
    if (!response.ok) throw new Error(await ctx.errorMessageOf(response, "Could not load open repositories."))
    return ReposResponseSchema.parse(await response.json()).repos
  }
  const reducing = new Set<string>()
  const reduceAccess = async (id: string, disconnect: boolean): Promise<string | void> => {
    const connector = store.collections.connectors.get(id)
    if (connector === undefined) return `There is no connector with id ${id}.`
    if (reducing.has(id)) return "Repository access is already changing."
    reducing.add(id)
    try {
      const repos = await loadHostRepos()
      for (const repo of repos.filter((repo) => repo.path === connector.root)) {
        const response = await ctx.boundedFetch(`${ctx.baseUrl}/api/repo/${disconnect ? "close" : "access"}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repoId: repo.id, ...(disconnect ? {} : { access: "read" }) })
        })
        if (!response.ok) return await ctx.errorMessageOf(response, "Could not revoke repository access.")
      }
      const refreshed = await loadHostRepos()
      store.dispatch({ type: "repos.loaded", actor: "system", repos: refreshed })
      if (disconnect) store.dispatch({ type: "connector.removed", actor: "user", id })
      else store.dispatch({ type: "connector.access.changed", actor: "user", id, access: "read" })
    } catch (error) {
      return `Could not revoke repository access: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      reducing.delete(id)
    }
  }

  const makeConnectorReadOnly = (id: string): Promise<string | void> => reduceAccess(id, false)

  const askConnectorRemoval = (id: string): string | void => {
    if (store.collections.connectors.get(id) === undefined) return `There is no connector with id ${id}.`
    store.dispatch({ type: "connector.removal.asked", actor: "user", id })
  }

  const cancelConnectorRemoval = (): void => {
    if (store.session().pendingConnectorRemovalId === null) return
    store.dispatch({ type: "connector.removal.asked", actor: "user", id: null })
  }

  const removeConnector = async (id: string): Promise<string | void> => {
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
