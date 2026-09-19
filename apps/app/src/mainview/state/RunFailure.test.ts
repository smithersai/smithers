import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { RECEIPT_CODES, runFailure, runFailureOf, SETUP_REFUSAL_COPY, SETUP_REFUSALS, setupFailureSentence } from "./RunFailure"
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

/* The canary's own trial refusal, verbatim: `Create test issue` pressed before the evals passed
 * (.artifacts/mvp-canary-walk-20260917/B-18-state-trial-terminal.json, receipt run-3). */
const TRIAL = "Run evals for this exact candidate before continuing"
const TRIAL_VERDICT = `failed — invalid_receipt: ${TRIAL}`
const setupCause = (sentence: string) => journal(`invalid_receipt: ${sentence}\n    at repository/Setup (flows/repository/receipts.ts:109)`)

test("a setup refusal the person must answer is the person's, headline and all", () => {
  expect(runFailureOf({ workflow: "repository/setup", error: TRIAL_VERDICT, events: setupCause(TRIAL) }))
    .toEqual({ fault: "user", message: TRIAL, detail: `invalid_receipt: ${TRIAL}` })
  for (const sentence of [
    "Required evaluation cases have not passed with evidence",
    "Repository source changed after the live trial; test the candidate again",
    "Automatic replies are currently available for native issue handling only; choose draft replies"
  ]) {
    expect(runFailureOf({ workflow: "repository/setup", error: TRIAL_VERDICT, events: setupCause(sentence) }))
      .toEqual({ fault: "user", message: sentence, detail: `invalid_receipt: ${sentence}` })
  }
})

test("a setup failure the person cannot act on stays Smithers', and no other flow reads the table", () => {
  for (const engine of [
    "Setup output failed the shared response contract",
    "Repository setup needs its approved Control entry",
    "The receipt has no retained native owner",
    "Setup belongs to a different repository or workspace"
  ]) {
    expect(runFailureOf({ workflow: "repository/setup", error: TRIAL_VERDICT, events: setupCause(engine) }))
      .toEqual({ fault: "infra", message: INFRA, detail: TRIAL_VERDICT })
  }
  for (const workflow of ["coding/request", "librarian/wiki", "repository-jobs/issues", "repository/Setup"]) {
    expect(runFailureOf({ workflow, error: TRIAL_VERDICT, events: setupCause(TRIAL) }))
      .toEqual({ fault: "infra", message: INFRA, detail: TRIAL_VERDICT })
  }
  expect(runFailureOf({ workflow: "repository/setup", error: TRIAL_VERDICT, events: journal(`execution: ${TRIAL}`) }))
    .toEqual({ fault: "infra", message: INFRA, detail: TRIAL_VERDICT })
})

test("every sentence in the table is one the setup flows still emit, in the file that emits it", () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../../../../flows/repository/${file}`, import.meta.url)), "utf8")
  const source = ["setup.ts", "activation.ts"].map(read).join("\n")
  /* The two the host builds from one template; the rest it writes out. */
  expect(read("receipts.ts")).toContain('invalid(`Run ${operation === "evaluate" ? "evals" : "the live trial"} for this exact candidate before continuing`)')
  for (const sentence of SETUP_REFUSALS) {
    if (sentence.endsWith("for this exact candidate before continuing")) continue
    expect(source).toContain(`invalid("${sentence}")`)
  }
})

/*
 * The canary's own retry, verbatim (.artifacts/mvp-canary-walk-20260917/
 * W1-g-discard-and-retry.json `L76-issuesAfterRetry`): the issues card's
 * settled failure read `failed — invalid_receipt: Setup input must match the
 * reviewed candidate digest` — a run status and an engine code, shown to a
 * person. A settled verdict is `<phase> — <code>: <sentence>`; every code the
 * setup bridge can put there is answered, so none of them reaches a card as
 * itself.
 */
const RETRY_VERDICT = "failed — invalid_receipt: Setup input must match the reviewed candidate digest"

test("a settled verdict never reaches a person as its phase and code", () => {
  expect(setupFailureSentence(RETRY_VERDICT)).toBe("This setup changed after it was reviewed. Test this draft again, then apply it.")
  expect(setupFailureSentence("failed — invalid_receipt: Run evals for this exact candidate before continuing"))
    .toBe("Run evals for this exact candidate before continuing")
  expect(setupFailureSentence("failed — invalid_receipt: Setup output failed the shared response contract")).toBe(INFRA)
  /* An uncoded host sentence is the host's own and stays exactly as written. */
  expect(setupFailureSentence("AI check Documentation edits preserve existing content has no completed in-scope trial result; test a change that exercises it")).toBeUndefined()
  expect(setupFailureSentence(undefined)).toBeUndefined()
  for (const code of RECEIPT_CODES) {
    const sentence = setupFailureSentence(`failed — ${code}: Something the engine wrote`)
    expect(sentence).toBeString()
    expect(sentence).not.toContain(code)
    expect(sentence).not.toContain("failed — ")
  }
  /* A code this build does not know is still never printed at a person. */
  expect(setupFailureSentence("failed — brand_new_code: Something the engine wrote")).toBe(INFRA)
})

test("every receipt code the setup flows can raise is answered here", () => {
  const schema = readFileSync(fileURLToPath(new URL("../../../../../flows/coding/schema.ts", import.meta.url)), "utf8")
  const declared = /export class CodingError[\s\S]*?code: Schema\.Literals\(\[([\s\S]*?)\]\)/.exec(schema)?.[1] ?? ""
  const codes = [...declared.matchAll(/"([a-z_]+)"/g)].map((match) => match[1])
  expect(codes.length).toBeGreaterThan(0)
  const answered: ReadonlyArray<string> = RECEIPT_CODES
  expect([...answered].sort()).toEqual(codes.sort())
})

test("the sentences the app words itself are ones the setup flows still emit", () => {
  const setup = readFileSync(fileURLToPath(new URL("../../../../../flows/repository/setup.ts", import.meta.url)), "utf8")
  for (const sentence of SETUP_REFUSAL_COPY.keys()) {
    expect(SETUP_REFUSALS.has(sentence)).toBe(true)
    expect(setup).toContain(`invalid("${sentence}")`)
  }
})
