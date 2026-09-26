/*
 * Where a change request starts (#1964): the caller's own ref pushed with
 * `smithers repo push [--name <name>]`. Smithers Cloud pins that ref's commit
 * under the workspace's own source ref and answers it as coding/request's
 * `base`, the same shape a mythical lane starts from; coding/request then
 * starts the working copy on it. Only the ref's owner, in their own
 * workspace, can use it: the route resolves the name in the caller's
 * namespace alone.
 */
import { createCloudClient } from "./CloudClient"
import type { SeamContext } from "./SeamContext"
import type { WorkflowLaunch } from "../WorkflowLaunch"

type Source = NonNullable<WorkflowLaunch["source"]>

const SHA = /^[0-9a-f]{40}$/
const SOURCE_REF = /^refs\/smithers\/workspaces\/[0-9a-f-]{36}\/sources\/[0-9a-f]{40}$/

/** The pinned base, or null when no ref was asked for and the caller pushed no head. */
export const pinUserRefSource = async (
  ctx: Pick<SeamContext, "http" | "baseUrl">,
  repo: string,
  workspaceId: string,
  source: Source,
  signal?: AbortSignal
): Promise<{ readonly base: { readonly commitId: string; readonly ref: string } | null } | { readonly code: string; readonly message: string }> => {
  const [owner, name] = repo.split("/")
  const path = `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/workspaces/${encodeURIComponent(workspaceId)}/user-source`
  const answer = await createCloudClient(ctx).send("POST", path, source.explicit ? { name: source.name } : {}, `your pushed ${source.name}`, signal)
  if ("error" in answer) return { code: answer.code ?? "user_source_unavailable", message: answer.error }
  const body = answer.body
  const base = typeof body === "object" && body !== null ? (body as { base?: unknown }).base : undefined
  if (base === null) return { base: null }
  if (typeof base === "object" && base !== undefined) {
    const { commitId, ref } = base as { commitId?: unknown; ref?: unknown }
    if (typeof commitId === "string" && SHA.test(commitId) && typeof ref === "string" && SOURCE_REF.test(ref)) return { base: { commitId, ref } }
  }
  return { code: "user_source_unavailable", message: "Smithers Cloud answered the pushed ref in a shape this app cannot read." }
}
