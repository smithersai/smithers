/**
 * What the app SAYS about a refusal, in one table, keyed by whose fault it is.
 *
 * The refusing party's own words are never rewritten — the workspace card's
 * standing rule is "plue's own words, verbatim", and they still render
 * underneath. What this file adds is the one sentence those words cannot
 * carry: whose problem this is. "service unavailable" reads identically
 * whether the caller asked for something they may not have, whether the thing
 * simply is not ready yet, or whether Smithers' own fleet is full — and a
 * person cannot act on it, or stop blaming themselves for it, until somebody
 * says which.
 *
 * Three consumers, one row: `lead` is the line the interface puts above the
 * server's words, `agent` is the sentence the chat model is handed with the
 * tool result so it states the fault class instead of inferring it from prose,
 * and `doors` is which ways out the surface offers.
 *
 * The table is keyed by fault and overridden per code, not written per code:
 * there are 95 codes and five faults, and the fault is the part a person acts
 * on. `satisfies Record<PlueFault, RefusalCopyRow>` means a fault plue adds
 * has no copy until somebody writes it, which is a compile error rather than a
 * blank line in front of a user.
 *
 * @since 1.0.0
 */
import { PLUE_FAILURES } from "./PlueFailureCodes.ts"
import type { PlueFailureCode, PlueFault } from "./PlueFailureCodes.ts"
import { plueFailureCode } from "./Refusal.ts"
import type { Refusal } from "./Refusal.ts"

/**
 * The whole of the infra answer, in one place so it can be reworded in one
 * place.
 *
 * This is the product owner's ruling, close to verbatim: an infra failure must
 * say plainly that it is NOT the user's fault and that the fix is more infra,
 * by name. It is deliberately not corporate — "we're experiencing higher than
 * usual demand" is the sentence that makes a person think they did something
 * wrong, and a full fleet is the one failure where they certainly did not.
 *
 * It is words only for now. Whether "Tell @fucory" is a real door — a button
 * that files something — has not been ruled on, so nothing here renders a
 * control; `RefusalDoor`'s `report` member is the seam where one would attach.
 *
 * @since 1.0.0
 * @category constants
 */
export const INFRA_NOT_YOUR_FAULT = "This is not your fault — Smithers ran out of infra. Yell at @fucory to buy more."

/**
 * A way out of a refusal, offered by whichever surface is rendering it.
 *
 * @since 1.0.0
 * @category models
 */
export type RefusalDoor =
  /** Run the same request again, by hand. */
  | "retry"
  /** The box is not running; start it and try again. */
  | "resume"
  /** The session is the problem, not the request. */
  | "sign-in"
  /*
   * Somebody at Smithers needs to know. NOT YET A CONTROL: no surface renders
   * a button for this door, because whether "Tell @fucory" files something or
   * merely says something is the product owner's call and has not been made.
   * It is carried in the table so the decision has exactly one place to land —
   * a surface's door switch gains a case, and every infra and bug refusal in
   * the app has the affordance at once.
   */
  | "report"

/**
 * What the app says about one class of refusal.
 *
 * @since 1.0.0
 * @category models
 */
export interface RefusalCopyRow {
  /** The line the interface adds ABOVE the refusing party's own words. Never replaces them. */
  readonly lead: string
  /** The sentence handed to the chat model with the tool result, so it is told the fault class rather than guessing it. */
  readonly agent: string
  /**
   * The ways out this refusal licenses.
   *
   * `retry` here is the HUMAN's re-ask — a button they press after they have
   * changed something or decided to stop waiting. It is not permission for the
   * app or the model to re-run anything on its own: that is `mayAutoRetry`,
   * which only ever says yes to a `wait` fault, and the `agent` sentence
   * above, which tells the model when not to.
   */
  readonly doors: ReadonlyArray<RefusalDoor>
}

/**
 * The copy for each fault. Every fault must have a row; a new one does not compile until it does.
 *
 * @since 1.0.0
 * @category constants
 */
export const REFUSAL_COPY = {
  user: {
    lead: "Smithers can't do that as asked.",
    agent:
      "fault=user: the request itself has to change — running it again unchanged fails the same way. Tell the user what to change. Do not apologise for a platform failure; this was not one.",
    doors: ["retry"]
  },
  wait: {
    lead: "Not ready yet — nothing is wrong.",
    agent:
      "fault=wait: nothing is broken, it just is not ready yet, and the server said how long to wait. The app is already waiting where it is allowed to; do not re-run it in a loop.",
    doors: ["retry"]
  },
  infra: {
    lead: INFRA_NOT_YOUR_FAULT,
    agent:
      "fault=infra: Smithers' own infrastructure failed, NOT the user. Say plainly that this is not their fault and that the fix is more infra — yell at @fucory to buy more. Do not suggest they change their request, and do not retry it on a timer.",
    doors: ["retry", "report"]
  },
  dependency: {
    lead: "Something Smithers depends on failed. Not your doing.",
    agent:
      "fault=dependency: a service Smithers depends on (GitHub, a model provider, billing) failed or throttled us. Not the user's doing and not their request's. Say which one if the message names it, and that it is worth trying again later.",
    doors: ["retry"]
  },
  bug: {
    lead: "That's a bug in Smithers, not something you did.",
    agent:
      "fault=bug: Smithers is defective here. Do not blame the user, do not invent a workaround, and do not dress the internal message up as an explanation.",
    doors: ["retry", "report"]
  }
} satisfies Record<PlueFault, RefusalCopyRow>

/*
 * The codes whose fault does not say enough on its own. A row here overrides
 * only the fields it names — the fault's row still supplies the rest — and a
 * code that is not one of plue's does not compile.
 */
const BY_CODE: Partial<Record<PlueFailureCode, Partial<RefusalCopyRow>>> = {
  /*
   * The one a full fleet produces, and the reason this file exists. It takes
   * the infra lead unchanged; what it adds is that the box itself survived, so
   * nobody reads "no capacity" as "my work is gone".
   */
  no_capacity: {
    agent:
      "fault=infra: every box in the fleet is full — the user's own box and its disk are untouched. Say plainly that this is not their fault and that the fix is more infra: yell at @fucory to buy more. Do not retry it on a timer.",
    doors: ["retry", "report"]
  },
  /*
   * The user-fault twin of no_capacity, and the one that must NEVER show the
   * infra line: this account is at its own cap, which is a fact about them and
   * is fixed by them.
   */
  quota_exceeded: {
    lead: "Your account is at its cap — this one is yours to clear.",
    agent:
      "fault=user: THIS ACCOUNT is at a per-resource cap (for example, how many boxes it may keep running) — this is not the fleet being full. Tell them what to free up. Never tell them it is not their fault and never mention buying more infra.",
    doors: []
  },
  rate_limit_exceeded: { lead: "You're going faster than Smithers allows. Give it a minute.", doors: ["retry"] },
  /* The 409 the desktop facet has always offered Resume for: the box is stopped, not broken. */
  desktop_not_running: { lead: "That box isn't running.", doors: ["resume", "retry"] },
  retained_runtime_not_running: { lead: "That box isn't running.", doors: ["resume", "retry"] },
  unauthorized: { lead: "Smithers Cloud doesn't recognise this session.", doors: ["sign-in"] },
  github_reconnect_required: { lead: "GitHub needs reconnecting before this can run.", doors: ["sign-in"] },
  NOT_ON_WAITLIST: { lead: "This account isn't off the alpha waitlist yet.", doors: [] }
}

/**
 * The copy for one refusal: its fault's row, with any per-code override applied.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalCopy = (refusal: Refusal): RefusalCopyRow => {
  const base = REFUSAL_COPY[refusal.fault]
  const override = refusal.code === null ? undefined : BY_CODE[refusal.code]
  const row = override === undefined ? base : { ...base, ...override }
  /*
   * A 409 that named no code at all. plue always codes its refusals now, so
   * this is an older deployment or the Worker's own envelope — and 409 on a
   * box act has one meaning, "not in a state that allows this", whose way out
   * has always been Resume. A CODED refusal never reaches this line: its row
   * above has already said what to offer, `desktop_not_running` included.
   */
  return refusal.code === null && refusal.status === 409 && !row.doors.includes("resume")
    ? { ...row, doors: [...row.doors, "resume"] }
    : row
}

/**
 * The line the interface puts above the refusing party's own words.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalLead = (refusal: Refusal): string => refusalCopy(refusal).lead

/**
 * Which ways out this surface should offer. A surface renders only the doors it has.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalDoors = (refusal: Refusal): ReadonlyArray<RefusalDoor> => refusalCopy(refusal).doors

/**
 * The one sentence a seam hands back for a refusal — the line a person reads
 * in the transcript or a toast.
 *
 * Its shape is `<code> — <the refusing party's own words>. <lead>`: the code
 * first, which is the convention the workspace seam already used and which is
 * also the anchor `agentFaultNote` reads; then plue's words, untouched; then
 * the one line that says whose fault it was. A person who never opens the card
 * still gets told that a full fleet is not their doing.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalSentence = (refusal: Refusal): string => {
  const words = refusal.message.trim()
  const stopped = words === "" || /[.!?]$/u.test(words) ? words : `${words}.`
  const head = refusal.rawCode === null ? "" : `${refusal.rawCode} — `
  return stopped === "" ? `${head}${refusalCopy(refusal).lead}` : `${head}${stopped} ${refusalCopy(refusal).lead}`
}

/*
 * A code as `refusalSentence` writes it, at the front of the string and
 * nowhere else. Anchored on purpose: several of plue's codes (`conflict`,
 * `internal`, `not_found`) are ordinary English words, and a scan for them
 * anywhere in a sentence would be the prose-matching this whole file exists
 * to remove.
 */
const LEADING_CODE = /^([A-Za-z][A-Za-z0-9_]*) — /u

/**
 * The fault the model should be told, for a refusal that reached the agent
 * boundary as a STRING rather than as an object.
 *
 * A seam's refusal travels through the flow harness, whose failure channel
 * carries a message and nothing else (`CallResult`; see
 * LIBRARY-CHANGE-REQUESTS.md, which already asks for more). So the verdict is
 * recovered from the one machine token the app itself put at the front of that
 * message, looked up in the closed vendored registry — never inferred from the
 * English around it. A string with no code in that position gets no note, and
 * the model is left with the sentence rather than a guess dressed as a fact.
 *
 * @since 1.0.0
 * @category constants
 */
export const agentFaultNote = (text: string): string | null => {
  const code = plueFailureCode(LEADING_CODE.exec(text)?.[1])
  if (code === null) return null
  const entry = PLUE_FAILURES[code]
  const copy = refusalCopy({
    code,
    rawCode: code,
    fault: entry.fault,
    message: "",
    retryAfter: entry.retryAfter === 0 ? null : entry.retryAfter,
    status: entry.status,
    origin: "plue"
  })
  return `[fault=${entry.fault} code=${code}] ${copy.agent}`
}

/**
 * The tool result the chat model is handed.
 *
 * The machine facts come first, bracketed, so the model is TOLD the fault class
 * rather than inferring it — a client fetch that threw used to arrive as
 * `failed: Load failed`, and the model read that as the user's mistake. The
 * refusing party's own words follow, then the sentence for this fault. The
 * `failed:` prefix is load-bearing: the turn controller's act line keys off it.
 *
 * @since 1.0.0
 * @category constants
 */
export const agentRefusalText = (refusal: Refusal): string => {
  const facts = [
    `fault=${refusal.fault}`,
    ...(refusal.rawCode === null ? [] : [`code=${refusal.rawCode}`]),
    ...(refusal.status === null ? [] : [`status=${refusal.status}`]),
    ...(refusal.retryAfter === null ? [] : [`retry_after=${refusal.retryAfter}s`]),
    `origin=${refusal.origin}`
  ].join(" ")
  return `failed: [${facts}] ${refusal.message} — ${refusalCopy(refusal).agent}`
}
