/*
 * The account card's controller half (factory mock 21, design session §6c):
 * `account.show` renders who is signed in as one read-only card of seam
 * facts. Every row comes from a seam the app already has: the identity
 * session (login, allowlist answer, access request), the identity worker's
 * scopes read (GET /api/auth/scopes, the same read the signed-out consent
 * copy makes), and the cloudWorkspaces collection (the boxes the workspaces
 * seam has listed, across every repository). A row whose seam did not answer
 * is absent. No billing, usage or seat rows exist because no seam holds them.
 *
 * Signed out, the card IS the sign-in step: the flow renders auth.prompt's
 * message, never an empty account.
 */
import { AUTH_SCOPES_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"

export interface AccountController {
  /** The `account.show` handler: the account card, or the sign-in step when no session is signed in. */
  readonly showAccount: () => Promise<string | { readonly value: string }>
}

export interface AccountControllerDeps {
  /** The next transcript ordinal — the card surfaces at the end, never mid-history. */
  readonly nextOrdinal: () => number
  /** auth.prompt's renderer: the sign-in step as a message whose action is the sign-in button. */
  readonly promptSignIn: () => void
}

/** The one card: re-surfaced at the end of the transcript each time it is asked for. */
export const ACCOUNT_CARD_ID = "account"

/** What the tool result says when the flow answered signed out; the model tells the human to click, never to type. */
export const SIGNED_OUT_VALUE = "signed out: the sign-in step is in the chat"

/** The honest refusal while the identity seam has not answered yet. */
export const IDENTITY_PENDING_TEXT = "Still checking who is signed in. Try again in a moment."

interface ScopeRow {
  readonly scope: string
  readonly plain: string
}

export const createAccountController = (ctx: ControllerContext, deps: AccountControllerDeps): AccountController => {
  /*
   * The scopes the identity worker states, as `{ scope, plain }` rows. A
   * failed or malformed answer is an empty list, and the card then renders
   * no scopes section: absence over a guessed scope list.
   */
  const readScopes = async (): Promise<ReadonlyArray<ScopeRow>> => {
    try {
      const response = await ctx.boundedFetch(`${ctx.baseUrl}${AUTH_SCOPES_PATH}`)
      if (!response.ok) {
        await response.body?.cancel()
        return []
      }
      const body = (await response.json()) as { scopes?: unknown }
      if (!Array.isArray(body.scopes)) return []
      return body.scopes.flatMap((row): Array<ScopeRow> => {
        if (typeof row !== "object" || row === null) return []
        const scope = "scope" in row && typeof row.scope === "string" ? row.scope.trim() : ""
        const plain = "plain" in row && typeof row.plain === "string" ? row.plain.trim() : ""
        return scope === "" || plain === "" ? [] : [{ scope, plain }]
      })
    } catch {
      return []
    }
  }

  const showAccount = async (): Promise<string | { readonly value: string }> => {
    const { collections } = ctx.store
    const identity = collections.identitySessions.get("identity")
    if (identity === undefined || identity.state === "unknown") return IDENTITY_PENDING_TEXT
    if (identity.state !== "signed-in" || identity.login === null) {
      // Signed out or no seam: auth.prompt's message states which, with the sign-in button when one exists.
      deps.promptSignIn()
      return { value: SIGNED_OUT_VALUE }
    }
    const scopes = await readScopes()
    const boxes = [...collections.cloudWorkspaces.values()]
      .map((workspace) => ({ id: workspace.id, repoId: workspace.repoId, name: workspace.name, status: workspace.status }))
      .sort((left, right) => left.repoId.localeCompare(right.repoId) || left.name.localeCompare(right.name))
    const card: Card = {
      id: ACCOUNT_CARD_ID,
      kind: "account",
      title: `Account · @${identity.login}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: deps.nextOrdinal(),
      payload: {
        login: identity.login,
        scopes: [...scopes],
        allowlisted: identity.allowlisted,
        accessRequested: identity.accessRequested,
        boxes
      }
    }
    ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    const access = identity.allowlisted ? "allowed" : identity.accessRequested ? "requested" : "not yet allowed"
    return {
      value: `account: @${identity.login}; access ${access}; ${scopes.length} GitHub scope(s); ${boxes.length} box(es) listed`
    }
  }

  return { showAccount }
}
