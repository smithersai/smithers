/** Private deployment recipe. Existing native host, catalog, agents and JJ ports. */
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
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
import { preparationLayers } from "./preparation.ts"
import { prototypeRegistration, RunPrototype } from "./prototype.ts"
import { ReviewPage } from "../wiki/workflow.ts"
import { pocModels, pocPolicy } from "./poc.ts"
import { pocSource } from "./poc-source.ts"
import { feedbackLayer, routeMessages } from "./steering.ts"
import { runningWikiPolicy } from "./wiki-policy.ts"
import { separateWikiOutput } from "./wiki-output.ts"
import { wikiCheckDelegate, wikiCheckLayers, wikiCheckPolicy } from "./wiki-check.ts"
import { bindWikiRegistry } from "./wiki-registry.ts"
import type { Landing } from "./landing.ts"
import { cleanupModels } from "./vibe-cleanup.ts"
import { RunVibe, vibeRegistration } from "./vibe.ts"
import * as CodingState from "./state.ts"
import { inspectionLayers } from "../repository/inspection.ts"
import { jobFlows, failureLayer, modelLayers, modelNames } from "../repository/jobs.ts"
import { executionLayers } from "../repository/execution.ts"
import { evaluationLayers, ScoreCase } from "../repository/evaluation.ts"
import { setupLayers, RunJob, RunSetup, SuggestSetup } from "../repository/setup.ts"
import { bindRepositoryRegistry, provisionBuiltins, runningRepositoryPolicy, repositoryCatalog } from "../repository/registry.ts"
import type { RepositoryRemote } from "../repository/remote.ts"
import { activationLayers } from "../repository/activation.ts"
import { RunTrigger, triggerLayers } from "../repository/triggers.ts"
import { checkLayers as repositoryCheckLayers, checkModelLayers, checkModelNames } from "../repository/checks.ts"
import { evaluatorLayer } from "../repository/jev-checks.ts"
import { deliveryLayers } from "../repository/delivery.ts"
import { replyLayers } from "../repository/replies.ts"
import { changeLayers, changeModelLayers, changeModelNames } from "../repository/changes.ts"

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
  readonly planning?: (Omit<MemoryOptions, "repositoryPath"> & { readonly reviewer?: string }) | undefined
  readonly planningModel?: string | undefined
  readonly pocModel?: string | undefined
  readonly wikiModel?: string | undefined
  /** Deployment-owned landing adapter over the reserved repository credential; enables coding/vibe. */
  readonly landing?: Layer.Layer<Landing> | undefined
  readonly repositoryRemote?: Layer.Layer<RepositoryRemote> | undefined
  /**
   * Where this host keeps `control.db`, `engine.db` and their WAL companions.
   * Defaults to `CodingState.defaultStateRoot(repositoryPath)`, beside the
   * served working copy. A path inside the working copy is refused unless
   * `SMITHERS_CODING_STATE_IN_ROOT` opts in; see `./state.ts`.
   */
  readonly stateRoot?: string | undefined
}

const configured = (options: Options) => {
  if (!/^[a-z0-9-]+:[^\s:]+$/.test(options.implementationModel)) {
    throw new Error("Set SMITHERS_CODING_IMPLEMENT_MODEL to an explicit provider:model for coding/implement")
  }
  for (const model of [options.planningModel, options.pocModel, options.wikiModel]) {
    if (model !== undefined && !/^[a-z0-9-]+:[^\s:]+$/.test(model)) throw new Error("Coding role models must be explicit provider:model values")
  }
  if (options.planning?.wiki === true && (!options.planning.reviewer?.trim() || !options.planning.wikiOutput?.trim() || !options.planning.pages?.length)) {
    throw new Error("Enabled Wiki requires an explicit reviewer, publication path and page configuration")
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
    "wiki/reviewer": models.wikiModel ?? implementationModel,
    "repository/research": models.planningModel ?? implementationModel,
    "repository/evaluator": models.planningModel ?? implementationModel,
    "repository/checker": models.planningModel ?? implementationModel, "repository/author": implementationModel }
  return SeatResolver.make({ resolve: id => base.resolve(Object.hasOwn(roles, id) ? roles[id]! : id).pipe(
    Effect.map(seat => Object.hasOwn(roles, id) ? Seat.make({ ...seat, id }) : seat)
  ) })
}

/** Both platform entries call this one recipe; no second executor or store. */
export const layer = (platform: NativeControl.Platform, options: Options, suppliedSeats?: SeatResolver.Service) => {
  configured(options)
  // Resolved before any layer is built, so an in-root state directory is a
  // named startup refusal rather than a stale_revision three seconds into the
  // first plan. The engine writes to this tree on every step.
  const stateRoot = CodingState.resolveStateRoot({ root: options.repositoryPath, explicit: options.stateRoot, environment: process.env })
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
    const wikiEnabled = options.planning?.wiki === true
    const reviewerPolicy = !wikiEnabled ? undefined : yield* runningWikiPolicy
    const wikiOutput = !wikiEnabled ? undefined : yield* separateWikiOutput(options.repositoryPath, options.planning!.wikiOutput!)
    const wikiReviewer = !wikiEnabled ? undefined : Digest.canonical({ policy: options.planning!.reviewer,
      model: options.wikiModel ?? options.implementationModel, gateway: options.gatewayId, hostPolicy: reviewerPolicy })
    const wikiOptions = !wikiEnabled ? undefined : { ...options.planning!, pages: options.planning!.pages!, wikiOutput: wikiOutput!,
      repositoryPath: options.repositoryPath, reviewer: wikiReviewer!, hostPolicy: reviewerPolicy! }
    const repositoryBundle = yield* runningRepositoryPolicy
    const repositoryPolicy = Digest.digest(Digest.canonical({ bundle: repositoryBundle, implementationModel: options.implementationModel,
      researchModel: options.planningModel ?? options.implementationModel, gateway: options.gatewayId }))
    const builtins = yield* provisionBuiltins(stateRoot, repositoryPolicy)
    const registry = Layer.effect(Registry.Registry)(
      Effect.map(Registry.Registry, base => bindRepositoryRegistry(wikiOptions === undefined ? base
        : bindWikiRegistry(base, wikiCheckPolicy(wikiOptions)), builtins.registry, repositoryPolicy))
    ).pipe(Layer.provide(native.layerRegistry(options.repositoryPath)))
    const request = options.planning === undefined ? Layer.empty : Layer.mergeAll(
      memoryLayer({ ...options.planning, ...(wikiOutput === undefined ? {} : { wikiOutput }), repositoryPath: options.repositoryPath }, fs),
      preparationLayers(wikiEnabled), prototypeRegistration,
      ...(wikiOptions === undefined ? [] : [planningWikiLayers(wikiOptions, fs),
        wikiCheckLayers({ ...wikiOptions, fs, exporterPath: options.exporterPath, environment: options.checkEnvironment })]),
      planningPolicy, Interpreter.layer(PreparePlan), HumanTask.layer, correctionLayers, sourceAdmission, requestRegistration, feedbackLayer,
      pocPolicy, pocModels, pocSource({ ...options, fs }),
      evidenceOnly(Layer.mergeAll(ReviewRequest.layer, DraftPlan.layer, SelectRepair.layer, ReviewPage.layer)),
      ...(options.landing === undefined ? [] : [vibeRegistration.pipe(Layer.provide(options.landing)), cleanupModels])
    )
    const repository = Layer.mergeAll(inspectionLayers({ repositoryPath: options.repositoryPath, fs, exporterPath: options.exporterPath, environment: options.checkEnvironment }),
      jobFlows, failureLayer, executionLayers({ repositoryPath: options.repositoryPath, fs,
        exporterPath: options.exporterPath, environment: options.checkEnvironment }), evaluationLayers,
      setupLayers({ repositoryPath: options.repositoryPath, fs, exporterPath: options.exporterPath, environment: options.checkEnvironment }), activationLayers, triggerLayers, replyLayers, deliveryLayers,
      // Jev answers the AI checks' hunks when the host has a gateway key, and
      // the frontier seat keeps every rule it is unsure of. Without the key
      // `evaluatorLayer` refuses every evaluation and nothing changes.
      repositoryCheckLayers({ repositoryPath: options.repositoryPath, fs, exporterPath: options.exporterPath,
        environment: options.checkEnvironment, evaluator: evaluatorLayer(process.env) }),
      changeLayers({ repositoryPath: options.repositoryPath, fs, exporterPath: options.exporterPath, environment: options.checkEnvironment }),
      evidenceOnly(Layer.mergeAll(modelLayers, ScoreCase.layer, SuggestSetup.layer, checkModelLayers, changeModelLayers), new Set([...modelNames, ScoreCase.name, SuggestSetup.name, ...checkModelNames, ...changeModelNames])))
    const leaves = Layer.mergeAll(atomFlows, atomOperations, EditAtom.layer, nativeActions, request, repository,
      checkLayers({ repositoryPath: options.repositoryPath, fs, concurrency: 1,
        exporterPath: options.exporterPath, environment: options.checkEnvironment }))
      .pipe(Layer.provideMerge(nativeLayer(options)),
        layers => options.repositoryRemote === undefined ? layers : layers.pipe(Layer.provideMerge(options.repositoryRemote)),
        layers => options.landing === undefined ? layers : layers.pipe(Layer.provideMerge(options.landing)))
    // Loading verified declaration bytes reserves a sibling temporary module.
    // This is host startup work. Register the resulting flows only after that
    // read/import effect ends, under the original guarded handler context.
    const catalog = Layer.unwrap(repositoryCatalog({ delegates: [RunPlan, atomDelegate, checkDelegate, RunSetup, RunJob, RunTrigger,
      ...(options.planning === undefined ? [] : [RunRequest, RunPrototype]), ...(wikiEnabled ? [wikiCheckDelegate] : []),
      ...(options.landing === undefined || options.planning === undefined ? [] : [RunVibe])] }, builtins.load).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.map(built => Layer.mergeAll(leaves, ...built.executables.map(entry => entry.layer)).pipe(
        Layer.provideMerge(Layer.succeed(Executable.Catalog, built))
      ))
    )).pipe(Layer.orDie)
    const modules = registration.pipe(Layer.provideMerge(catalog), Layer.tap(context => Effect.gen(function*() {
      const built = Context.get(context, Executable.Catalog)
      for (const [name, delegate] of [["coding", RunPlan._tag], ["coding/implementation", atomDelegate._tag],
        ...(options.planning === undefined ? [] : [["coding/request", RunRequest._tag]]),
        ...(options.landing === undefined || options.planning === undefined ? [] : [["coding/vibe", RunVibe._tag]]),
        ["repository/setup", RunSetup._tag], ["repository/trigger", RunTrigger._tag], ["repository-jobs/issues", RunJob._tag]]) {
        if (!built.executables.some(entry => entry.descriptor.name === name && entry.delegate === delegate)) {
          return yield* Effect.die(new Error(`Required coding executable ${name} is unavailable; inspect the catalog refusal`))
        }
      }
      // Plue's adapter verifies the owning workspace binding. A missing native
      // binary, incorrect repository binding or invalid receipt prevents serve.
      const binding = yield* Context.get(context, NativeCoding).read()
      if (binding.head.kind !== "resolved") return yield* Effect.die(new Error("Resolve native JJ conflicts before starting the configured coding host"))
      if (!binding.capabilities?.includes("apply-files/v1")) return yield* Effect.die(new Error("Update the workspace native adapter before starting repository jobs; apply-files/v1 is required"))
      if (!binding.capabilities.includes("import-source/v1")) return yield* Effect.die(new Error("Update the workspace native adapter before starting repository jobs; import-source/v1 is required"))
    })), Layer.orDie)
    const host = native.layerHost({ root: options.repositoryPath, stateRoot, credential: options.credential,
      approvalAuthority: options.approvalAuthority ?? native.gatewayApprovalAuthority }, modules, registry)
    return Layer.effect(Serve.GatewayHost)(Effect.map(Serve.GatewayHost, gateway => ({
      launch: (health, bind, root) => gateway.launch({ ...health, gatewayId: options.gatewayId,
        capabilities: [...new Set([...(health.capabilities ?? []), "coding-plan/v1", "repository-jobs/v1", "repository-source/v1", ...(options.planning === undefined ? [] : ["coding-request/v1"]),
          ...(options.landing === undefined || options.planning === undefined ? [] : ["coding-vibe/v1"])])] }, bind, root)
    }))).pipe(Layer.provideMerge(host))
  }).pipe(Effect.provide(platform.host))))
}
