import { Effect, Metric, Option } from "effect"
import { codeOf } from "../../errorCode"
import { FlowDispatch } from "../../flows/dispatch"
import type { AppTemplate } from "./contract"
import { type IssuesProps, OPENED, type RepoProps } from "./schema"
import { ViewsStore } from "./store"

// A repository's page and its issues page are the full-screen size of a view in the chat (ruling FE-9, decision 0004
// §3): Back to chat minimizes them. A page opened from a view in a conversation goes back to the page that shows that
// view; any other leaves the repository in the home conversation, as the view `/repo` or `/issues` adds, unless the
// home conversation shows it already, and goes there. Either way the person lands in the chat at once: the view is
// added in the background, by the same flows the agent calls (FLOW-3).

/** What Back to chat leaves in the chat: a repository's view at a location, or a repository's issues view. */
export type Minimized =
  | { readonly template: "repo"; readonly props: RepoProps }
  | { readonly template: "issues"; readonly props: IssuesProps }

/** The chat: the home conversation's page. */
export const CHAT_PATH = "/app"

/** How long Back to chat waits for the home conversation's views before it decides whether to add one. */
export const HOME_VIEWS_WITHIN = "5 seconds"

/** Back to chat on a repository's pages, by `returned` (`origin`, `chat`) and `outcome` (`kept`, `added`, `failed`). */
export const minimized = Metric.counter("smithers_views_minimized", {
  description: "Back to chat from a repository's full-screen pages, by where it returned and what it left in the chat",
  incremental: true,
})

/**
 * Whether two views of `template` show the same thing: the same repository, whatever its case, and for a repository's
 * view the same ref and path (none is the default branch's root); a path's kind counts only when both name one.
 */
export const sameTarget = (template: AppTemplate, a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean => {
  if (String(a["repo"] ?? "").toLowerCase() !== String(b["repo"] ?? "").toLowerCase()) return false
  if (template === "issues") return true
  const kinds = [a["kind"], b["kind"]]
  return a["ref"] === b["ref"] && (a["path"] ?? "") === (b["path"] ?? "") &&
    (kinds.includes(undefined) || kinds[0] === kinds[1])
}

const record = (
  returned: "origin" | "chat",
  outcome: "kept" | "added" | "failed" | "returned",
  template: AppTemplate,
  reason?: string,
) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(minimized, { returned, outcome }), 1),
    Effect.logWithLevel(outcome === "failed" ? "Warn" : "Info")("views.minimize").pipe(
      Effect.annotateLogs({ returned, outcome, template, feature: "views", ...(reason === undefined ? {} : { reason }) }),
    ),
  )

/**
 * Records that this tab opens view `viewId` of `template`, showing repository `repo`, full screen from the page at
 * `returnTo`: Back to chat on that repository's pages returns there.
 */
export const opened = (viewId: string, template: AppTemplate, repo: string, returnTo: string) =>
  Effect.flatMap(ViewsStore, ({ opened }) =>
    opened.update(OPENED, (row) => {
      row.viewId = viewId
      row.template = template
      row.repo = repo.toLowerCase()
      row.returnTo = returnTo
    })).pipe(
      // A local collection refuses only a row its own schema rejects, which these never are: a bug, not a state.
      Effect.orDie,
    )

/** Adds `target` to the home conversation unless it shows it already, once its views are on the device or the wait ends. */
const leave = (target: Minimized) =>
  Effect.gen(function* () {
    const { views } = yield* ViewsStore
    // A slow first sync is waited on only so long; one that fails leaves the device's views as if they were all.
    const loaded = yield* Effect.result(Effect.timeoutOption(views.preload, HOME_VIEWS_WITHIN))
    if (loaded._tag === "Failure") {
      yield* Effect.logWarning("views.home.load").pipe(
        Effect.annotateLogs({ feature: "views", outcome: "failed", errorCode: codeOf(loaded.failure) }),
      )
    }
    const rows = yield* views.toArray
    if (rows.some((row) => row.template === target.template && sameTarget(target.template, row.props, target.props))) {
      return yield* record("chat", "kept", target.template)
    }
    const flows = yield* FlowDispatch
    const added = yield* Effect.result(
      target.template === "repo"
        ? flows.dispatch("ui/repo", target.props, { door: "button" })
        : flows.dispatch("ui/issues", target.props, { door: "button" }),
    )
    // Why it wasn't added, content-free: the dispatch's refusal, or the flow's failure tag.
    const reason = added._tag === "Failure"
      ? added.failure.reason
      : added.success._tag === "Failed"
      ? String((added.success.error as { readonly _tag?: unknown })._tag)
      : undefined
    yield* record("chat", reason === undefined ? "added" : "failed", target.template, reason)
  })

/**
 * Back to chat on a page that shows `target` full screen: the path to go to now. The page a view of the same repository
 * was opened from, as `opened` recorded it; else the chat, with `target` left in the home conversation in the
 * background.
 */
export const minimize = (target: Minimized) =>
  Effect.gen(function* () {
    const store = yield* ViewsStore
    const origin = Option.getOrThrow(yield* store.opened.get(OPENED))
    if (origin.returnTo !== null && origin.template === target.template && origin.repo === target.props.repo.toLowerCase()) {
      yield* record("origin", "returned", target.template)
      return origin.returnTo
    }
    yield* Effect.forkIn(leave(target), store.scope, { startImmediately: true })
    return CHAT_PATH
  }).pipe(Effect.withSpan("views.minimize"))
