/** Pinned single-file Bun host and local RPC bridge for a retained invocation VM. */
import { ControlRpcs } from "@smthrs/control"
import * as Flow from "@smthrs/flow"
import { GatewayRpcs } from "@smthrs/gateway/GatewayRpcs"
import * as Plan from "@smthrs/plan"
import * as EffectModules from "effect"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { layer } from "./host.ts"

/** Resolve declarations against this bundle without installing project dependencies. */
export const registerPinnedLibraries = (root: string, stateRoot: string) => {
  const modules: Record<string, object> = { "@smthrs/flow": Flow, "@smthrs/plan": Plan, effect: EffectModules }
  const identity = "smithers.invoke.pinned-libraries"
  Object.defineProperty(globalThis, Symbol.for(identity), { value: modules, configurable: false })
  // Bun runtime plugins do not intercept these bare imports on supported hosts.
  // Tiny ESM aliases expose the very same bundled objects (including schema and
  // registration symbols). No second package instance or downloaded code exists.
  const shim = (module: object, access: string) => {
    const bindings = Object.keys(module).filter((key) => /^[A-Za-z_$][\w$]*$/.test(key))
    return `const m = globalThis[Symbol.for(${JSON.stringify(identity)})]${access};\n` +
      bindings.map((key, index) => `const v${index} = m[${JSON.stringify(key)}]; export { v${index} as ${key} };`).join(
        "\n"
      ) + "\n"
  }
  for (const [name, module] of Object.entries(modules)) {
    const directory = join(stateRoot, "libraries", name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, type: "module", exports: { ".": "./index.mjs", "./*": "./*.mjs" } })
    )
    writeFileSync(join(directory, "index.mjs"), shim(module, `[${JSON.stringify(name)}]`))
    for (const [key, child] of Object.entries(module)) {
      if (
        /^[A-Za-z_$][\w$]*$/.test(key) && child !== null && (typeof child === "object" || typeof child === "function")
      ) {
        writeFileSync(join(directory, `${key}.mjs`), shim(child, `[${JSON.stringify(name)}][${JSON.stringify(key)}]`))
      }
    }
    const target = join(root, "node_modules", name)
    mkdirSync(dirname(target), { recursive: true })
    try {
      symlinkSync(directory, target, "dir")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || realpathSync(target) !== realpathSync(directory)) {
        throw new Error(`Pinned invocation library conflicts with repository dependency ${name}`, { cause: error })
      }
    }
  }
}

if (import.meta.main) {
  const command = process.argv[2]
  if (command === "--version") {
    console.log("smithers-invoke-host 1.0.0-rc.0")
  } else if (command === "--help") {
    console.log("smithers-invoke-host serve | rpc <procedure> <base64-json>")
  } else {
    const root = resolve(process.env.SMITHERS_INVOKE_ROOT ?? "/workspace/repo")
    const stateRoot = resolve(process.env.SMITHERS_INVOKE_STATE ?? "/var/lib/smithers-invoke")
    const credential = readFileSync(resolve(stateRoot, "credential"), "utf8").trim()
    if (!credential) throw new Error("Invocation credential is missing")
    if (command === "serve") {
      // Project declarations use the pinned bundled public libraries. Relative
      // imports still use the Registry's verified source loader.
      if (!("Bun" in globalThis)) throw new Error("The staged invocation host requires Bun")
      registerPinnedLibraries(root, stateRoot)
      const [{ platform }, runtime] = await Promise.all([
        import("../../packages/smithers/src/internal/BunControl.ts"),
        import("@effect/platform-bun/BunRuntime")
      ])
      runtime.runMain(
        Serve.host({ host: "127.0.0.1", port: 3011, listen: false, credential }, root).pipe(
          Effect.provide(
            layer(platform, {
              root,
              stateRoot,
              credential,
              flow: process.env.SMITHERS_INVOKE_FLOW ?? "",
              sourceDigest: process.env.SMITHERS_INVOKE_SOURCE_SHA256 ?? ""
            })
          ),
          Effect.provide(platform.host)
        )
      )
    } else if (command === "rpc") {
      const procedure = process.argv[3] ?? "", raw = process.argv[4] ?? ""
      if (!["Plan", "Approval.Submit", "Run", "List", "Cancel", "Projection.Snapshot"].includes(procedure)) {
        throw new Error("Unsupported invocation procedure")
      }
      const payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8"))
      const projection = procedure === "Projection.Snapshot" || procedure === "Approval.Submit"
      const protocol = RpcClient.layerProtocolHttp({
        url: `http://127.0.0.1:3011${projection ? "/projections" : "/rpc"}`,
        transformClient: (client) => HttpClient.mapRequest(client, HttpClientRequest.bearerToken(credential))
      }).pipe(
        Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])
      )
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          if (projection) {
            const client = yield* RpcClient.make(GatewayRpcs)
            if (procedure === "Projection.Snapshot") return yield* client["Projection.Snapshot"](payload)
            return yield* client["Approval.Submit"](payload)
          }
          const client = yield* RpcClient.make(ControlRpcs.ControlRpcs)
          switch (procedure) {
            case "Plan":
              return yield* client.Plan(payload)
            case "Run":
              return yield* client.Run(payload)
            case "List":
              return yield* client.List(payload)
            case "Cancel":
              return yield* client.Cancel(payload)
            default:
              return yield* Effect.fail(new Error("Unsupported invocation procedure"))
          }
        }).pipe(Effect.provide(protocol), Effect.scoped, Effect.timeout("20 seconds"))
      )
      process.stdout.write(JSON.stringify(result) + "\n")
    } else throw new Error("Expected serve or rpc")
  }
}
