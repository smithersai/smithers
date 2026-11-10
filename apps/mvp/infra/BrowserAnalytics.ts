// Browser telemetry is owned by the app. Disable the zone-injected Web Analytics beacon, which posts to an
// edge-owned endpoint outside the Workers and can fail before the app paints (docs/infrastructure.md#domain).
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Output from "alchemy/Output"
import { Config, Effect, Option } from "effect"
import type { AppHost } from "./Domain.vibe"

/** Keep the custom domain free of an unmanaged browser beacon; dev and workers.dev declare no analytics resource. */
export const BrowserAnalytics = (domain: Option.Option<AppHost>) => Effect.gen(function*() {
  if (Option.isNone(domain)) return
  if (!(yield* Config.Boolean("MANAGE_WEB_ANALYTICS").pipe(Config.withDefault(false)))) return
  const hostname = domain.value.name
  const zoneTag = Output.fromEffect(Effect.gen(function*() {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment
    return yield* Cloudflare.Zone.resolveZoneId({ accountId, zone: undefined, hostname }).pipe(Effect.orDie)
  }))
  yield* Cloudflare.Rum.Site("BrowserAnalytics", { zoneTag, autoInstall: false })
})
