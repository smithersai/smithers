/** Deployment recipe for one pinned public invocation. The native runtime owns every graph and receipt. */
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, FileSystem, Layer } from "effect"
import { createHash } from "node:crypto"
import { resolve, sep } from "node:path"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"

export interface Options {
  readonly root: string
  readonly stateRoot: string
  readonly flow: string
  readonly sourceDigest: string
  readonly credential: string
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator>
}

export const layer = (platform: NativeControl.Platform, options: Options) => {
  const root = resolve(options.root), stateRoot = resolve(options.stateRoot)
  if (
    !options.credential || !/^[a-f0-9]{64}$/.test(options.sourceDigest) || !options.flow ||
    options.flow.split("/").some((part) => !part || part.startsWith(".") || part.includes("\\")) ||
    stateRoot === root || stateRoot.startsWith(root + sep)
  ) throw new Error("Invalid pinned invocation host identity")
  const native = NativeControl.make(platform)
  const registry = native.layerRegistry(root)
  return Layer.unwrap(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const source = yield* fs.readFile(resolve(root, "flows", options.flow, "flow.ts"))
      if (createHash("sha256").update(source).digest("hex") !== options.sourceDigest) {
        throw new Error("Pinned invocation source changed")
      }
      // Import verified declaration bytes during registration preparation, then
      // register their handlers under the native host's guarded context.
      const modules = Layer.unwrap(
        Executable.catalog({ delegates: [] }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.map((built) => {
            const target = built.executables.find((entry) => entry.descriptor.name === options.flow)
            if (target === undefined) {
              throw new Error("Invocation requires an executable canonical Flow.make declaration", {
                cause: built.refused.find((entry) => entry.flow === options.flow)
              })
            }
            // Registering a neighbouring module under this flow's tag would swap
            // its body without changing the selected descriptor's approved digest.
            if (built.executables.some((entry) => entry.declaredTag !== entry.descriptor.name)) {
              throw new Error("Invocation Flow.make tag must match its flows/<name>/flow.ts path")
            }
            return Layer.mergeAll(
              Executable.layerRefreshable(built, { delegates: [], refreshable: () => false }),
              ...built.executables.map((entry) => entry.layer)
            )
          })
        )
      ).pipe(Layer.orDie)
      // Authenticated gateway identity is the only approver. Native module
      // authority restores the approved envelope on every resumed handler.
      return native.layerHost(
        {
          root,
          stateRoot,
          credential: options.credential,
          approvalAuthority: native.gatewayApprovalAuthority,
          evaluator: options.evaluator
        },
        modules,
        registry
      )
    }).pipe(Effect.provide(platform.host))
  )
}
