import type { CommandOutcome } from "../../flows/Commands"
import type { ControllerContext } from "./context"

/**
 * Launch Checklist D-4's exhausted-balance refusal, shared between the
 * `zeroBalanceGuard` that dispatches it as a transcript message and
 * `surfaceCommandFailure`, which recognizes it to skip its toast (the
 * refusal is already an embedded chat message; a toast would double-surface
 * it). Names the upgrade path per the definition of done: "how to proceed".
 */
export const ZERO_BALANCE_EXHAUSTED_TEXT =
  "Balance is at $0: flow runs pause until more balance is added. Run /billing.upgrade to add balance; chat stays free in the meantime."

/**
 * A settled run with nothing to report: the work it named was superseded —
 * a newer identity or account epoch owns the answer — so it wrote nothing.
 * `withToast` dismisses the notice instead of resolving it, because stating
 * "done" for a result that was thrown away is the silent-lie shape.
 */
export const TOAST_SUPERSEDED: unique symbol = Symbol("toast.superseded")

export interface FailureController {
  readonly withToast: <T>(
    key: string,
    title: string,
    doneTitle: string,
    work: () => Promise<T | string>
  ) => Promise<T | string>
  /**
   * Resolve the toast on `key`; an ok outcome dismisses itself after
   * toastAutoDismissMs. Every ok resolution goes through here.
   */
  readonly resolveToast: (
    key: string,
    outcome: { readonly status: "ok" | "failed"; readonly title?: string; readonly detail: string }
  ) => void
  readonly dismissToast: (id: string) => void
  readonly surfaceCommandFailure: (name: string, outcome: CommandOutcome) => void
}

export const createFailureController = (ctx: ControllerContext): FailureController => {
  /*
   * The one place an ok toast learns to leave. The sign-in handoff's
   * "Signed in" (2026-09-01) dispatched toast.resolved directly, so nothing
   * ever dismissed it: it stood for the rest of the session, and only a
   * failure toast offers a dismiss control. The dismissal is guarded by the
   * toast's own state, never by who scheduled it: a newer toast.shown or
   * toast.resolved on the same key moves updatedAt (and status), and that
   * owner dismisses its own.
   */
  const resolveToast: FailureController["resolveToast"] = (key, outcome) => {
    const id = `toast-${key}`
    if (ctx.store.collections.toasts.get(id) === undefined) return
    ctx.store.dispatch({
      type: "toast.resolved",
      actor: "system",
      key,
      status: outcome.status,
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
      detail: outcome.detail
    })
    if (outcome.status !== "ok") return
    const resolvedAt = ctx.store.collections.toasts.get(id)?.updatedAt
    const dismiss = setTimeout(() => {
      const current = ctx.store.collections.toasts.get(id)
      if (current === undefined || current.status !== "ok" || current.updatedAt !== resolvedAt) return
      ctx.store.dispatch({ type: "toast.dismissed", actor: "system", id })
    }, ctx.toastAutoDismissMs)
    ctx.unref(dismiss)
  }
  /*
   * The 300ms toast law (2026-08-09): background work not settled within
   * 300ms states what is running on the shared toast stack; work under
   * 300ms never flashes anything. `work` answers true on success or the
   * honest failure line — a failure toast stays until dismissed, an ok
   * toast resolves into the result and dismisses itself.
   */
  /*
   * Ownership is allocated, never counted: `toastRuns` says who owns a key's
   * toast right now, and a settled run's terminal delete used to hand its
   * number straight back. With A pending, B settling and C starting after,
   * C was issued A's number and A could then resolve C's toast. This
   * sequence is controller-wide and monotonic, so no deletion can recycle a
   * number while the run that holds it is still in flight.
   */
  let nextRun = 0
  /*
   * One toast per flow key, so a re-run of the same flow owns the slot: the
   * run counter keeps a finished run from resolving OR auto-dismissing the
   * toast a newer run is using — a running notice must never silently vanish
   * while the work it names is still in flight.
   */
  const withToast = async <T>(
    key: string,
    title: string,
    doneTitle: string,
    work: () => Promise<T | string>
  ): Promise<T | string> => {
    nextRun += 1
    const run = nextRun
    ctx.toastRuns.set(key, run)
    let shown = false
    const debounce = setTimeout(() => {
      if (ctx.toastRuns.get(key) !== run) return
      shown = true
      ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title })
    }, ctx.toastDebounceMs)
    ctx.unref(debounce)
    let outcome: T | string
    try {
      outcome = await work()
    } catch {
      // A thrown flow is still an honest failure — never a toast stuck "running".
      outcome = `${title.replace(/…$/, "")} didn't finish — the app hit an unexpected error.`
    } finally {
      clearTimeout(debounce)
    }
    // A newer run of the same flow owns the toast now; this one reports nothing.
    if (ctx.toastRuns.get(key) !== run) return outcome
    // Superseded work has no result to state: whatever it read belongs to an
    // account the app no longer has open, so the notice leaves silently
    // rather than resolving into a doneTitle nothing backs.
    if (outcome === TOAST_SUPERSEDED) {
      const id = `toast-${key}`
      if (ctx.store.collections.toasts.get(id) !== undefined) {
        ctx.store.dispatch({ type: "toast.dismissed", actor: "system", id })
      }
      ctx.toastRuns.delete(key)
      return outcome
    }
    // Resolve whatever is on screen for this key — including a toast an
    // earlier (slower) run put up, or a failed one this run just retried.
    if (!shown && ctx.store.collections.toasts.get(`toast-${key}`) === undefined) {
      // Settled with nothing ever shown: the run slot is terminal, so the
      // counter entry leaves with it (the map otherwise grows one entry per
      // flow key and never lets go).
      ctx.toastRuns.delete(key)
      return outcome
    }
    // A string outcome is the honest failure line; anything else is success
    // (true, or a value the caller consumes — e.g. the browser tool's read).
    const ok = typeof outcome !== "string"
    // Settled work states its result, never the running sentence: an ok
    // toast reads as done for the seconds before it dismisses itself, and
    // a failure keeps the attempt's title with the honest line under it.
    resolveToast(key, ok ? { status: "ok", title: doneTitle, detail: "" } : { status: "failed", detail: outcome as string })
    // The run is over either way, so its counter entry is terminal and
    // leaves now. The ok toast's self-dismissal is guarded by the toast's
    // own state in resolveToast, so no stale timer can claim the slot a
    // newer run is using. The toast itself stays keyed `toast-${key}`, so a
    // later run of the same flow still resolves it.
    ctx.toastRuns.delete(key)
    return outcome
  }

  const dismissToast = (id: string): void => {
    ctx.store.dispatch({ type: "toast.dismissed", actor: "user", id })
  }

  /*
   * A failed flow has no channel of its own to answer into — dropping the
   * outcome reads as a silent no-op (the "did it even run?" bug). Every
   * invocation the human makes — a pointer press OR a name typed into the
   * composer — states its refusal as a toast; executes that render their own
   * error UI return void and never reach this. The zero-balance refusal is
   * the one exception: `zeroBalanceGuard` already dispatched it as an
   * embedded transcript message, so toasting it too would double-surface the
   * same refusal.
   */
  const surfaceCommandFailure = (name: string, outcome: CommandOutcome): void => {
    if (outcome.status === "form") {
      /*
       * THE FORM LAW: the slash line lacked its input, so the form card is in
       * the transcript; the composer's line points at it and says nothing
       * about arguments. An ok toast: it resolves and leaves on its own.
       */
      const key = `command.form.${name}`
      ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title: "Fill in the form above" })
      resolveToast(key, { status: "ok", detail: "" })
      return
    }
    if (outcome.status !== "failed") return
    if (outcome.error === ZERO_BALANCE_EXHAUSTED_TEXT) return
    const key = `command.failed.${name}`
    ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title: `/${name} didn't run` })
    ctx.store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail: outcome.error })
  }

  return { withToast, resolveToast, dismissToast, surfaceCommandFailure }
}
