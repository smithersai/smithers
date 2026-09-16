import type { ControllerContext } from "./context"
import { TOAST_SUPERSEDED, type FailureController } from "./failures"

/** A catalog wait is admission, not authorization. The registry rechecks the bound payload after it settles. */
export const createRepositoryReadiness = (ctx: ControllerContext, surfaceCommandFailure: FailureController["surfaceCommandFailure"]) => {
  const pending = () => ctx.store.session().pendingCommand
  const accountOwner = () => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    return identity?.accountOwnerLogin !== undefined ? identity.accountOwnerLogin :
      identity?.state === "signed-in" ? identity.login : identity?.state === "signed-out" ? null : undefined
  }
  const keyOf = (value: ReturnType<typeof pending>) => value?.requirement === "repository-ready" ? JSON.stringify(value) : undefined
  let active: string | undefined
  const persisting = new Map<string, Promise<unknown>>()
  const wakeups = new Set<() => void>()
  const resume = (): void => {
    if (ctx.disposed) return
    const request = pending()
    const key = keyOf(request)
    if (!request || key === undefined || key === active) return
    active = key
    const epoch = ctx.accountEpoch
    const owner = accountOwner()
    const owns = () => !ctx.disposed && ctx.accountEpoch === epoch && accountOwner() === owner && keyOf(pending()) === key
    void ctx.withToast("repository.ready", "Loading repository…", "Ready", async () => {
      if (!ctx.commands.find(request.name)?.metadata.requires?.includes("repo-source")) return "The saved repository command is unavailable."
      let payload: Record<string, unknown>
      try { payload = JSON.parse(request.args ?? "") } catch { return "The saved repository request could not be read. Run the command again." }
      if (typeof payload?.repo !== "string") return "The saved repository request has no target. Run the command again."
      const repo = payload.repo.toLowerCase()
      const waiting = await new Promise<string | undefined | typeof TOAST_SUPERSEDED>(resolve => {
        const check = () => {
          if (!owns()) { wakeups.delete(check); resolve(TOAST_SUPERSEDED); return }
          const entry = ctx.store.session().repositoryEntry
          if (!entry || entry.repo.toLowerCase() !== repo) { wakeups.delete(check); resolve("Repository changed. Run the command again."); return }
          if (entry.phase === "pending") return
          wakeups.delete(check)
          resolve(entry.phase === "failed" && entry.failureKind !== "not-public" ? entry.error ?? "The repository could not be opened. Try again." : undefined)
        }
        wakeups.add(check)
        check()
      })
      if (!owns() || waiting === TOAST_SUPERSEDED) return TOAST_SUPERSEDED
      const entryId = ctx.store.session().repositoryEntry?.requestId
      const selection = ctx.store.session().activeRepoKey
      await ctx.store.dispatch({ type: "command.deferral.cleared", actor: "system" }).isPersisted.promise
      if (ctx.disposed || ctx.accountEpoch !== epoch || accountOwner() !== owner || active !== key || pending() != null ||
        ctx.store.session().repositoryEntry?.requestId !== entryId || ctx.store.session().activeRepoKey !== selection) return TOAST_SUPERSEDED
      if (waiting !== undefined) return waiting
      const display = ctx.commands.find(request.name)?.metadata.form?.args?.(payload)
      const outcome = await ctx.commands.submit({ name: request.name, payload, actor: "user", display })
      if (outcome.status === "form" || pending() != null) return TOAST_SUPERSEDED
      return outcome.status === "failed" ? outcome.error : outcome.status === "executed" ? true : "The requested command is unavailable."
    }).then(outcome => {
      if (typeof outcome === "string" && !ctx.disposed && active === key && !ctx.store.collections.toasts.has("toast-repository.ready")) surfaceCommandFailure(request.name, { status: "failed", error: outcome })
    }).finally(() => { if (active === key) active = undefined })
  }
  const subscription = ctx.store.collections.sessions.subscribeChanges(() => {
    for (const wake of [...wakeups]) wake()
    resume()
  })
  ctx.onDispose(() => { subscription.unsubscribe(); for (const wake of [...wakeups]) wake(); wakeups.clear() })
  return {
    resume,
    defer: async (name: string, payload: Record<string, unknown>): Promise<void> => {
      const args = JSON.stringify(payload)
      const signature = JSON.stringify([name, args])
      const old = pending()
      if (old?.requirement !== "repository-ready" || old.name !== name || old.args !== args) {
        const saving = ctx.store.dispatch({ type: "command.deferred", actor: "user", name, args, requirement: "repository-ready" }).isPersisted.promise
        persisting.set(signature, saving)
        try { await saving } finally { if (persisting.get(signature) === saving) persisting.delete(signature) }
      } else {
        await persisting.get(signature)
      }
      resume()
    }
  }
}
