import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy"
import * as Output from "alchemy/Output"
import { Stack } from "alchemy/Stack"
import { ConfigProvider, Context, Effect, Redacted } from "effect"

export const objectRuntime = RuntimeContext.of({
  Type: "test",
  id: "durable-object-test",
  env: {},
  get: () => Effect.undefined,
  set: (key) => Effect.succeed(key),
})

const workerKey = Cloudflare.Worker.Self as unknown as Context.Key<Cloudflare.Worker, Cloudflare.Worker>

/** Capture the object constructor registered by the real Alchemy layer. */
export const objectRegistration = (name: string, config: Record<string, string> = {}) => {
  const exports = new Map<string, unknown>()
  const worker = {
    bind: () => () => Effect.void,
    durableObjectNamespaces: Output.asOutput({}),
    export: (key: string, value: unknown) => Effect.sync(() => void exports.set(key, value)),
  } as unknown as Cloudflare.Worker
  const services = Context.make(workerKey, worker).pipe(
    Context.add(Cloudflare.WorkerEnvironment, { [name]: { getByName: () => undefined } }),
    Context.add(Stack, Stack.of({ name: "durable-object-test", stage: "test", resources: {}, bindings: {}, actions: {} })),
    Context.add(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({
      ALCHEMY_PHASE: "runtime",
      GITHUB_REPOSITORY: "octo/widgets",
      ...config,
    })),
  )
  return { exports, services }
}

export const connection = Effect.succeed({ LogicalId: "TestDatabase" } as Cloudflare.Hyperdrive.Connection)

/** A connector that makes construction possible and detects any unexpected database read. */
export const unusedDatabase = () => Effect.succeed({
  connectionString: Effect.die("unexpected database read"),
  raw: Effect.die("unexpected raw binding"),
  host: Effect.succeed("127.0.0.1"),
  port: Effect.succeed(5432),
  user: Effect.succeed("smithers"),
  password: Effect.succeed(Redacted.make("fixture")),
  database: Effect.succeed("smithers"),
})
