import { expect, test } from "./devices"
import { appHome, me, requires, target } from "./target"

// A persistent WebKit profile is a new browser context; it must explicitly inherit the configured test session.
test("a device inherits the configured signed-in session", async ({ devices }) => {
  requires("member")
  const person = await devices.openNew("Maya", appHome())
  const response = await person.page.request.get(new URL("/api/auth/session", person.page.url()).href)
  expect(response.status()).toBe(200)
  const session = await response.json() as { signedIn: boolean; personId?: string }
  expect(session.signedIn, "the real device has the configured session before a write is pressed").toBe(true)
  if (target === "deployment") expect(session.personId === me().personId, "the device has the configured person's session").toBe(true)
})
