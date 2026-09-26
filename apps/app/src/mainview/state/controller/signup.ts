/*
 * The signup onboarding's controller half (state/Signup.ts). Every act is a
 * merge onto the session's signup row; the one sign-in door is GitHub
 * (auth.sign-in), whose identity answer advances the row (signupAfterIdentity).
 */
import type { Signup } from "../Signup"
import { accountSlug, initialSignup, SIGNUP_QUESTIONS, validAccountName } from "../Signup"
import type { ControllerContext } from "./context"

export interface SignupController {
  readonly signupChange: (patch: Partial<Signup>) => void
  readonly signupSet: (field: string, value: string) => void
  readonly signupAccount: () => string | void
  readonly signupAnswer: (value: string) => string | void
  readonly signupNext: () => string | void
  readonly signupBack: () => void
  readonly signupRepo: (repo: string) => void
  readonly signupFinish: () => void
}

export const createSignupController = (ctx: ControllerContext): SignupController => {
  const { store } = ctx
  const current = (): Signup => store.session().signup ?? initialSignup()
  const change: SignupController["signupChange"] = (patch) => { store.dispatch({ type: "signup.changed", actor: ctx.commandActor, patch }) }

  const signupSet: SignupController["signupSet"] = (field, value) => {
    change({ draft: { ...current().draft, [field]: value } })
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

  return { signupChange: change, signupSet, signupAccount, signupAnswer, signupNext, signupBack, signupRepo, signupFinish }
}
