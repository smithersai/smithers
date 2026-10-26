import type { ConsoleMessage, Page } from "@playwright/test"
import type { Observation } from "./problems"

// The browser's console, whole, for each test's browser log (e2e/fixtures.ts, e2e/devices.ts). Playwright's
// `ConsoleMessage.text()` renders an object argument as Chrome's preview, which keeps its first five properties and
// drops the rest without a mark, in the page and its workers alike. A record's later fields never reached the log: on
// 2026-10-25 the engine worker's `sandbox.call` logged `outcome: done` and its `callId`, the log kept
// `{runId, stepKey, attempt, tier, tool}`, and a settled result step's attempt 8 was read as the agent retrying a call
// it never got. So each object argument is written out from its value.

/** One console line from its arguments' values: a string as itself, anything else as JSON. */
export const consoleLine = (values: ReadonlyArray<unknown>): string =>
  values.map((value) => (typeof value === "string" ? value : JSON.stringify(value) ?? String(value))).join(" ")

/**
 * A console message's whole line from its `text()` and its arguments' values: the values written out, or `text` where
 * it is already whole (no object argument), where the first argument formats the rest (`%s`, `%o`, `%c`), or where the
 * values couldn't be read (`undefined`: a worker that has gone, a value JSON can't hold).
 */
export const wholeLine = (text: string, values: ReadonlyArray<unknown> | undefined): string => {
  if (values === undefined || !values.some((value) => typeof value === "object" && value !== null)) return text
  if (typeof values[0] === "string" && /%[sdifoOc]/.test(values[0])) return text
  return consoleLine(values)
}

/** A console message's whole text (`wholeLine`), its arguments read from the browser. */
export const wholeText = (message: ConsoleMessage): Promise<string> =>
  Promise.all(message.args().map((arg) => arg.jsonValue())).then(
    (values: ReadonlyArray<unknown>) => wholeLine(message.text(), values),
    () => message.text(),
  )

/** Where a page's errors go to be checked: e2e/watch.ts's Problems. */
export type ErrorSink = { readonly note: (observation: Observation) => void }

/**
 * Records `page`'s console into `log`, each line where it came, as `<prefix><type>: <text>`: `text()` at once, so the
 * order and the time are the message's, then the whole text once its values are read. With `errors`, each console
 * error (with the URL it names) and each uncaught page error also goes there, at once, for the test's check
 * (e2e/problems.ts); without `log`, only that.
 */
export const recordConsole = (page: Page, log: Array<string> | undefined, prefix: () => string = () => "", errors?: ErrorSink) => {
  page.on("console", (message) => {
    if (message.type() === "error") errors?.note({ kind: "console", text: message.text(), url: message.location().url || undefined })
    if (log === undefined) return
    const head = `${prefix()}${message.type()}: `
    const index = log.push(`${head}${message.text()}`) - 1
    void wholeText(message).then((text) => {
      log[index] = `${head}${text}`
    })
  })
  if (errors !== undefined) page.on("pageerror", (error) => errors.note({ kind: "page", text: error.message }))
}
