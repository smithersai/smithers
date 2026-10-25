import { expect, test } from "vitest"
import { BROWSER_TELEMETRY } from "../../telemetry"
import { REFUSALS, SECRETS_TELEMETRY, splitHosts } from "./contract"
import { FAILURE_COPY, failureText, LATE, rotateLabel, unknownText } from "./copy"
import { formKey, type FormState, type SecretForm } from "./schema"
import { accessOf, awaiting, formOf, hostsText, landed, onItsWay, showsLink } from "./view"

// The Secrets page's pure rules (docs/features/secrets.md#the-secrets-page): who sees which controls, what a person typed
// as hosts, and the words for each failure.

test("an Admin of the repository writes, a Maintainer or Member reads, anyone else sees nothing; nothing shows until sign-in knows", () => {
  const signedIn = { status: "signed_in" }
  const on = (role: "admin" | "maintainer" | "member" | "guest" | null, own = true) => ({ role, own })
  expect(accessOf(undefined, on("admin"))).toBe("loading")
  expect(accessOf({ status: "loading" }, on("admin"))).toBe("loading")
  expect(accessOf({ status: "signed_out" }, on("admin"))).toBe("none")
  expect(accessOf({ status: "unreachable" }, on("admin"))).toBe("none")
  // Signed in, until ChatApi answers who the person is on the repository (decision 0079): unknown fails closed.
  expect(accessOf(signedIn, undefined)).toBe("none")
  expect(accessOf(signedIn, on("admin"))).toBe("write")
  expect(accessOf(signedIn, on("maintainer"))).toBe("read")
  expect(accessOf(signedIn, on("member"))).toBe("read")
  expect(accessOf(signedIn, on("guest"))).toBe("none")
  expect(accessOf(signedIn, on(null))).toBe("none")
  // Secrets serve the deployment's own repository alone: an Admin elsewhere sees nothing.
  expect(accessOf(signedIn, on("admin", false))).toBe("none")
  expect((["loading", "none", "read", "write"] as const).map(showsLink)).toEqual([false, false, true, true])
})

test("hosts split on commas, spaces and line breaks; a row's hosts fill its form one per line", () => {
  expect(splitHosts(" api.stripe.com,files.stripe.com\n\nuploads.stripe.com , ")).toEqual([
    "api.stripe.com",
    "files.stripe.com",
    "uploads.stripe.com",
  ])
  expect(splitHosts("")).toEqual([])
  expect(hostsText(["a.com", "b.com"])).toBe("a.com\nb.com")
})

const form = (fields: Partial<SecretForm> = {}): SecretForm => ({
  id: "github/o/r|add",
  repoId: "github/o/r",
  kind: "add",
  secret: "K",
  state: "confirming",
  failure: null,
  before: null,
  saved: 0,
  ...fields,
})

test("each repository's forms have their own rows; Add's is one per repository", () => {
  expect([formKey("github/o/r", "add", "IGNORED"), formKey("github/o/r", "rotate", "K"), formKey("github/o/s", "delete", "K")])
    .toEqual(["github/o/r|add", "github/o/r|rotate:K", "github/o/s|delete:K"])
  const forms = [form()]
  expect(formOf(forms, "github/o/r|add")).toBe(forms[0])
  expect(formOf(forms, "github/o/s|add")).toBeUndefined()
  expect(rotateLabel("STRIPE_KEY")).toBe("Rotate STRIPE_KEY")
})

test("every refusal has its own short phrase; an unknown outcome says to check the list", () => {
  expect(Object.keys(FAILURE_COPY).sort()).toEqual([...REFUSALS].sort())
  expect(failureText("invalid_hosts", "K")).toBe("Hosts must be exact names like api.example.com")
  expect(failureText("off", "K")).toBe("Secrets are off on this deployment")
  expect(failureText("exists", "STRIPE_KEY")).toBe("STRIPE_KEY exists. Rotate it instead.")
  expect(unknownText("add")).toBe("Couldn't confirm the save. Check the list before trying again.")
  expect(unknownText("rotate")).toBe(unknownText("add"))
  expect(unknownText("delete")).toBe("Couldn't confirm the delete. Check the list before trying again.")
  expect(LATE).toBe("It hasn't shown up yet.")
})

test("a write is on its way while sent or taken; the list may still show it landing until it is done or refused", () => {
  const states: ReadonlyArray<FormState> = ["sending", "confirming", "late", "done", "failed", "unknown"]
  expect(states.map((state) => onItsWay(form({ state })))).toEqual([true, true, false, false, false, false])
  expect(states.map((state) => awaiting(form({ state })))).toEqual([false, true, true, false, false, true])
})

test("a put landed once its row appears or its updatedAt changes; a delete once its row is gone", () => {
  const row = { name: "K", updatedAt: "2026-10-21T10:00:00.000Z" }
  const later = { name: "K", updatedAt: "2026-10-21T10:00:01.000Z" }
  const other = { name: "L", updatedAt: "2026-10-21T10:00:01.000Z" }
  expect(landed(form(), [])).toBe(false)
  expect(landed(form(), [other])).toBe(false)
  expect(landed(form(), [row])).toBe(true)
  expect(landed(form({ kind: "rotate", before: row.updatedAt }), [row])).toBe(false)
  expect(landed(form({ kind: "rotate", before: row.updatedAt }), [later])).toBe(true)
  expect(landed(form({ kind: "delete" }), [row])).toBe(false)
  expect(landed(form({ kind: "delete" }), [other])).toBe(true)
})

test("the relay keeps the page's records and fields", () => {
  expect(BROWSER_TELEMETRY.records).toEqual(expect.arrayContaining([...SECRETS_TELEMETRY.records]))
  expect(BROWSER_TELEMETRY.fields).toEqual(expect.arrayContaining([...SECRETS_TELEMETRY.fields, "name"]))
})
