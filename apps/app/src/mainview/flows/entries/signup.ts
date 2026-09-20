/*
 * The `signup` flows: the onboarding a visitor without an account walks in
 * the chat log (state/Signup.ts). Every button on those cards is one of these
 * doors; the GitHub door is auth.sign-in itself. All hidden: they belong to
 * the cards, never to the catalog.
 */
import { Schema } from "effect"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"
import { flow, NoPayload } from "./Declare"

export const namespace: Namespace = { id: "signup", label: "Sign up", summary: "Create a Smithers account" }

export const SIGNUP_GOOGLE_USER_ONLY_REASON = "the Google OAuth redirect is the human's browser gesture, like auth.sign-in"

export const signupFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "signup.set", hidden: true, summary: "Type into a signup field", args: "<field> [value]",
    input: Schema.Struct({ field: Schema.String, value: Schema.String }), handler: ({ field, value }) => actions.signupSet(field, value) }),
  flow({ name: "signup.google", hidden: true, summary: "Continue with Google", runtime: ["identity"], userOnly: true,
    userOnlyReason: SIGNUP_GOOGLE_USER_ONLY_REASON, input: NoPayload, handler: () => actions.signupGoogle() }),
  flow({ name: "signup.email", hidden: true, summary: "Send a sign-in code to a company email", runtime: ["identity"], args: "<email>",
    input: Schema.Struct({ email: Schema.String }), handler: ({ email }) => actions.signupEmail(email) }),
  flow({ name: "signup.verify", hidden: true, summary: "Verify the emailed code", runtime: ["identity"], args: "<code>",
    input: Schema.Struct({ code: Schema.String }), handler: ({ code }) => actions.signupVerify(code) }),
  flow({ name: "signup.account", hidden: true, summary: "Finish creating the account", input: NoPayload, handler: () => actions.signupAccount() }),
  flow({ name: "signup.answer", hidden: true, summary: "Answer the current signup question", args: "<value>",
    input: Schema.Struct({ value: Schema.String }), handler: ({ value }) => actions.signupAnswer(value) }),
  flow({ name: "signup.next", hidden: true, summary: "Continue past the current question", input: NoPayload, handler: () => actions.signupNext() }),
  flow({ name: "signup.back", hidden: true, summary: "Return to the previous question", input: NoPayload, handler: () => actions.signupBack() }),
  flow({ name: "signup.repo", hidden: true, summary: "Choose the repository to connect", args: "<owner/repo|new>",
    input: Schema.Struct({ repo: Schema.String }), handler: ({ repo }) => actions.signupRepo(repo) }),
  flow({ name: "signup.finish", hidden: true, summary: "Start automating", input: NoPayload, handler: () => actions.signupFinish() })
]
