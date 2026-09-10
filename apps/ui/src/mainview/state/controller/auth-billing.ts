import {
  ADMIN_ALLOWLIST_PATH,
  ADMIN_GRANT_PATH,
  ADMIN_HEALTH_PATH,
  ADMIN_REQUESTS_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_NATIVE_CLAIM_PATH,
  AUTH_NATIVE_START_PATH,
  AUTH_RETURN_TO_PARAM,
  AUTH_SCOPES_PATH,
  AUTH_SESSION_PATH,
  AUTH_SIGN_IN_PATH,
  AUTH_SIGNED_IN_PARAM,
  BILLING_BALANCE_PATH,
  IDENTITY_REQUEST_ACCESS_PATH
} from "@smthrs/rpc/AgentApiRoutes"
import { signInReturnTo } from "../../RepoLink"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { TOAST_SUPERSEDED } from "./failures"

export interface AuthBillingController {
  readonly handleAuthReturn: (search: string) => boolean
  readonly adoptSession: (session: ResolvedSession) => Promise<void>
  readonly loadSession: () => Promise<void>
  readonly signIn: () => void
  readonly signOut: () => Promise<string | void>
  readonly requestAccess: () => Promise<string | void>
  readonly refreshBalance: () => Promise<void>
  readonly showBalance: () => Promise<string | { readonly value: string }>
  readonly adminAllowlist: (action: "add" | "remove", login: string) => Promise<string | void>
  readonly adminGrant: (amountUsd: number, login: string) => string | void
  readonly adminGrantConfirm: (cardId: string) => Promise<string | void>
  readonly adminGrantCancel: (cardId: string) => string | void
  readonly adminRequests: () => Promise<string | void>
  readonly adminQueueApprove: (login: string) => Promise<string | void>
  readonly adminHealth: () => Promise<string | void>
  readonly settleTurnBilling: () => void
  readonly watchIdentityAcrossTabs: () => void
}

export interface ResolvedSession {
  readonly state: "signed-in" | "signed-out" | "unavailable"
  readonly login: string | null
  readonly allowlisted: boolean
  readonly admin: boolean
}

export const createAuthBillingController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number
): AuthBillingController => {
  const { store, services, baseUrl, boundedFetch: http, errorMessageOf, unref } = ctx
  const withToast = ctx.withToast
  const resumeWorkflowRuns = (): void => ctx.resumeWorkflowRuns()
  const resumeDeferredCommand = (): void => ctx.resumeDeferredCommand()
  /**
   * Returning from a failed OAuth redirect is a chat message, never a bare
   * page. Returning from a finished one carries `?signed-in=github` on
   * whichever page asked (`/` or `/owner/name`); the session probe already
   * says who signed in, so the marker is only reported as handled and the
   * boot strips it from the address bar.
   */
  const handleAuthReturn = (search: string): boolean => {
    const params = new URLSearchParams(search)
    if (params.has(AUTH_SIGNED_IN_PARAM)) return true
    const auth = params.get("auth")
    if (auth !== "failed" && auth !== "error") return false
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: "GitHub sign-in didn't finish — nothing was signed in. Try again whenever you're ready.",
      action: { flow: "auth.sign-in", label: "Try sign-in again" }
    })
    return true
  }

  /*
   * Identity seam. Only definitive answers gate the app: a signed-out or
   * non-allowlisted response drives the landing states; "unavailable" (seam
   * unset or unreachable) is recorded honestly but never blocks the surface.
   */
  const fetchScopesPlain = async (signal?: AbortSignal): Promise<string | null> => {
    try {
      const response = await http(`${baseUrl}${AUTH_SCOPES_PATH}`, { signal })
      if (!response.ok) {
        await response.body?.cancel()
        return null
      }
      const body = (await response.json()) as { scopes?: unknown }
      if (!Array.isArray(body.scopes)) return null
      const plains = body.scopes
        .map((scope) =>
          typeof scope === "object" && scope !== null && "plain" in scope && typeof scope.plain === "string"
            ? scope.plain.trim()
            : ""
        )
        .filter((plain) => plain !== "")
      if (plains.length === 0) return null
      // The identity worker writes each scope as a whole sentence
      // ("See your GitHub profile — your username, name, and avatar."), so
      // they are stated after a lead-in, never spliced into one.
      return `Before GitHub asks, here is what Smithers will use: ${plains.join(" ")}`
    } catch {
      return null
    }
  }

  const dispatchSignedOut = async (epoch: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return
    const scopesPlain = await fetchScopesPlain(signal)
    if (ctx.accountEpoch !== epoch || signal?.aborted) return
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-out",
      login: null,
      allowlisted: false,
      admin: false,
      scopesPlain
    })
  }

  const dispatchUnavailable = (): void => {
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "unavailable",
      login: null,
      allowlisted: false,
      admin: false,
      scopesPlain: null
    })
  }

  const finishSignedInSession = (
    session: Pick<ResolvedSession, "login" | "allowlisted" | "admin">,
    previous: ReturnType<typeof store.collections.identitySessions.get>
  ): void => {
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: session.login,
      allowlisted: session.allowlisted,
      admin: session.admin,
      scopesPlain: null
    })
    if (previous?.state !== "signed-in" || previous.login !== session.login) ctx.identityChanged()
    // The balance read is driven by the session answer, not fired blind at
    // boot: signed out it could only come back 401 — the expected state,
    // logged by the browser as a console error anyway.
    void refreshBalance()
    if (session.allowlisted) {
      // Wave 11: a live run card's event pump resumes from its lastSeq.
      resumeWorkflowRuns()
    }
    // The signed-in answer can satisfy a parked command's requirement — the
    // command that deferred into this sign-in continues here, across the
    // OAuth redirect.
    resumeDeferredCommand()
  }

  const adoptSession = async (session: ResolvedSession): Promise<void> => {
    const epoch = ++ctx.accountEpoch
    const previous = store.collections.identitySessions.get("identity")
    if (session.state === "signed-in") {
      finishSignedInSession(session, previous)
      return
    }
    if (session.state === "signed-out") {
      /*
       * The server renderer resolves the session but never the consent copy,
       * so an adopted signed-out answer must make the same scopes read the
       * client-probe path makes. Adopting with a bare null told every
       * signed-out web visitor "the identity service isn't configured" on a
       * deployment where it is.
       */
      await dispatchSignedOut(epoch)
      return
    }
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: session.state,
      login: session.login,
      allowlisted: session.allowlisted,
      admin: session.admin,
      scopesPlain: null
    })
  }

  const loadSession = async (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return
    const epoch = ++ctx.accountEpoch
    const previous = store.collections.identitySessions.get("identity")
    let response: Response
    try {
      response = await http(`${baseUrl}${AUTH_SESSION_PATH}`, { signal })
    } catch {
      if (ctx.accountEpoch !== epoch || signal?.aborted) return
      dispatchUnavailable()
      return
    }
    if (ctx.accountEpoch !== epoch || signal?.aborted) return
    // Signed-out is the expected resolved answer, never an error path: the
    // identity upstream states it as 401/403, the product Worker's seam
    // restates it as 200 { status: "signed-out" } so the browser never logs
    // the expected answer as a console error. Both shapes resolve the same.
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      await dispatchSignedOut(epoch, signal)
      return
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (ctx.accountEpoch !== epoch || signal?.aborted) return
      dispatchUnavailable()
      return
    }
    const body = (await response.json().catch(() => undefined)) as
      | { status?: unknown; login?: unknown; allowlisted?: unknown; admin?: unknown }
      | undefined
    if (ctx.accountEpoch !== epoch || signal?.aborted) return
    if (body?.status === "signed-out") {
      await dispatchSignedOut(epoch, signal)
      return
    }
    if (body === undefined || typeof body.login !== "string" || body.login === "") {
      dispatchUnavailable()
      return
    }
    finishSignedInSession(
      { login: body.login, allowlisted: body.allowlisted === true, admin: body.admin === true },
      previous
    )
  }
  ctx.loadSession = loadSession

  /*
   * The native sign-in handoff (device-flow style): the embedded webview has
   * no platform authenticator, so GitHub passkeys CANNOT complete inside it
   * (the live failure: GitHub's cross-device Bluetooth fallback dying in the
   * window). OAuth runs in the SYSTEM browser instead — start mints a
   * one-time handoff, openExternal launches the browser at the OAuth start
   * bound to it, and the page polls the claim same-origin until the session
   * cookie lands in the app's own jar. One toast narrates the whole arc.
   */
  const handoffPollMs = services.handoffPollMs ?? 2000
  /*
   * ONE handoff at a time. The live failure (2026-08-30): two "Sign in"
   * clicks twelve seconds apart minted two handoffs. The first finished in
   * the browser and its loop toasted "Signed in"; the second was never
   * completed, polled for its full five minutes, and then wrote "Sign-in
   * timed out" over the SAME toast — so the app announced a timeout for a
   * sign-in that had succeeded. A second click while a handoff is pending now
   * reopens the pending handoff's browser page instead of minting another,
   * and a loop that has been superseded (or whose session already arrived)
   * exits without touching the toast.
   */
  let pendingHandoff: { readonly generation: number; readonly url: string } | undefined
  let handoffGeneration = 0
  const nativeSignIn = async (openExternal: (url: string) => Promise<boolean>): Promise<void> => {
    const key = "auth.sign-in.handoff"
    if (pendingHandoff !== undefined) {
      const pending = pendingHandoff
      const noticeKey = `${key}.reopened`
      if (pending.url === "") {
        const title = "Preparing sign-in…"
        store.dispatch({ type: "toast.shown", actor: "system", key: noticeKey, title })
        ctx.resolveToast(noticeKey, {
          status: "ok", title,
          detail: "Sign-in is being prepared — your browser will open when it's ready."
        })
        return
      }
      const reopened = await openExternal(pending.url)
      if (pendingHandoff?.generation !== pending.generation) return
      // The arc's own toast keeps running under `key` — the sign-in is still
      // in flight. The reopen is a notice beside it: settled ok, it leaves on
      // its own; a page that would not reopen stays until dismissed.
      store.dispatch({ type: "toast.shown", actor: "system", key: noticeKey, title: "Finishing sign-in in your browser…" })
      ctx.resolveToast(noticeKey, {
        status: reopened ? "ok" : "failed",
        title: "Finishing sign-in in your browser…",
        detail: reopened
          ? "That sign-in is still open in your browser — finish it there."
          : "That sign-in is still open in your browser, but the page couldn't be reopened."
      })
      return
    }
    const generation = ++handoffGeneration
    // A superseded loop never writes: only the newest handoff's outcome is the truth.
    const current = (): boolean => pendingHandoff?.generation === generation
    const abort = new AbortController()
    let wake: (() => void) | undefined
    const settle = (status: "ok" | "failed", title: string, detail: string): void => {
      if (!current()) return
      pendingHandoff = undefined
      // The arc's outcome is always shown, even if its toast has gone.
      if (store.collections.toasts.get(`toast-${key}`) === undefined) {
        store.dispatch({ type: "toast.shown", actor: "system", key, title })
      }
      ctx.resolveToast(key, { status, title, detail })
    }
    const fail = (detail: string): void => settle("failed", "Sign-in didn't finish", detail)
    // Reserve the slot before the first await so a second click during the
    // start request joins this handoff instead of racing it.
    pendingHandoff = { generation, url: "" }
    ctx.onDispose(() => {
      if (current()) {
        handoffGeneration += 1
        pendingHandoff = undefined
      }
      wake?.()
      abort.abort()
    })
    if (!current()) return
    store.dispatch({ type: "toast.shown", actor: "system", key, title: "Finishing sign-in in your browser…" })
    let start: { handoffId?: unknown; pollSecret?: unknown } | undefined
    try {
      const response = await http(`${baseUrl}${AUTH_NATIVE_START_PATH}`, { method: "POST", signal: abort.signal })
      if (!current()) return
      if (!response.ok) {
        fail(await errorMessageOf(response, "Sign-in couldn't start. Try again."))
        return
      }
      start = (await response.json().catch(() => undefined)) as typeof start
    } catch {
      fail("Sign-in couldn't start — the identity service didn't answer.")
      return
    }
    if (!current()) return
    if (typeof start?.handoffId !== "string" || typeof start.pollSecret !== "string") {
      fail("Sign-in couldn't start — the identity service answered in an unexpected shape.")
      return
    }
    const origin = baseUrl !== "" ? baseUrl : typeof window === "undefined" ? "" : window.location.origin
    const url = `${origin}${AUTH_SIGN_IN_PATH}?handoff=${encodeURIComponent(start.handoffId)}`
    pendingHandoff = { generation, url }
    const opened = await openExternal(url)
    if (!current()) return
    if (!opened) {
      fail("Your browser couldn't be opened. Try again.")
      return
    }
    // ~5 minutes of patience: OAuth in another app takes as long as it takes.
    let consecutiveErrors = 0
    for (let attempt = 0; attempt < 150 && current(); attempt += 1) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => wake?.(), handoffPollMs)
        wake = () => {
          clearTimeout(timer)
          wake = undefined
          resolve()
        }
        unref(timer)
      })
      if (!current()) return
      // The session may arrive by another door (a sibling tab, a focus
      // re-read): a signed-in identity ends the wait as success, not timeout.
      if (store.collections.identitySessions.get("identity")?.state === "signed-in") {
        settle("ok", "Signed in", `Connected as ${store.collections.identitySessions.get("identity")?.login ?? "you"}.`)
        return
      }
      let claim: Response
      try {
        claim = await http(`${baseUrl}${AUTH_NATIVE_CLAIM_PATH}`, {
          method: "POST",
          signal: abort.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handoffId: start.handoffId, pollSecret: start.pollSecret })
        })
      } catch {
        continue // A dropped poll is not a failed sign-in.
      }
      if (!current()) return
      if (claim.status === 404) {
        fail("That sign-in expired — try again.")
        return
      }
      const body = (await claim.json().catch(() => undefined)) as
        | { status?: unknown; message?: unknown }
        | undefined
      if (!current()) return
      if (!claim.ok) {
        /*
         * An erroring claim used to read as "pending" and poll for the full
         * five minutes. Three in a row is an answer: the seam is refusing,
         * and the toast says what it said.
         */
        consecutiveErrors += 1
        if (consecutiveErrors >= 3) {
          fail(
            typeof body?.message === "string"
              ? `Sign-in couldn't be confirmed: ${body.message}`
              : `Sign-in couldn't be confirmed — the identity service answered ${claim.status}.`
          )
          return
        }
        continue
      }
      consecutiveErrors = 0
      if (body?.status === "pending") continue
      if (body?.status === "ready") {
        // The claim's Set-Cookie should now be in the jar; only the session probe can say so.
        await loadSession(abort.signal)
        if (!current()) return
        const identity = store.collections.identitySessions.get("identity")
        if (identity?.state === "signed-in") {
          settle("ok", "Signed in", `Connected as ${identity.login ?? "you"}.`)
        } else {
          fail(
            "Your browser finished the GitHub sign-in, but this app didn't receive the session — the sign-in cookie never reached it. Try again; if it repeats, that is a bug to report."
          )
        }
        return
      }
      if (body?.status === "failed") {
        fail(typeof body.message === "string" ? body.message : "Sign-in didn't finish. Try again.")
        return
      }
      fail("Sign-in couldn't be confirmed — the identity service answered in an unexpected shape.")
      return
    }
    fail("Sign-in timed out — try again whenever you're ready.")
  }

  /*
   * Sign-in navigates ONLY when the identity seam has answered that it
   * exists (multi's startSignIn discipline): navigating blindly off a build
   * with no seam just reloads the SPA — a flash with no answer, which reads
   * as a silent failure. Every refusal states itself as a toast. With the
   * native shell's openExternal door, sign-in runs the handoff instead of
   * navigating: the webview page survives, and passkeys work in the real
   * browser.
   */
  const signIn = (): void => {
    const identity = store.collections.identitySessions.get("identity")
    const toast = (key: string, title: string, detail: string): void => {
      store.dispatch({ type: "toast.shown", actor: "system", key, title })
      store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail })
    }
    if (identity?.state === "signed-in") {
      toast(
        "auth.sign-in.already",
        `Already connected as ${identity.login ?? "you"}`,
        "GitHub is connected — /auth.sign-out switches accounts."
      )
      return
    }
    if (identity === undefined || identity.state === "unavailable") {
      toast(
        "auth.sign-in.unavailable",
        "Sign-in isn't available on this build",
        "No identity service is configured here — use the deployed app to sign in."
      )
      return
    }
    if (identity.state === "unknown") {
      toast(
        "auth.sign-in.pending",
        "Still checking sign-in availability",
        "The identity service hasn't answered yet — try again in a moment."
      )
      return
    }
    const openExternal = services.openExternal
    if (openExternal !== undefined) {
      void nativeSignIn(openExternal)
      return
    }
    if (typeof window === "undefined") return
    // A sign-in from a repository page comes back to that page (the server
    // validates the path against its own origin and ignores anything else).
    const returnTo = signInReturnTo(window.location)
    const query = returnTo === null ? "" : `?${AUTH_RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`
    window.location.assign(`${baseUrl}${AUTH_SIGN_IN_PATH}${query}`)
  }

  /*
   * Sign-out that does not sign out must SAY so. Returning void on a failed
   * logout left the user looking at their own signed-in session with no hint
   * that the act had failed — the silent-failure shape, on the one act whose
   * whole point is that it took effect.
   */
  const signOut = async (): Promise<string | void> => {
    try {
      const response = await http(`${baseUrl}${AUTH_LOGOUT_PATH}`, { method: "POST" })
      if (!response.ok) {
        return await errorMessageOf(response, "Signing out didn't go through — you are still signed in.")
      }
    } catch {
      return "Signing out didn't go through — the identity service didn't answer. You are still signed in."
    }
    ctx.accountEpoch += 1
    store.dispatch({ type: "identity.session.cleared", actor: "user" })
    ctx.identityChanged()
  }

  /*
   * A.38: this used to answer nothing at all when there was nothing to do.
   * For a non-allowlisted account the auth message carries both the filed
   * request and any failure, so the outcome is visible where it belongs; for
   * everyone else the flow now says why it did nothing instead of POSTing
   * quietly and returning.
   */
  const requestAccess = async (): Promise<string | void> => {
    const identity = store.collections.identitySessions.get("identity")
    if (identity === undefined || identity.state !== "signed-in" || identity.login === null) {
      return "Sign in with GitHub first — an access request needs an account to attach to."
    }
    if (identity.allowlisted) {
      return `You already have access as ${identity.login} — there is no request to file.`
    }
    try {
      const response = await http(`${baseUrl}${IDENTITY_REQUEST_ACCESS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: identity.login })
      })
      if (!response.ok) {
        store.dispatch({
          type: "identity.access.failed",
          actor: "system",
          message: await errorMessageOf(response, "The access request did not go through. Try again.")
        })
        return
      }
    } catch {
      store.dispatch({
        type: "identity.access.failed",
        actor: "system",
        message: "The access request did not go through. Try again."
      })
      return
    }
    store.dispatch({ type: "identity.access.requested", actor: "user" })
  }

  /**
   * Billing seam: dollars only; chat is complimentary, so a definitive $0
   * never pauses it. A reply that arrives after the account moved is
   * TOAST_SUPERSEDED, not success: it describes an account the app no longer
   * has open, so nothing is written and the toast leaves without a result.
   */
  const refreshBalanceImpl = async (): Promise<true | typeof TOAST_SUPERSEDED | string> => {
    const identity = store.collections.identitySessions.get("identity")
    const epoch = ctx.accountEpoch
    const identityState = identity?.state
    const login = identity?.login
    const current = (): boolean => {
      const latest = store.collections.identitySessions.get("identity")
      return ctx.accountEpoch === epoch && latest?.state === identityState && latest?.login === login
    }
    let response: Response
    try {
      response = await http(`${baseUrl}${BILLING_BALANCE_PATH}`)
    } catch {
      if (!current()) return TOAST_SUPERSEDED
      store.dispatch({ type: "billing.unavailable", actor: "system" })
      return "Your balance couldn't be refreshed — the billing service didn't answer."
    }
    if (!current()) return TOAST_SUPERSEDED
    if (!response.ok) {
      await response.body?.cancel()
      store.dispatch({ type: "billing.unavailable", actor: "system" })
      return "Your balance couldn't be refreshed right now."
    }
    const body = (await response.json().catch(() => undefined)) as
      | {
        state?: unknown
        allowedToStartWork?: unknown
        balance?: { totalUsd?: unknown; lifetimeChargedUsd?: unknown; chargeCount?: unknown }
      }
      | undefined
    if (!current()) return TOAST_SUPERSEDED
    const state = body?.state
    if (
      body === undefined ||
      (state !== "ok" && state !== "low" && state !== "empty") ||
      typeof body.allowedToStartWork !== "boolean" ||
      typeof body.balance?.totalUsd !== "string"
    ) {
      store.dispatch({ type: "billing.unavailable", actor: "system" })
      return "Your balance couldn't be refreshed right now."
    }
    store.dispatch({
      type: "billing.refreshed",
      actor: "system",
      state,
      totalUsd: body.balance.totalUsd,
      allowedToStartWork: body.allowedToStartWork,
      lifetimeChargedUsd: typeof body.balance.lifetimeChargedUsd === "string" ? body.balance.lifetimeChargedUsd : "0",
      chargeCount: typeof body.balance.chargeCount === "number" ? body.balance.chargeCount : 0
    })
    return true
  }

  const refreshBalance = (): Promise<void> =>
    withToast("billing.balance.refresh", "Refreshing your balance…", "Balance is up to date", refreshBalanceImpl).then(
      () => undefined
    )

  /*
   * §22.7: this returned void, so the model's own `billing.balance` call
   * handed it NOTHING back and it answered from a guess — "$0.00" one line
   * above the card the same call had just rendered reading "$519 left". A
   * tool that can be invoked and cannot be read confabulates on every data
   * question, not just this one.
   */
  const showBalance = async (): Promise<string | { readonly value: string }> => {
    await refreshBalance()
    const account = store.collections.billingAccounts.get("billing")
    if (account === undefined || account.state === "unknown" || account.state === "unavailable") {
      return "The billing service didn't answer, so there is no balance to state right now."
    }
    // One balance card, re-surfaced at the end of the transcript each time it
    // is asked for: leaving it at its old ordinal would answer the command
    // with a silent no-op once the conversation has moved past it.
    const card: Card = {
      id: "billing-balance",
      kind: "balance",
      title: "Balance",
      status: "active",
      createdAt: Date.now(),
      ordinal: nextTranscriptOrdinal(),
      payload: {
        totalUsd: account.totalUsd ?? "0",
        state: account.state,
        allowedToStartWork: account.allowedToStartWork,
        lifetimeChargedUsd: account.lifetimeChargedUsd ?? "0",
        chargeCount: account.chargeCount,
        // The first-run line, stated once: an untouched grant reads
        // "You have $500 of usage on us." — after any charge it is gone.
        introUsd: account.chargeCount === 0 ? account.totalUsd : null
      }
    }
    store.dispatch({ type: "card.upsert", actor: "system", card })
    return {
      value: `balance: $${account.totalUsd ?? "0"} left; $${
        account.lifetimeChargedUsd ?? "0"
      } spent across ${account.chargeCount} turn(s)`
    }
  }

  /*
   * The admin plugin's controller half. Every read and write goes through the
   * product Worker's /api/admin/* routes, which re-validate the session and
   * answer 404-never-403 to non-admins; a 404 here therefore means "not an
   * admin (or not configured)" and is surfaced as an honest line.
   */
  const adminAllowlistImpl = async (action: "add" | "remove", login: string): Promise<true | string> => {
    try {
      const response = await http(`${baseUrl}${ADMIN_ALLOWLIST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login, action })
      })
      if (!response.ok) {
        const message = await errorMessageOf(response, "The allowlist change didn't go through.")
        store.dispatch({ type: "message.appended", actor: "system", text: message })
        return message
      }
      const echo = (await response.json().catch(() => undefined)) as
        | { applied?: unknown; duplicate?: unknown }
        | undefined
      const verb = action === "add" ? "added to" : "removed from"
      store.dispatch({
        type: "message.appended",
        actor: "system",
        text: echo?.duplicate === true
          ? `${login} was already ${action === "add" ? "on" : "off"} the allowlist — nothing changed.`
          : `${login} ${verb} the allowlist, recorded under your name.`
      })
    } catch {
      const message = "The allowlist change didn't go through — the admin route didn't answer."
      store.dispatch({ type: "message.appended", actor: "system", text: message })
      return message
    }
    return true
  }

  const adminAllowlist = (action: "add" | "remove", login: string): Promise<string | void> =>
    withToast(
      "admin.allowlist",
      "Updating the allowlist…",
      "Allowlist updated",
      () => adminAllowlistImpl(action, login)
    ).then(
      () => undefined
    )

  const adminGrant = (amountUsd: number, login: string): string | void => {
    // Never post directly: the confirmation card states exactly what will happen first.
    const card: Card = {
      id: `grant-${crypto.randomUUID()}`,
      kind: "grant-confirm",
      title: `Grant $${amountUsd} to ${login}?`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextTranscriptOrdinal(),
      payload: { login, amountUsd, phase: "confirm" }
    }
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    return undefined
  }

  const adminGrantConfirm = async (cardId: string): Promise<string | void> => {
    const card = store.collections.cards.get(cardId)
    if (card === undefined || card.kind !== "grant-confirm") return "That grant confirmation is gone."
    if (card.payload.phase === "granted") return "That grant was already posted."
    if (card.payload.phase === "sending") return undefined
    const { login, amountUsd } = card.payload
    store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { login, amountUsd, phase: "sending" } }
    })
    await withToast(
      "admin.grant",
      `Granting $${amountUsd} to ${login}…`,
      `Granted $${amountUsd} to ${login}`,
      async () => {
        try {
          // The card id is the grant's operation key: a retry after a lost
          // answer carries the same key, so the Worker forwards the same
          // billing grant id and the credit lands once.
          const response = await http(`${baseUrl}${ADMIN_GRANT_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ login, amountUsd, operationKey: card.id })
          })
          if (!response.ok) {
            const message = await errorMessageOf(response, "The grant didn't go through.")
            store.dispatch({
              type: "card.updated",
              actor: "system",
              id: card.id,
              patch: { status: "error", payload: { login, amountUsd, phase: "failed", error: message } }
            })
            return message
          }
          const echo = (await response.json().catch(() => undefined)) as
            | { grantId?: unknown; duplicate?: unknown }
            | undefined
          store.dispatch({
            type: "card.updated",
            actor: "system",
            id: card.id,
            patch: {
              status: "acted",
              payload: {
                login,
                amountUsd,
                phase: "granted",
                ...(typeof echo?.grantId === "string" ? { grantId: echo.grantId } : {})
              }
            }
          })
        } catch {
          const message = "The grant didn't go through — the admin route didn't answer."
          store.dispatch({
            type: "card.updated",
            actor: "system",
            id: card.id,
            patch: { status: "error", payload: { login, amountUsd, phase: "failed", error: message } }
          })
          return message
        }
        return true
      }
    )
    return undefined
  }

  const adminGrantCancel = (cardId: string): string | void => {
    const card = store.collections.cards.get(cardId)
    if (card === undefined || card.kind !== "grant-confirm") return "That grant confirmation is gone."
    if (card.payload.phase === "sending") return "That grant is already being posted — a moment."
    store.dispatch({ type: "card.removed", actor: ctx.commandActor, id: card.id })
    return undefined
  }

  const ADMIN_REQUESTS_CARD_ID = "admin-requests"

  /** Re-read the queue and refresh the queue card (also the post-approve refresh). */
  const adminRequestsImpl = async (): Promise<true | string> => {
    try {
      const response = await http(`${baseUrl}${ADMIN_REQUESTS_PATH}`)
      if (!response.ok) {
        const message = await errorMessageOf(response, "The request queue didn't answer.")
        store.dispatch({ type: "message.appended", actor: "system", text: message })
        return message
      }
      const body = (await response.json().catch(() => undefined)) as
        | { requests?: Array<{ login?: unknown; note?: unknown; createdAt?: unknown }> }
        | undefined
      const requests = (Array.isArray(body?.requests) ? body.requests : [])
        .filter((row) => typeof row.login === "string")
        .map((row) => ({
          login: row.login as string,
          note: typeof row.note === "string" ? row.note : null,
          createdAt: typeof row.createdAt === "string" ? row.createdAt : ""
        }))
      const existing = store.collections.cards.get(ADMIN_REQUESTS_CARD_ID)
      const card: Card = {
        id: ADMIN_REQUESTS_CARD_ID,
        kind: "request-queue",
        title: `Request-access queue — ${requests.length} waiting`,
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: { requests, approving: null }
      }
      store.dispatch({ type: "card.upsert", actor: "system", card })
    } catch {
      const message = "The request queue didn't answer — the admin route is unreachable."
      store.dispatch({ type: "message.appended", actor: "system", text: message })
      return message
    }
    return true
  }

  const adminRequests = (): Promise<string | void> =>
    withToast("admin.requests", "Reading the request queue…", "Request queue read", adminRequestsImpl).then(() =>
      undefined
    )

  const adminQueueApprove = async (login: string): Promise<string | void> => {
    const card = store.collections.cards.get(ADMIN_REQUESTS_CARD_ID)
    if (card !== undefined && card.kind === "request-queue") {
      store.dispatch({
        type: "card.updated",
        actor: ctx.commandActor,
        id: card.id,
        patch: { payload: { ...card.payload, approving: login, error: undefined } }
      })
    }
    const post = await withToast("admin.queue.approve", `Approving ${login}…`, `${login} approved`, async () => {
      try {
        const response = await http(`${baseUrl}${ADMIN_ALLOWLIST_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ login, action: "add" })
        })
        if (!response.ok) {
          const message = await errorMessageOf(response, `Approving ${login} didn't go through.`)
          const current = store.collections.cards.get(ADMIN_REQUESTS_CARD_ID)
          if (current !== undefined && current.kind === "request-queue") {
            store.dispatch({
              type: "card.updated",
              actor: "system",
              id: current.id,
              patch: { status: "error", payload: { ...current.payload, approving: null, error: message } }
            })
          }
          return message
        }
      } catch {
        const message = `Approving ${login} didn't go through — the admin route didn't answer.`
        const current = store.collections.cards.get(ADMIN_REQUESTS_CARD_ID)
        if (current !== undefined && current.kind === "request-queue") {
          store.dispatch({
            type: "card.updated",
            actor: "system",
            id: current.id,
            patch: { status: "error", payload: { ...current.payload, approving: null, error: message } }
          })
        }
        return message
      }
      return true
    })
    if (post !== true) return undefined
    // The queue card re-reads from the server — never from local optimism.
    await adminRequests()
    return undefined
  }

  const adminHealthImpl = async (): Promise<true | string> => {
    try {
      const response = await http(`${baseUrl}${ADMIN_HEALTH_PATH}`)
      if (!response.ok) {
        const message = await errorMessageOf(response, "The health read didn't answer.")
        store.dispatch({ type: "message.appended", actor: "system", text: message })
        return message
      }
      const body = (await response.json().catch(() => undefined)) as
        | {
          services?: Array<{ name?: unknown; status?: unknown; detail?: unknown }>
          charges?: { chargeCount?: unknown; lifetimeChargedUsd?: unknown } | null
          queueDepth?: unknown
          checkedAt?: unknown
        }
        | undefined
      if (!Array.isArray(body?.services)) {
        const message = "The health read answered in a shape I didn't understand."
        store.dispatch({ type: "message.appended", actor: "system", text: message })
        return message
      }
      const services = body.services
        .filter(
          (service) =>
            typeof service.name === "string" &&
            (service.status === "ok" || service.status === "failed" || service.status === "unconfigured") &&
            typeof service.detail === "string"
        )
        .map((service) => ({
          name: service.name as string,
          status: service.status as "ok" | "failed" | "unconfigured",
          detail: service.detail as string
        }))
      const charges = body.charges !== null &&
          body.charges !== undefined &&
          typeof body.charges.chargeCount === "number" &&
          typeof body.charges.lifetimeChargedUsd === "string"
        ? { chargeCount: body.charges.chargeCount, lifetimeChargedUsd: body.charges.lifetimeChargedUsd }
        : null
      const existing = store.collections.cards.get("admin-health")
      const card: Card = {
        id: "admin-health",
        kind: "admin-health",
        title: "What failed overnight?",
        status: services.some((service) => service.status === "failed") ? "error" : "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: {
          services,
          queueDepth: typeof body.queueDepth === "number" ? body.queueDepth : null,
          charges,
          checkedAt: typeof body.checkedAt === "string" ? body.checkedAt : new Date().toISOString()
        }
      }
      store.dispatch({ type: "card.upsert", actor: "system", card })
    } catch {
      const message = "The health read didn't answer — the admin route is unreachable."
      store.dispatch({ type: "message.appended", actor: "system", text: message })
      return message
    }
    return true
  }

  const adminHealth = (): Promise<string | void> =>
    withToast("admin.health", "Reading service health…", "Service health read", adminHealthImpl).then(() => undefined)

  /*
   * Chat is complimentary during the alpha: the billing seam records each
   * turn's true cost and debits zero, so the UI carries NO per-turn dollar
   * line. The balance chip still refreshes from the real answer after a turn.
   */
  const settleTurnBilling = (): void => {
    void refreshBalance()
  }

  /*
   * §2.5 / §23.4 — identity is shared between tabs; the app's copy of it was
   * not. The session cookie is per-origin, so signing in on one tab signs in
   * every tab, yet a tab that had already read `/api/auth/session` kept
   * rendering the signed-out card until someone reloaded it by hand — and the
   * same asymmetry ran the other way after a sign-out.
   *
   * A tab re-reads the session whenever it comes back to the foreground, and
   * a tab that changes identity itself tells its siblings at once. This is a
   * host subscription, not React lifecycle, so it lives with the state it
   * corrects.
   */
  const IDENTITY_CHANNEL = "smithers.identity"
  const watchIdentityAcrossTabs = (): void => {
    if (typeof document === "undefined" || typeof window === "undefined") return
    let reading = false
    const reread = (): void => {
      if (reading || document.visibilityState === "hidden") return
      reading = true
      void loadSession().finally(() => {
        reading = false
      })
    }
    document.addEventListener("visibilitychange", reread)
    window.addEventListener("focus", reread)
    // Everything opened here is released when the controller's scope closes.
    ctx.onDispose(() => {
      document.removeEventListener("visibilitychange", reread)
      window.removeEventListener("focus", reread)
    })
    if (typeof BroadcastChannel === "undefined") return
    const channel = new BroadcastChannel(IDENTITY_CHANNEL)
    channel.onmessage = () => {
      // A sibling's identity changed: re-read the seam rather than trust
      // the message — the cookie is the authority, not the announcement.
      void loadSession()
    }
    ctx.onDispose(() => {
      channel.onmessage = null
      channel.close()
      ctx.identityChanged = () => {}
    })
    ctx.identityChanged = () => {
      channel.postMessage("changed")
    }
  }

  return {
    handleAuthReturn,
    adoptSession,
    loadSession,
    signIn,
    signOut,
    requestAccess,
    refreshBalance,
    showBalance,
    adminAllowlist,
    adminGrant,
    adminGrantConfirm,
    adminGrantCancel,
    adminRequests,
    adminQueueApprove,
    adminHealth,
    settleTurnBilling,
    watchIdentityAcrossTabs
  }
}
