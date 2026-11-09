// Discover the real Alchemy declaration without invoking provider lifecycle methods.
import * as Output from "alchemy/Output"
import { Stack } from "alchemy/Stack"
import { Effect, Option } from "effect"
import { expect, test } from "vitest"
import { BrowserAnalytics } from "./BrowserAnalytics.ts"
import type { AppHost } from "./Domain.ts"

const discover = async (domain: Option.Option<AppHost>) => {
  const stack = Stack.of({ name: "browser-analytics", stage: "test", resources: {}, bindings: {}, actions: {} })
  await Effect.runPromise(BrowserAnalytics(domain).pipe(
    Effect.provideService(Stack, stack),
    Effect.asVoid,
    Effect.scoped,
  ) as unknown as Effect.Effect<void>)
  return stack.resources
}

test("custom domains disable the edge-injected beacon through an Alchemy Web Analytics site", async () => {
  const resources = await discover(Option.some({ name: "app.example.com", redirects: [], aliases: [] }))
  expect(Object.keys(resources)).toEqual(["BrowserAnalytics"])
  const setting = resources["BrowserAnalytics"]!
  expect(setting.Type).toBe("Cloudflare.Rum.Site")
  expect((setting.Props as { autoInstall: unknown }).autoInstall).toBe(false)
  expect(Output.isOutput((setting.Props as { zoneTag: unknown }).zoneTag)).toBe(true)
})

test("development and workers.dev declare no analytics site", async () => {
  expect(await discover(Option.none())).toEqual({})
})
