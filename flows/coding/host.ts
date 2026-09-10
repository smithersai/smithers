/** Private deployment recipe. Existing native host, catalog, agents and JJ ports. */
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Executable from "@smthrs/registry/Executable"
import * as Digest from "@smthrs/core/Digest"
import { HumanTask, Interpreter } from "@smthrs/flow"
import { Context, Effect, FileSystem, Layer } from "effect"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as NativeEquipment from "../../packages/smithers/src/internal/NativeEquipment.ts"
import type * as Application from "../../packages/smithers/src/Application.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { atomDelegate, atomFlows, atomOperations, EditAtom } from "./atoms.ts"
import { checkDelegate, checkLayers } from "./checks.ts"
import { NativeCoding, nativeActions, nativeLayer, type NativeOptions } from "./native.ts"
import { registration, RunPlan } from "./registration.ts"
import * as Snapshots from "./snapshots.ts"
import * as CodingFileSystem from "./filesystem.ts"
import { correctionLayers, SelectRepair } from "./correction.ts"
import { memoryLayer, type MemoryOptions } from "./planning-memory.ts"
import { DraftPlan, planningPolicy, PreparePlan, ReviewRequest } from "./planning.ts"
import { evidenceOnly } from "./planning-authority.ts"
import { requestRegistration, RunRequest } from "./request.ts"
import { sourceAdmission } from "./source-admission.ts"
import { planningWikiLayers } from "./planning-wiki.ts"
import { ReviewPage } from "../wiki/workflow.ts"
import { pocModels, pocPolicy } from "./poc.ts"
import { pocSource } from "./poc-source.ts"
import { feedbackLayer, routeMessages } from "./steering.ts"
import { runningWikiPolicy } from "./wiki-policy.ts"
import { separateWikiOutput } from "./wiki-output.ts"

/** Operator configuration, never accepted from a workflow or gateway request. */
export interface Options extends NativeOptions {
  /** Same operator credential used by Serve; enables the existing native gateway delegation. */
  readonly credential?: string | undefined
  /** Existing authority override, including a narrower operator policy. */
  readonly approvalAuthority?: Application.Config["approvalAuthority"]
  readonly gatewayId: string
  readonly implementationModel: string
  readonly exporterPath?: string | undefined
  readonly checkEnvironment?: Readonly<Record<string, string>> | undefined
  /** Enables the private prompt route using this repository's owning memory/check configuration. */
  readonly planning?: (Omit<MemoryOptions, "repositoryPath"> & { readonly reviewer: string }) | undefined
  readonly planningModel?: string | undefined
  readonly pocModel?: string | undefined
  readonly wikiModel?: string | undefined
}

const configured = (options: Options) => {
  if (!/^[a-z0-9-]+:[^\s:]+$/.test(options.implementationModel)) {
    throw new Error("Set SMITHERS_CODING_IMPLEMENT_MODEL to an explicit provider:model for coding/implement")
  }
  for (const model of [options.planningModel, options.pocModel, options.wikiModel]) {
    if (model !== undefined && !/^[a-z0-9-]+:[^\s:]+$/.test(model)) throw new Error("Coding role models must be explicit provider:model values")
  }
  if (options.planning !== undefined && !options.planning.reviewer.trim()) {
    throw new Error("Planning requires an explicit wiki reviewer policy identity")
  }
  if (!/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.gatewayId)) {
    throw new Error("A configured coding host requires its owning SMITHERS_GATEWAY_ID")
  }
  if (!options.credential?.trim() && options.approvalAuthority === undefined) {
    throw new Error("A configured coding host requires SMITHERS_API_KEY or an explicit approval authority, including on loopback")
  }
}

/** Resolves the role through the existing workspace/user credential route. */
export const roleResolver = (base: SeatResolver.Service, implementationModel: string,
  models: Pick<Options, "planningModel" | "pocModel" | "wikiModel"> = {}): SeatResolver.Service => {
  const roles: Readonly<Record<string, string>> = { "coding/implement": implementationModel,
    "coding/plan": models.planningModel ?? implementationModel,
    "coding/poc": models.pocModel ?? implementationModel,
    "wiki/reviewer": models.wikiModel ?? implementationModel }
  return SeatResolver.make({ resolve: id => base.resolve(Object.hasOwn(roles, id) ? roles[id]! : id).pipe(
    Effect.map(seat => Object.hasOwn(roles, id) ? Seat.make({ ...seat, id }) : seat)
  ) })
}

/** Both platform entries call this one recipe; no second executor or store. */
export const layer = (platform: NativeControl.Platform, options: Options, suppliedSeats?: SeatResolver.Service) => {
  configured(options)
  const native = NativeControl.make({ ...platform,
    jj: root => Snapshots.layerAt({ ...options, repositoryPath: root }),
    filesystem: (root, fs, spawner) => fs.realPath(root).pipe(
      Effect.map(canonicalRoot => CodingFileSystem.make({ ...options, repositoryPath: root }, fs, spawner, canonicalRoot)),
      Effect.orDie
    )
  }, environment => Layer.effect(SeatResolver.SeatResolver)(
    Effect.map(SeatResolver.SeatResolver, base => roleResolver(base, options.implementationModel, options))
  ).pipe(Layer.provide(suppliedSeats === undefined ? NativeEquipment.layerSeatResolver(environment) : SeatResolver.layer(suppliedSeats))),
  options.planning === undefined ? undefined : routeMessages)
  return Layer.suspend(() => Layer.unwrap(Effect.gen(function*() {
    // Host-owned immutable wiki publication and scratch cleanup use the trusted
    // FS. Model actions and check processes retain the native host's guards.
    const fs = yield* FileSystem.FileSystem
    const reviewerPolicy = options.planning === undefined ? undefined : yield* runningWikiPolicy
    const wikiOutput = options.planning === undefined ? undefined : yield* separateWikiOutput(options.repositoryPath, options.planning.wikiOutput)
    const request = options.planning === undefined ? Layer.empty : Layer.mergeAll(
      memoryLayer({ ...options.planning, wikiOutput: wikiOutput!, repositoryPath: options.repositoryPath }, fs),
      planningWikiLayers({ ...options.planning, wikiOutput: wikiOutput!, repositoryPath: options.repositoryPath,
        reviewer: Digest.canonical({ policy: options.planning.reviewer, model: options.wikiModel ?? options.implementationModel,
          gateway: options.gatewayId, hostPolicy: reviewerPolicy }) }, fs),
      planningPolicy, Interpreter.layer(PreparePlan), HumanTask.layer, correctionLayers, sourceAdmission, requestRegistration, feedbackLayer,
      pocPolicy, pocModels, pocSource({ ...options, fs }),
      evidenceOnly(Layer.mergeAll(ReviewRequest.layer, DraftPlan.layer, SelectRepair.layer, ReviewPage.layer))
    )
    const leaves = Layer.mergeAll(atomFlows, atomOperations, EditAtom.layer, nativeActions, request,
      checkLayers({ repositoryPath: options.repositoryPath, fs,
        exporterPath: options.exporterPath, environment: options.checkEnvironment }))
      .pipe(Layer.provideMerge(nativeLayer(options)))
    // Loading verified declaration bytes reserves a sibling temporary module.
    // This is host startup work. Register the resulting flows only after that
    // read/import effect ends, under the original guarded handler context.
    const catalog = Layer.unwrap(Executable.catalog({ delegates: [RunPlan, atomDelegate, checkDelegate, ...(options.planning === undefined ? [] : [RunRequest])] }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.map(built => Layer.mergeAll(leaves, ...built.executables.map(entry => entry.layer)).pipe(
        Layer.provideMerge(Layer.succeed(Executable.Catalog, built))
      ))
    )).pipe(Layer.orDie)
    const modules = registration.pipe(Layer.provideMerge(catalog), Layer.tap(context => Effect.gen(function*() {
      const built = Context.get(context, Executable.Catalog)
      for (const [name, delegate] of [["coding", RunPlan._tag], ["coding/implementation", atomDelegate._tag],
        ...(options.planning === undefined ? [] : [["coding/request", RunRequest._tag]])]) {
        if (!built.executables.some(entry => entry.descriptor.name === name && entry.delegate === delegate)) {
          return yield* Effect.die(new Error(`Required coding executable ${name} is unavailable; inspect the catalog refusal`))
        }
      }
      // Plue's adapter verifies the owning workspace binding. A missing native
      // binary, incorrect repository binding or invalid receipt prevents serve.
      const binding = yield* Context.get(context, NativeCoding).read()
      if (binding.head.kind !== "resolved") return yield* Effect.die(new Error("Resolve native JJ conflicts before starting the configured coding host"))
    })), Layer.orDie)
    const host = native.layerHost({ root: options.repositoryPath, credential: options.credential,
      approvalAuthority: options.approvalAuthority ?? native.gatewayApprovalAuthority }, modules)
    return Layer.effect(Serve.GatewayHost)(Effect.map(Serve.GatewayHost, gateway => ({
      launch: (health, bind, root) => gateway.launch({ ...health, gatewayId: options.gatewayId,
        capabilities: [...new Set([...(health.capabilities ?? []), "coding-plan/v1", ...(options.planning === undefined ? [] : ["coding-request/v1"])])] }, bind, root)
    }))).pipe(Layer.provideMerge(host))
  }).pipe(Effect.provide(platform.host))))
}
