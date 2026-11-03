import type { APIRequestContext } from "@playwright/test"

// Playwright's request errors carry a call log of the request's headers, the session cookie and any bearer token among
// them: a timed-out `request.get` against a deployment would print them into the console, the results and error-context.md.
// Every request context's errors are redacted before a test sees them (e2e/fixtures.ts, the deployment setup).

/** `text` with every cookie and authorization header's value replaced. */
export const redact = (text: string) => text.replace(/((?:set-)?cookie:\s*|authorization:\s*)[^\n\u001b]*/gi, "$1[redacted]")

/** An error with its message and stack redacted, in place. */
export const redactError = (error: unknown) => {
  if (error instanceof Error) {
    error.message = redact(error.message)
    if (error.stack !== undefined) error.stack = redact(error.stack)
  }
  return error
}

const patched = new WeakSet<object>()

/** Redacts the errors of every request context of `context`'s class, from now on: get, post and the rest call `fetch`. */
export const redactRequestErrors = (context: APIRequestContext) => {
  const prototype = Object.getPrototypeOf(context) as { fetch: (...args: Array<unknown>) => Promise<unknown> }
  if (patched.has(prototype)) return
  patched.add(prototype)
  const fetch = prototype.fetch
  prototype.fetch = async function (this: unknown, ...args: Array<unknown>) {
    try {
      return await fetch.apply(this, args)
    } catch (error) {
      throw redactError(error)
    }
  }
}
