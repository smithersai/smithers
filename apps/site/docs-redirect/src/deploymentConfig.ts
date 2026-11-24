import * as Effect from "effect/Effect"
import { optionalHost, physicalName } from "../../infra/Deployment.ts"
import { DOCS_REDIRECTS } from "./docsRedirectMap.ts"

export const deployment = Effect.gen(function*() {
  const name = yield* physicalName("DOCS_REDIRECT_WORKER_NAME", "smithers-docs-redirect")
  const zone = yield* optionalHost("DOCS_REDIRECT_ZONE")
  return {
    name,
    main: "src/worker.ts",
    compatibility: { date: "2026-08-01", flags: ["nodejs_compat"] },
    workersDev: false,
    observability: { enabled: true },
    routes: zone === undefined ? [] : Array.from(DOCS_REDIRECTS.keys(), slug => ({ pattern: `${slug}.${zone}/*`, zoneName: zone })),
    env: { UNKNOWN_SLUGS: "off", ...(zone === undefined ? {} : { DOCS_REDIRECT_ZONE: zone }) }
  }
})
