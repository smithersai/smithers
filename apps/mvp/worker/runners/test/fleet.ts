// Real fleet shape routes over the file's Postgres schema and the compose Electric.
import { ConfigProvider, Effect, type Layer, Metric, Tracer } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import * as TestDatabase from "../../../db/TestDatabase.ts"
import type * as Actor from "../../Actor.ts"
import { localRoles } from "../../feeds/test/harness.ts"
import type * as RepoRoles from "../../github/RepoRoles.ts"
import { signedIn, signedOut, type testFile } from "../../test/harness.ts"
import * as FleetApi from "../FleetApi.ts"

export const fleetHarness = async (runtime: ReturnType<typeof testFile>, options: {
  readonly actor?: Actor.Actor
  readonly sessions?: Layer.Layer<Actor.Sessions>
  readonly roles?: RepoRoles.RepoRoles<never>
  readonly onElectric?: (url: URL) => void
} = {}) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const electric: Array<URL> = []
  const toElectric: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    electric.push(new URL(url))
    options.onElectric?.(url)
    const table = url.searchParams.get("table")
    if (table !== null) url.searchParams.set("table", `${scratch.name}.${table}`)
    return globalThis.fetch(url, init)
  }
  const config = ConfigProvider.fromUnknown({ ELECTRIC_URL: await runtime.runPromise(TestDatabase.electricUrl) })
  const registry: Metric.MetricRegistry = new Map()
  const roles = options.roles ?? await runtime.runPromise(localRoles(scratch.database))
  const api = await runtime.runPromise(FleetApi.make(roles).pipe(Effect.provideService(ConfigProvider.ConfigProvider, config)))
  const sessions = options.sessions ?? (options.actor === undefined ? signedOut : signedIn(options.actor))
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({ span(options) { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
  const handler = HttpEffect.toWebHandler(api.fetch.pipe(
    Effect.provide(sessions),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, toElectric),
    Effect.provideService(Metric.MetricRegistry, registry),
    Effect.provideService(Tracer.Tracer, tracer),
  ))
  const origin = "http://fleet.test"
  const fetch: typeof globalThis.fetch = (input, init) => handler(input instanceof Request
    ? new Request(input, init)
    : new Request(new URL(String(input), origin), init))
  return {
    origin, fetch, electric, spans,
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry))).count,
  }
}
