import { mayAsk } from "../auth/contract"
import type { RepoAnswer } from "../auth/viewer"
import { MEMBERS_CLONE, SIGN_IN_TO_CLONE } from "./contract"
import type { Header } from "./view"

/** Clone spends this repository's budget: its role answer, never the session's role, admits the button. */
export const cloneHeaderOf = (header: Header, signedIn: boolean | null, answer: (RepoAnswer & { readonly failure?: string }) | undefined): Header => {
  if (header.kind !== "clone" && header.kind !== "refused") return header
  if (signedIn === false) return { kind: "sign_in", text: SIGN_IN_TO_CLONE }
  if (signedIn !== true || answer === undefined) return { kind: "unknown" }
  if (answer.failure !== undefined) return header.kind === "refused" ? { ...header, retry: false } : { kind: "unknown" }
  return mayAsk(answer.role) ? header : { kind: "refused", text: MEMBERS_CLONE, retry: false }
}
