import type { AuthorizedLocalRepositoryInspection, RepositoryAccess } from "@smthrs/rpc/NativeRepository"
import type { ControllerContext } from "./context"

/** Consume the picker capability before publishing any durable repository state. */
export const adoptLocalRepository = async (
  ctx: ControllerContext,
  picked: AuthorizedLocalRepositoryInspection,
  access: RepositoryAccess
): Promise<string | void> => {
  const { authorizationId, root, name, head, branch, remoteUrl } = picked
  const refusal = await ctx.openRepo({ authorizationId, displayName: name })
  if (refusal !== undefined) {
    ctx.store.dispatch({ type: "connector.local.failed", actor: "system", message: refusal })
    return refusal
  }
  await ctx.store.dispatch({
    type: "connector.local.connected", actor: "system", access,
    repository: { root, name, head, branch, remoteUrl }
  }).isPersisted.promise
}
