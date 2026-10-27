import { Context, Effect, Option, type Scope } from "effect"
import { type Door, FlowDispatch } from "../../flows/dispatch"
import { PLACE } from "../chat/schema"
import { ChatStore } from "../chat/store"
import type { WebMode, WebOutcome } from "./contract"
import { recordOpening, withOpenSpan } from "./metrics"
import { checkUrl, type Policy, type Refusal } from "./url"

// What a person's door does with a web page (docs/features/web-pages.md#a-persons-door): `/web <url> [embed|tab]` in
// the composer runs `app/web/open`, the flow the agent calls. Browsers open a tab only from a person's own click or key,
// so a person's `tab` first tries to open it right in their keypress, before anything waits; when the browser won't, or
// can't say it did, the flow adds the card instead. The tab records each of a person's openings, by their door.

/** What the browser gives web pages: its URL policy, and a tab opened from the person's current click or key. */
export interface WebHost {
  readonly policy: Policy
  /**
   * Opens `href` in a new tab, with no opener and no referrer, if the person's click or key still allows it: whether it
   * did. `false` whenever the browser can't say, so the app never claims a tab it didn't open.
   */
  readonly openTab: (href: string) => boolean
}

/** The browser's {@link WebHost}, for the tab. */
export class WebTab extends Context.Service<WebTab, WebHost>()("@smthrs/mvp/web/WebTab") {}

/**
 * Why this tab's policy refuses a person's page, if it does, counted as `refused` by their door: the composer keeps
 * the line and says why, and nothing runs. Nothing without a browser to ask; the flow checks again either way.
 */
export const refusedPage = (page: { readonly url: string; readonly mode?: WebMode | undefined }, door: Door) =>
  Effect.gen(function* () {
    const host = yield* Effect.serviceOption(WebTab)
    if (Option.isNone(host)) return Option.none<Refusal>()
    const mode = page.mode ?? "embed"
    const checked = checkUrl(page.url, mode, host.value.policy)
    if (checked.ok) return Option.none<Refusal>()
    yield* recordOpening({ mode, door, outcome: "refused", reason: checked.reason }).pipe(withOpenSpan(mode))
    return Option.some(checked.reason)
  })

/** The doors that are a person's own click or key, from which a browser may let a page open a tab. */
const GESTURES: ReadonlySet<Door> = new Set(["slash", "button"])

/**
 * Opens a person's `tab` page straight from their click or key: only for `tab`, a gesture's door, a URL the policy
 * allows and a browser that says it opened it. Synchronous, so it runs inside the gesture. Answers whether it opened.
 */
export const openFromGesture = (page: { readonly url: string; readonly mode: WebMode }, door: Door) =>
  Effect.gen(function* () {
    const host = yield* Effect.serviceOption(WebTab)
    if (page.mode !== "tab" || !GESTURES.has(door) || Option.isNone(host)) return false
    const checked = checkUrl(page.url, "tab", host.value.policy)
    if (!checked.ok || !host.value.openTab(checked.page.href)) return false
    yield* recordOpening({ mode: "tab", door, outcome: "opened" }).pipe(withOpenSpan("tab"))
    return true
  })

/** How a declared failure of the flow counts. */
const failedAs = (tag: string): WebOutcome =>
  tag === "@smthrs/mvp/web/WebPageRefused"
    ? "refused"
    : tag === "@smthrs/mvp/web/WebPageForbidden"
    ? "forbidden"
    : "unavailable"

/**
 * Runs `app/web/open` through dispatch, door `door`, and records the opening by how the flow answered: what it showed,
 * its declared failure, or, when it never ran, `refused` for a payload its schema refuses (a URL over the limit) and
 * `unavailable` for anything else.
 */
export const dispatchOpen = (page: { readonly url: string; readonly mode: WebMode }, door: Door, askedIn?: string | null) =>
  Effect.gen(function* () {
    // The conversation this tab shows now is where the person asked: pinned in the payload, so switching branches
    // before the step runs, or a run resumed later, still adds the view there (decision 0013 §1).
    const chat = yield* Effect.serviceOption(ChatStore)
    const place = Option.isSome(chat) ? Option.getOrUndefined(yield* chat.value.place.get(PLACE)) : undefined
    const conversationId = (askedIn === undefined ? place?.conversationId : askedIn) ?? undefined
    const dispatched = yield* (yield* FlowDispatch).dispatch(
      "app/web/open",
      conversationId === undefined ? page : { ...page, conversationId },
      { door },
    ).pipe(Effect.result)
    const opened = dispatched._tag === "Success" && dispatched.success._tag === "Done" ? dispatched.success.value : undefined
    const outcome: WebOutcome = dispatched._tag === "Failure"
      ? dispatched.failure.reason === "invalid" ? "refused" : "unavailable"
      : dispatched.success._tag === "Failed"
      ? failedAs(dispatched.success.error._tag)
      : opened?.shown === "page"
      ? "embedded"
      : "card"
    yield* recordOpening({ mode: page.mode, door, outcome, ...(opened === undefined ? {} : { framing: opened.framing }) })
  }).pipe(withOpenSpan(page.mode))

/**
 * A person's `app/web/open { url, mode? }` through `door`: a `tab` page opens straight from their gesture when the
 * browser allows it; otherwise the flow runs in `scope`, in the background, and adds the view or the card. Returns once
 * the gesture's part is done.
 */
export const openWebPage = (
  page: { readonly url: string; readonly mode?: WebMode | undefined },
  door: Door,
  scope: Scope.Scope,
  askedIn?: string | null,
) =>
  Effect.gen(function* () {
    const shown = { url: page.url, mode: page.mode ?? "embed" }
    if (yield* openFromGesture(shown, door)) return
    yield* dispatchOpen(shown, door, askedIn).pipe(Effect.forkIn(scope))
  })

/** A person opened a card's page in a new tab: their click on its Open button, door `view`. */
export const cardOpened = recordOpening({ mode: "tab", door: "view", outcome: "opened" }).pipe(withOpenSpan("tab"))
