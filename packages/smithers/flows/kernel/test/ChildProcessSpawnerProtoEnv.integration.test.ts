import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Effect } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner as EffectChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as ChildProcessSpawner from "../src/ChildProcessSpawner.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as Workspace from "../src/Workspace.ts"

// Effect 4.1.0's platform-node-shared drops an environment variable named __proto__ when it extends the parent
// environment; the patched dependency keeps it (migrate(vibelang) 1f8b169cbef0). Kept apart from
// ChildProcessSpawner.integration.test.ts so that file stays as Smithers main has it.

const withGuardedSpawner = <A, E>(
  options: GrantStore.MakeOptions,
  use: (store: GrantStore.Service) => Effect.Effect<A, E, EffectChildProcessSpawner>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const store = yield* GrantStore.make(options)
      return yield* use(store).pipe(
        Effect.provide(ChildProcessSpawner.layer),
        Effect.provide(ProcessConfinement.layerNoop),
        Effect.provide(NodeChildProcessSpawner.layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer),
        Effect.provideService(GrantStore.GrantStore, store)
      )
    })
  ).pipe(Effect.provide(Workspace.layer(process.cwd())))

describe("ChildProcessSpawner real Node environment", () => {
  it.effect("passes own __proto__ environment values to a real child when extending the parent environment", () =>
    Effect.gen(function*() {
      const env = Object.create(null) as Record<string, string>
      env.__proto__ = "kept-env"
      const command = ChildProcess.make(process.execPath, [
        "-e",
        "console.log(JSON.stringify({path:typeof process.env.PATH,special:process.env['__proto__']}))"
      ], { env, extendEnv: true })
      const pattern = new CapabilityPattern({ action: "proc:spawn", resource: "**" })
      const output = yield* withGuardedSpawner({
        attended: false,
        rules: [new Permission.Rule({ effect: "allow", pattern })]
      }, () =>
        Effect.gen(function*() {
          const spawner = yield* EffectChildProcessSpawner
          return yield* spawner.string(command)
        }))
      expect(JSON.parse(output)).toEqual({ path: "string", special: "kept-env" })
    }))
})
