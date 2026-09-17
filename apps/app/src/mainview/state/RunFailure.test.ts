import { expect, test } from "bun:test"
import { runFailure, runFailureOf } from "./RunFailure"
import { librarianFailureMessage } from "./LibrarianLaunch"

const INFRA = "Something on Smithers' side failed. Not your fault, and nothing your request could have changed."
/* One of the sentences flows/repository/triggers.ts refuses a registration with. */
const REFUSAL = 'Add a model to "nightly-lint" to schedule it.'
const VERDICT = `failed — invalid_receipt: ${REFUSAL.slice(0, 20)}`
const journal = (cause: string) => [{ sequence: 1, kind: "control.run.failed", runId: "run-1", occurredAt: 1, payload: { runId: "run-1", status: "failed", cause } }]

test("uncoded execution errors use infra copy and retain the complete raw detail", () => {
  const raw = "failed — Error: Error: git exited 1"
  expect(runFailure(raw)).toEqual({ fault: "infra", message: "Something on Smithers' side failed. Not your fault, and nothing your request could have changed.", detail: raw })
  expect(librarianFailureMessage("history", raw)).toBe(`Create Mythical history didn't start: ${runFailure(raw).message}`)
})

test("coded errors use the shared refusal table without interpreting raw prose", () => {
  const raw = JSON.stringify({ code: "no_capacity", message: "No slots" })
  const failure = runFailure(raw)
  expect(failure.fault).toBe("infra")
  expect(failure.message).toContain("@fucory")
  expect(failure.detail).toBe(raw)
  expect(runFailure().message).toContain("Not your fault")
})

test("only the registrar's own refusal is the person's input; every other flow's invalid_receipt stays Smithers'", () => {
  const cause = `invalid_receipt: ${REFUSAL}\n    at repository/trigger (flows/repository/triggers.ts:20)`
  expect(runFailureOf({ workflow: "repository/trigger", error: VERDICT, events: journal(cause) }))
    .toEqual({ fault: "user", message: REFUSAL, detail: `invalid_receipt: ${REFUSAL}` })
  for (const [workflow, engine] of [
    ["coding/request", "Native source creation returned an invalid receipt"],
    ["librarian/wiki", "Native main retention returned an invalid receipt"],
    ["repository/setup", "Setup output failed the shared response contract"]
  ]) {
    expect(runFailureOf({ workflow: workflow!, error: VERDICT, events: journal(`invalid_receipt: ${engine!}`) }))
      .toEqual({ fault: "infra", message: INFRA, detail: VERDICT })
  }
})

test("a registrar failure the registrar did not refuse keeps the verdict and the infra headline", () => {
  for (const cause of [
    "execution: The schedule registration did not complete; inspect the retained run",
    "Error: connect ECONNREFUSED 127.0.0.1:8788",
    "invalid_receipt:",
    "invalid_receipt: "
  ]) {
    expect(runFailureOf({ workflow: "repository/trigger", error: VERDICT, events: journal(cause) }))
      .toEqual({ fault: "infra", message: INFRA, detail: VERDICT })
  }
  expect(runFailureOf({ workflow: "repository/trigger", error: VERDICT, events: [] })).toEqual({ fault: "infra", message: INFRA, detail: VERDICT })
  expect(runFailureOf({ workflow: "repository/trigger", error: VERDICT })).toEqual({ fault: "infra", message: INFRA, detail: VERDICT })
  expect(runFailureOf({ workflow: "repository/trigger" })).toEqual({ fault: "infra", message: INFRA, detail: "" })
})
