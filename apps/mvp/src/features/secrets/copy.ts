import type { WriteFailure } from "./contract"

// What the Secrets page says (docs/features/secrets.md#the-secrets-page): the fewest words to act, in product words.

/** The page's heading, its `main`'s name, the list's name and the header's link. */
export const SECRETS = "Secrets"

/** The add form's name and its button. */
export const ADD_SECRET = "Add secret"

/** The fields. */
export const NAME = "Name"
export const VALUE = "Value"
export const HOSTS = "Hosts"

/** A row's actions, and their forms' buttons. */
export const ROTATE = "Rotate"
export const DELETE = "Delete"
export const SAVE = "Save"
export const DELETE_SECRET = "Delete secret"
export const CANCEL = "Cancel"
export const SAVING = "Saving"

/** The rotate form's name. */
export const rotateLabel = (secret: string): string => `Rotate ${secret}`

/** Shown for anyone below Member, or signed out. */
export const CANT_SEE = "You can't see this repository's secrets."

/** Why a write was refused, one phrase per refusal. */
export const FAILURE_COPY: Record<Exclude<WriteFailure, "exists">, string> = {
  authentication: "Sign in to change secrets",
  forbidden: "Only an Admin can change secrets",
  not_found: "Secrets aren't available for this repository",
  invalid: "The secret wasn't saved",
  invalid_name: "Names use A–Z, 0–9 and _, and don't start with a digit",
  invalid_hosts: "Hosts must be exact names like api.example.com",
  too_short: "Values are at least 8 characters",
  too_long: "Values are at most 16 KiB",
  control_character: "Values can't contain line breaks or control characters",
  malformed_text: "Values must be plain text",
  non_ascii: "Values must use ASCII characters",
  surrounding_space: "Values can't start or end with a space",
  too_large: "Values are at most 16 KiB",
  off: "Secrets are off on this deployment",
  unavailable: "Secrets are unavailable; try again",
}

/** A refusal's phrase; an Add of a name the list has names it. */
export const failureText = (failure: WriteFailure, secret: string): string =>
  failure === "exists" ? `${secret} exists. Rotate it instead.` : FAILURE_COPY[failure]

/** No whole answer came, so the write may or may not have landed. */
export const unknownText = (kind: "add" | "rotate" | "delete"): string =>
  kind === "delete"
    ? "Couldn't confirm the delete. Check the list before trying again."
    : "Couldn't confirm the save. Check the list before trying again."

/** ChatApi took the write, and the list hasn't shown it within the deadline. */
export const LATE = "It hasn't shown up yet."
