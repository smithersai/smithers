/** Private staged /usr/local/bin/smithers-coding-host entry for an owning Plue workspace. */
import { Effect, Layer } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { packageVersion } from "../../packages/smithers/src/Version.ts"
import { layer } from "./host.ts"
import * as Landing from "./landing.ts"
import { load as loadLanding } from "./landing-config.ts"
import { loadProject } from "./project-config.ts"
import type * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"

const parsed = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
  root: { type: "string" }, host: { type: "string", default: Serve.defaultBind.host },
  port: { type: "string", default: String(Serve.defaultBind.port) }, listen: { type: "boolean", default: false },
  credential: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }
} })
if (parsed.values.version) {
  process.stdout.write(`${packageVersion}\n`)
} else if (parsed.values.help) {
  process.stdout.write("smithers-coding-host serve --root <workspace> --host <host> --port <port> --listen\n" +
    "Requires SMITHERS_GATEWAY_ID and SMITHERS_CODING_IMPLEMENT_MODEL; SMITHERS_API_KEY authenticates the existing gateway.\n" +
    "SMITHERS_CODING_PROJECT explicitly selects project JSON for the prompt route.\n" +
    "Optional SMITHERS_CODING_PLAN_MODEL, SMITHERS_CODING_POC_MODEL and SMITHERS_CODING_WIKI_MODEL select provider:model roles.\n" +
    "The provisioned SMITHERS_JJHUB_TOKEN and SMITHERS_JJHUB_API_URL enable coding/vibe; the token is consumed before any tool starts.\n")
} else {
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "serve") throw new Error("This configured workspace entry accepts the existing serve command")
  const root = resolve(parsed.values.root ?? process.cwd())
  const port = Number(parsed.values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer from 0 to 65535")
  const bind: Serve.Bind = { host: parsed.values.host, port, listen: parsed.values.listen,
    credential: parsed.values.credential ?? process.env.SMITHERS_API_KEY }
  const refusal = Serve.refuse(bind)
  if (refusal) throw refusal
  const options = { repositoryPath: root, credential: bind.credential, gatewayId: process.env.SMITHERS_GATEWAY_ID ?? "",
    implementationModel: process.env.SMITHERS_CODING_IMPLEMENT_MODEL ?? "",
    ...(process.env.SMITHERS_CODING_PLAN_MODEL === undefined ? {} : { planningModel: process.env.SMITHERS_CODING_PLAN_MODEL }),
    ...(process.env.SMITHERS_CODING_POC_MODEL === undefined ? {} : { pocModel: process.env.SMITHERS_CODING_POC_MODEL }),
    ...(process.env.SMITHERS_CODING_WIKI_MODEL === undefined ? {} : { wikiModel: process.env.SMITHERS_CODING_WIKI_MODEL }),
    ...(process.env.PATH === undefined ? {} : { checkEnvironment: { PATH: process.env.PATH } }) }
  // The reserved repository credential leaves process.env here, before the
  // host, model seats or any approved shell tool can inherit it.
  const run = (platform: NativeControl.Platform, http: Layer.Layer<HttpClient.HttpClient>) =>
    Effect.all([loadProject(root, process.env.SMITHERS_CODING_PROJECT), loadLanding(root, process.env)]).pipe(
      Effect.flatMap(([planning, landing]) => Serve.host(bind, root).pipe(Effect.provide(layer(platform, {
        ...options, ...(planning === undefined ? {} : { planning }),
        ...(landing === undefined ? {} : { landing: Landing.layer(landing).pipe(Layer.provide(http), Layer.orDie) })
      })))),
      Effect.provide(platform.host)
    )
  // Only the concrete platform boundary is dynamic. Policy, durable stores and
  // coding registration above are the same on Bun and Node.
  if ("Bun" in globalThis) {
    const [{ platform }, runtime, http] = await Promise.all([
      import("../../packages/smithers/src/internal/BunControl.ts"), import("@effect/platform-bun/BunRuntime"), import("@effect/platform-bun/BunHttpClient")
    ])
    runtime.runMain(run(platform, http.layer))
  } else {
    const [{ platform }, runtime, http] = await Promise.all([
      import("../../packages/smithers/src/internal/NodeControlHost.ts"), import("@effect/platform-node/NodeRuntime"), import("@effect/platform-node/NodeHttpClient")
    ])
    runtime.runMain(run(platform, http.layerUndici))
  }
}
