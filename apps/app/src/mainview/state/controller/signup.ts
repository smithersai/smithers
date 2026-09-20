/*
 * The signup onboarding's controller half (state/Signup.ts). Every act is a
 * merge onto the session's signup row; the two doors that leave the page
 * (Google) or need a mail sent (email) call the identity host and state a
 * typed failure when it has no such door yet. Nothing here is answered
 * from a guess: a host without Google or email sign-in says so, and the
 * person keeps the GitHub door.
 */
import type { Signup } from "../Signup"
import { accountSlug, initialSignup, SIGNUP_QUESTIONS, validAccountName } from "../Signup"
import type { ControllerContext } from "./context"

export const SIGNUP_GOOGLE_START_PATH = "/api/auth/google/start"
export const SIGNUP_EMAIL_START_PATH = "/api/auth/email/start"
export const SIGNUP_EMAIL_VERIFY_PATH = "/api/auth/email/verify"

/** The host's own refusal, in the fault vocabulary AGENTS.md asks for: infra, never the person. */
export const SIGNUP_DOOR_UNAVAILABLE = "not available on this host yet; not your fault. Continue with GitHub, or yell at @fucory for more infra."

export interface SignupController {
  readonly signupChange: (patch: Partial<Signup>) => void
  readonly signupSet: (field: string, value: string) => void
  readonly signupGoogle: () => Promise<string | void>
  readonly signupEmail: (email: string) => Promise<string | void>
  readonly signupVerify: (code: string) => Promise<string | void>
  readonly signupAccount: () => string | void
  readonly signupAnswer: (value: string) => string | void
  readonly signupNext: () => string | void
  readonly signupBack: () => void
  readonly signupRepo: (repo: string) => void
  readonly signupFinish: () => void
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const createSignupController = (ctx: ControllerContext): SignupController => {
  const { store } = ctx
  const current = (): Signup => store.session().signup ?? initialSignup()
  const change: SignupController["signupChange"] = (patch) => { store.dispatch({ type: "signup.changed", actor: ctx.commandActor, patch }) }

  const signupSet: SignupController["signupSet"] = (field, value) => {
    change({ draft: { ...current().draft, [field]: value } })
  }

  /** One POST to an identity door; a host without it answers 404 or 405, which is the typed "not here yet". */
  const door = async (key: string, title: string, path: string, body: unknown): Promise<{ ok: true; body: unknown } | { ok: false; refusal: string }> => {
    const outcome = await ctx.withToast(key, title, "Done", async () => {
      const response = await ctx.boundedFetch(`${ctx.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      if (response.status === 404 || response.status === 405) return `${title}: ${SIGNUP_DOOR_UNAVAILABLE}`
      if (!response.ok) return await ctx.errorMessageOf(response, `${title} failed; not your fault.`)
      return { body: await response.json().catch(() => null) as unknown }
    })
    return typeof outcome === "string" ? { ok: false, refusal: outcome } : { ok: true, body: outcome.body }
  }

  const signupGoogle: SignupController["signupGoogle"] = async () => {
    const answer = await door("signup.google", "Google sign-in", SIGNUP_GOOGLE_START_PATH, {})
    if (!answer.ok) return answer.refusal
    const url = typeof answer.body === "object" && answer.body !== null && typeof (answer.body as { url?: unknown }).url === "string" ? (answer.body as { url: string }).url : null
    if (url === null) return "Google sign-in: the host gave no redirect; not your fault."
    change({ door: "google" })
    if (typeof window !== "undefined") window.location.assign(url)
  }

  const signupEmail: SignupController["signupEmail"] = async (email) => {
    const address = email.trim()
    if (!EMAIL.test(address)) return "Type a company email like you@company.com."
    const answer = await door("signup.email", "Email sign-in", SIGNUP_EMAIL_START_PATH, { email: address })
    if (!answer.ok) return answer.refusal
    change({ stage: "verify", door: "email", email: address, draft: { ...current().draft, code: "" } })
  }

  const signupVerify: SignupController["signupVerify"] = async (code) => {
    const digits = code.replace(/\D/g, "")
    if (digits.length !== 6) return "Type the 6-digit code from the email."
    const signup = current()
    const answer = await door("signup.verify", "Code check", SIGNUP_EMAIL_VERIFY_PATH, { email: signup.email, code: digits })
    if (!answer.ok) return answer.refusal
    change({ stage: "account", account: signup.account ?? accountSlug(signup.email?.split("@")[0] ?? "") })
  }

  const signupAccount: SignupController["signupAccount"] = () => {
    const signup = current()
    const name = (signup.draft.name ?? signup.name ?? "").trim()
    const account = accountSlug(signup.draft.account ?? signup.account ?? "")
    if (name === "") return "Type your full name."
    if (!validAccountName(account)) return "An account name is 2–39 lowercase letters, digits or hyphens."
    change({ stage: "poll", name, account, question: 0 })
  }

  const advance = (signup: Signup): Partial<Signup> => signup.question + 1 < SIGNUP_QUESTIONS.length ? { question: signup.question + 1 } : { stage: "ready" }

  const signupAnswer: SignupController["signupAnswer"] = (value) => {
    const signup = current()
    const question = SIGNUP_QUESTIONS[signup.question]
    if (signup.stage !== "poll" || question === undefined) return "No question is open."
    if (question.kind === "single") {
      if (!question.options.includes(value)) return `Choose one of: ${question.options.join(", ")}.`
      change({ answers: { ...signup.answers, [question.id]: value }, ...advance(signup) })
      return
    }
    if (question.kind === "multi") {
      if (!question.options.includes(value)) return `Choose any of: ${question.options.join(", ")}.`
      const chosen = new Set([signup.answers[question.id] ?? []].flat())
      chosen.has(value) ? chosen.delete(value) : chosen.add(value)
      change({ answers: { ...signup.answers, [question.id]: [...chosen] } })
      return
    }
    if (question.kind === "free") { change({ answers: { ...signup.answers, [question.id]: value.trim() }, ...advance(signup) }); return }
    return "Choose a repository with signup.repo."
  }

  const signupNext: SignupController["signupNext"] = () => {
    const signup = current()
    const question = SIGNUP_QUESTIONS[signup.question]
    if (signup.stage !== "poll" || question === undefined) return "No question is open."
    const answered = signup.answers[question.id]
    if (question.required && (answered === undefined || answered.length === 0)) return "This one needs an answer."
    if (question.kind === "free" && (signup.draft.more ?? "").trim() !== "") { change({ answers: { ...signup.answers, more: signup.draft.more!.trim() }, ...advance(signup) }); return }
    change(advance(signup))
  }

  const signupBack: SignupController["signupBack"] = () => {
    const signup = current()
    if (signup.stage === "poll" && signup.question > 0) change({ question: signup.question - 1 })
  }

  const signupRepo: SignupController["signupRepo"] = (repo) => {
    const signup = current()
    change({ repo: repo.trim(), answers: { ...signup.answers, repo: repo.trim() }, ...advance(signup) })
  }

  const signupFinish: SignupController["signupFinish"] = () => { change({ stage: "done" }) }

  return { signupChange: change, signupSet, signupGoogle, signupEmail, signupVerify, signupAccount, signupAnswer, signupNext, signupBack, signupRepo, signupFinish }
}
