import type { ConsoleMessage, Page } from "@playwright/test"

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

/**
 * Records `page`'s console into `log`, each line where it came, as `<prefix><type>: <text>`: `text()` at once, so the
 * order and the time are the message's, then the whole text once its values are read.
 */
export const recordConsole = (page: Page, log: Array<string>, prefix: () => string = () => "") => {
  page.on("console", (message) => {
    const head = `${prefix()}${message.type()}: `
    const index = log.push(`${head}${message.text()}`) - 1
    void wholeText(message).then((text) => {
      log[index] = `${head}${text}`
    })
  })
}
