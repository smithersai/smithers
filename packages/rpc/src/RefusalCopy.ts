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
 * The Cloudflare Worker's OWN refusals are the exception to "keyed by fault":
 * every one of its codes carries a written lead (WORKER_REFUSAL_COPY below),
 * because the fault alone does not separate the two infra failures a person
 * can hit. "Our fleet is full" and "this deployment is missing a secret" are
 * both `infra`, and only one of them is fixed by buying more of anything.
 *
 * @since 1.0.0
 */
import type { PlueFailureCode, PlueFault } from "./PlueFailureCodes.ts"
import { isWorkerFailureCode, refusalCode, refusalEntry } from "./Refusal.ts"
import type { Refusal } from "./Refusal.ts"
import type { WorkerFailureCode } from "./WorkerFailureCodes.ts"

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
 * What the app says about one of the Cloudflare Worker's own refusals.
 *
 * `lead` is REQUIRED here, unlike plue's sparse overrides above. plue's 95
 * codes share five faults and the fault's own sentence is usually the whole
 * truth; the Worker's refusals are the ones where it is not. Two of its codes
 * are `infra` — `deployment_not_configured` and `seam_not_configured` — and
 * neither is the failure INFRA_NOT_YOUR_FAULT describes: nothing is full,
 * something was never wired, and telling a reader to yell for more infra would
 * point them at the wrong problem and the wrong person. Requiring a lead per
 * code is what stops a new Worker code inheriting a sentence that is false
 * about it.
 *
 * @since 1.0.0
 * @category models
 */
export interface WorkerRefusalCopyRow {
  /** The line above the Worker's own words. Written for every code; never inherited. */
  readonly lead: string
  /** The sentence handed to the chat model, when the fault's own is not specific enough. */
  readonly agent?: string
  /** The ways out, when they differ from the fault's. */
  readonly doors?: ReadonlyArray<RefusalDoor>
}

/**
 * The copy for every code the Cloudflare Worker refuses with.
 *
 * `satisfies Record<WorkerFailureCode, WorkerRefusalCopyRow>` is the gate: a
 * code added to WorkerFailureCodes.ts with no row here does not compile, so no
 * Worker refusal can reach a person with a sentence nobody wrote for it.
 *
 * @since 1.0.0
 * @category constants
 */
export const WORKER_REFUSAL_COPY = {
  account_not_allowlisted: { lead: "This account isn't off the closed-alpha waitlist yet.", doors: [] },
  client_disconnected: { lead: "That request stopped before it finished — the page went away.", doors: ["retry"] },
  cloud_token_unavailable: {
    lead: "Smithers couldn't get a Cloud token for your account, so it never got as far as asking.",
    doors: ["retry"]
  },
  cross_origin_blocked: { lead: "Smithers only answers this from its own page.", doors: [] },
  /*
   * The refusal this whole file was extended for. It is `infra`, like a full
   * fleet, and it must NOT read like one: "we ran out" tells a reader that
   * somebody should buy more, when in fact a value on this deployment was
   * never set and buying more of anything changes nothing. The audience is
   * whoever deployed it, which is the part the sentence has to carry.
   */
  deployment_not_configured: {
    lead:
      "This deployment of Smithers isn't fully set up. Not your fault — and not something you can fix from here; whoever deployed it has to finish wiring it.",
    agent:
      "fault=infra: this DEPLOYMENT is missing configuration a seam needs — an unset secret, a missing binding, an upstream nobody filled in. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Say plainly that this deployment is misconfigured and that it takes whoever deployed it to fix. Do not retry it and do not suggest they change what they asked for.",
    doors: ["report"]
  },
  error_reports_throttled: {
    lead: "Smithers is already holding enough crash reports from here. Nothing you were doing is lost.",
    doors: []
  },
  feature_unavailable_here: { lead: "This build of Smithers doesn't do that.", doors: [] },
  gateway_proxy_removed: { lead: "That door was removed from Smithers.", doors: [] },
  method_not_allowed: { lead: "That address doesn't take that kind of request.", doors: [] },
  model_no_answer: {
    lead: "The model service took the turn and then said nothing at all. Nothing was charged.",
    doors: ["retry"]
  },
  model_rate_limited: {
    lead: "The model service is throttling this whole deployment — not your account. Nothing was charged.",
    agent:
      "fault=dependency: the model provider is rate-limiting THIS DEPLOYMENT, not the user's account and not their request. Nothing was charged. Say it is worth trying again shortly, and never suggest they change what they asked for.",
    doors: ["retry"]
  },
  procedure_not_relayed: { lead: "Smithers doesn't relay that call.", doors: [] },
  request_body_not_json: { lead: "Smithers couldn't read that request as JSON.", doors: ["retry"] },
  request_body_too_large: { lead: "That's more than this part of Smithers takes in one request.", doors: ["retry"] },
  request_body_unreadable: { lead: "That request ended before Smithers had all of it.", doors: ["retry"] },
  request_conflict: { lead: "That can't be done from the state things are in right now.", doors: ["retry"] },
  request_invalid: { lead: "Smithers can't do that as asked.", doors: ["retry"] },
  route_not_found: { lead: "There's nothing at that address.", doors: [] },
  /*
   * The other half of `deployment_not_configured`, at the status a seam that
   * is simply absent answers. Same audience, same "nothing is full", and the
   * same reason it must not borrow the capacity sentence.
   */
  seam_not_configured: {
    lead:
      "This deployment of Smithers doesn't have the piece that answers this. Not your fault — and not something you can switch on from here.",
    agent:
      "fault=infra: the seam this needs is ABSENT on this deployment (a local or stub stack, a preview without it). Not the user's fault and not their request's. Nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Say the deployment does not have this seam. Do not retry it.",
    doors: ["report"]
  },
  service_auth_required: {
    lead: "That door is for Smithers' own services, and the credential didn't match.",
    doors: []
  },
  service_temporarily_unavailable: {
    lead: "That part of Smithers couldn't answer just now. Not your fault.",
    agent:
      "fault=infra: one of Smithers' own seams is up but could not answer this request. Not the user's fault and not their request's. It is worth asking again shortly; do not suggest they change what they asked for.",
    doors: ["retry"]
  },
  session_expired: {
    lead: "That session has expired. Anything you already finished is still saved.",
    doors: ["sign-in", "retry"]
  },
  sign_in_required: { lead: "Smithers Cloud doesn't recognise this session.", doors: ["sign-in"] },
  storage_failed: {
    lead: "Smithers' own storage failed on that. Not your fault, and nothing you asked for caused it.",
    agent:
      "fault=infra: Smithers' own Durable Object storage failed. Not the user's fault, not their request's, and not an upstream's. Do not suggest they change what they asked for.",
    doors: ["retry", "report"]
  },
  tools_not_supported: { lead: "That part of Smithers answers in plain text and runs no tools.", doors: [] },
  turn_already_running: { lead: "That turn is already running.", doors: [] },
  turn_not_yours: { lead: "That turn belongs to a different account.", doors: [] },
  turn_rate_limited: {
    lead: "That's the turn budget for now — nothing is broken, and nothing was charged.",
    agent:
      "fault=wait: a turn budget is spent — the user's own, or this deployment's shared anonymous one; the message says which. Nothing is broken and nothing was charged. Do not re-run the turn in a loop and do not tell them to change what they asked for.",
    doors: ["retry"]
  },
  unexpected_failure: { lead: "That's a bug in Smithers, not something you did.", doors: ["retry", "report"] },
  upstream_malformed: {
    lead: "Something Smithers depends on answered in a shape Smithers couldn't use.",
    doors: ["retry"]
  },
  upstream_refused: { lead: "Something Smithers depends on refused that. Not your doing.", doors: ["retry"] },
  upstream_timeout: { lead: "Something Smithers depends on didn't answer in time.", doors: ["retry"] },
  upstream_unreachable: { lead: "Smithers couldn't reach something it depends on.", doors: ["retry"] }
} satisfies Record<WorkerFailureCode, WorkerRefusalCopyRow>

/** The fault's row with a Worker code's written lead, and its overrides where it states them. */
const workerRow = (base: RefusalCopyRow, row: WorkerRefusalCopyRow): RefusalCopyRow => ({
  lead: row.lead,
  agent: row.agent ?? base.agent,
  doors: row.doors ?? base.doors
})

/**
 * The copy for one refusal: its fault's row, with any per-code override applied.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalCopy = (refusal: Refusal): RefusalCopyRow => {
  const base = REFUSAL_COPY[refusal.fault]
  const row = refusal.code === null
    ? base
    : isWorkerFailureCode(refusal.code)
    ? workerRow(base, WORKER_REFUSAL_COPY[refusal.code])
    : ((override) => override === undefined ? base : { ...base, ...override })(BY_CODE[refusal.code])
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
 * message, looked up in the two closed registries — never inferred from the
 * English around it. A string with no code in that position gets no note, and
 * the model is left with the sentence rather than a guess dressed as a fact.
 *
 * Both vocabularies are read: a Worker refusal ("this deployment is not
 * configured") reaches the model through exactly the same string channel as a
 * plue one, and used to arrive with no verdict at all.
 *
 * @since 1.0.0
 * @category constants
 */
export const agentFaultNote = (text: string): string | null => {
  const code = refusalCode(LEADING_CODE.exec(text)?.[1])
  const entry = refusalEntry(code)
  if (code === null || entry === null) return null
  const copy = refusalCopy({
    code,
    rawCode: code,
    fault: entry.fault,
    message: "",
    retryAfter: entry.retryAfter === 0 ? null : entry.retryAfter,
    status: entry.status,
    origin: isWorkerFailureCode(code) ? "worker" : "plue"
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
