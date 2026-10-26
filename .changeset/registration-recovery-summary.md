---
"@smthrs/engine-store": minor
"@smthrs/flows": patch
"@smthrs/platform-node": patch
---

An engine start logs registration recovery once, not once per registration. A browser engine registered hundreds of
flows per page load and wrote one Info `engine-store.registration.recovered` line for each, all relayed to telemetry.

- Each registration's recovery is now `engine-store.registration.flow.recovered` at Debug, with `smithers.flow` and
  `durationMs`.
- `EngineStore.Driver.reportRecovery` logs `engine-store.registration.recovered` at Info with `registrations`, how
  many registrations recovered since the last report, and `durationMs`, their total, and answers the same
  `EngineStore.Recovery`. A service that implements `Driver` itself adds the member.
- `@smthrs/flows` `Runtime.layer`, and so the browser and Cloudflare hosts, and the native hosts' `layerHost` report
  once registration finishes.
