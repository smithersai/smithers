import { Host } from "@smthrs/plugin"
import { Effect } from "effect"

// The bug plugin's tab (docs/features/bugs.md): the reports the viewer may see, from the core's
// `core/bug-reports` (every report for an Admin, a person's own for anyone else), and the form's Send. Send runs the
// view's `send` event, which the manifest binds to `app/bug/report`, the flow `/bug` and the agent run too. A report is
// Sent once its row comes back from ChatApi through sync, never on the press alone; a run that fails says so, with its
// reason, and keeps the words for Retry (`Dispatched.settled`). Its only wiring is its manifest (../plugin.json) and
// `PluginHost`.

/** One failure a report carries: the flow and its code. */
export interface Failure {
  readonly flow: string
  readonly code: string
}

/** One report, as `core/bug-reports` has it: the row, and GitHub's prefilled new-issue form for it. */
export interface Report {
  readonly id: string
  readonly reporterLogin: string | null
  readonly reporterRole: string | null
  readonly actedBy: string | null
  readonly what: string
  readonly route: string | null
  readonly repo: string | null
  readonly build: string
  readonly traces: ReadonlyArray<string>
  readonly runs: ReadonlyArray<string>
  readonly failures: ReadonlyArray<Failure>
  readonly browser: string
  readonly viewport: string
  readonly createdAt: string
  readonly github: string
}

/**
 * Where the form's last Send stands: nothing sent yet; on its way, with its id and words; Sent, with its report; or
 * not sent, with its id, words and the failure's code, so Retry sends the same report again.
 */
export type Sending =
  | { readonly status: "idle" }
  | { readonly status: "sending"; readonly id: string; readonly what: string }
  | { readonly status: "sent"; readonly report: Report }
  | { readonly status: "failed"; readonly id: string; readonly what: string; readonly code: string }

/** The form's view, whose `send` event files a report. */
export const FORM = "bugs/report"

/** The inbox's view. */
export const INBOX = "bugs/inbox"

/** The longest report the form sends, as the manifest's `Report` allows. */
export const MAX_WHAT = 4_000

/** What a person's words become: trimmed at the ends; nothing to send when only spaces, or too long. */
export const whatOf = (text: string): string | undefined => {
  const what = text.trim()
  return what === "" || what.length > MAX_WHAT ? undefined : what
}

/** Where the last Send stands once `rows` arrived: Sent when its report is among them. */
export const settle = (sending: Sending, rows: ReadonlyArray<Report>): Sending => {
  if (sending.status !== "sending") return sending
  const report = rows.find((row) => row.id === sending.id)
  return report === undefined ? sending : { status: "sent", report }
}

/** Why a report wasn't sent, in a few words, from its failure's code. */
export const reasonOf = (code: string): string => {
  switch (code) {
    case "authentication":
      return "signed out"
    case "forbidden":
      return "not allowed"
    case "invalid":
    case "invalid_fields":
      return "not accepted"
    case "too_large":
      return "too long"
    case "BugUnsent":
      return "couldn't reach Smithers"
    default:
      return code
  }
}

/**
 * The id a Send of `what` files under: the failed report's again when its words are unchanged, so Retry never files a
 * second copy; a new one otherwise.
 */
export const idFor = (sending: Sending, what: string, fresh: () => string): string =>
  sending.status === "failed" && sending.what === what ? sending.id : fresh()

/** One value, live: what it is now, and a way to hear it changed. */
export interface Watched<A> {
  readonly current: () => A
  readonly subscribe: (listener: () => void) => () => void
}

/** What the bug plugin's components read and do. */
export interface BugsTab {
  readonly queries: { readonly reports: Host.Live<Report>; readonly sending: Watched<Sending> }
  readonly actions: {
    /** Files a report of `text`, or a failed one again; nothing when it is empty, too long, or one is on its way. */
    readonly send: (text: string) => void
    /** Opens the form. */
    readonly report: () => void
  }
}

/** The tab: built by the host in the plugin's scope on first use. */
export const tab = Effect.gen(function* () {
  const host = yield* Host.PluginHost
  const run = Effect.runForkWith(yield* Effect.context<never>())
  const reports = yield* host.query<Report>("core/bug-reports")
  let sending: Sending = { status: "idle" }
  const listeners = new Set<() => void>()
  const set = (next: Sending) => {
    sending = next
    for (const listener of listeners) listener()
  }
  const stop = reports.subscribe(() => {
    const next = settle(sending, reports.current())
    if (next !== sending) set(next)
  })
  yield* Effect.addFinalizer(() => Effect.sync(stop))

  const send = (text: string) => {
    const what = whatOf(text)
    if (what === undefined || sending.status === "sending") return
    const id = idFor(sending, what, () => crypto.randomUUID())
    set({ status: "sending", id, what })
    const failed = (code: string) => Effect.sync(() => set({ status: "failed", id, what, code }))
    run(
      host.dispatch({ view: FORM, name: "send" }, { id, what }).pipe(
        Effect.flatMap((dispatched) => dispatched.settled),
        Effect.matchEffect({
          // The host refused the event before anything ran: nothing was filed.
          onFailure: (refused) => failed(refused.reason),
          onSuccess: (settled) =>
            settled._tag === "Failed"
              ? failed(settled.code)
              // Filed: Sent once its row is here, which it may be already.
              : Effect.sync(() => set(settle(sending, reports.current()))),
        }),
      ),
    )
  }

  return {
    queries: {
      reports,
      sending: {
        current: () => sending,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
      },
    },
    actions: { send, report: () => void run(host.open(FORM)) },
  } satisfies BugsTab
})
