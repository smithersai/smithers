/**
 * `S.Cron` declarations as durable triggers.
 *
 * A `PACKAGE.ts` declares a schedule with `S.Cron({ schedule, run })`. This
 * module reads those declarations from the project's build graph and registers
 * each as a trigger that `smthrs triggers serve` fires: the trigger's id is the
 * Cron target's label and its launch runs the declared targets through the
 * build (see {@link module:TargetRuns}).
 *
 * @since 1.0.0
 */

import { openPackageIndex } from "@smthrs/build-cli/Cli"
import * as PackageDiscovery from "@smthrs/build-cli/PackageDiscovery"
import { canonicalize } from "@smthrs/canonical"
import * as CronTarget from "@smthrs/targets/CronTarget"
import * as Target from "@smthrs/targets/Target"
import * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Effect, Option, Result, Schema } from "effect"
import * as CliError from "../CliError.vibe"
import * as TargetRuns from "./TargetRuns.ts"

const refused = (message: string): CliError.Refused =>
  new CliError.Refused({ fault: "user", code: "operator_failed", message })

/**
 * The triggers a project's `S.Cron` targets declare, enabled; none when the
 * project is not a build workspace.
 *
 * @category queries
 * @since 1.0.0
 */
export const declared = (root: string): Effect.Effect<ReadonlyArray<Trigger.Trigger>, CliError.Refused> =>
  Effect.gen(function*() {
    const index = yield* Effect.tryPromise({
      try: async () =>
        (await PackageDiscovery.workspaceFileOf(root)) === undefined
          ? undefined
          : await openPackageIndex({ workspace: root }),
      catch: (cause) =>
        refused(
          `Could not read this project's S.Cron targets: ${cause instanceof Error ? cause.message : String(cause)}`
        )
    })
    if (index === undefined) return []
    const labels = (cron: string, targets: ReadonlyArray<Target.AnyTarget>) =>
      Effect.forEach(targets, (target) => {
        const label = index.labelOf(target)
        return label === undefined
          ? Effect.fail(refused(`An entry of Cron ${cron} has no label; list it in a Package map`))
          : Effect.succeed(label)
      })
    return yield* Effect.forEach(
      index.targets().filter((row) => Target.metadata(row.target).target === "Cron"),
      (row) =>
        Effect.gen(function*() {
          const cron = CronTarget.attrsOf(row.target)
          const refresh = yield* labels(row.label, cron.refresh ?? [])
          return yield* Trigger.make({
            id: row.label,
            flowId: TargetRuns.flowId,
            input: {
              run: yield* labels(row.label, cron.run),
              ...(refresh.length === 0 ? {} : { refresh }),
              declaredBy: row.label
            },
            cron: cron.schedule,
            enabled: true
          }).pipe(Effect.mapError((error) => refused(`Cron ${row.label} is invalid: ${error.message}`)))
        })
    )
  })

/** A registration without the fields the store adds, so two can be compared. */
const declarationOf = (trigger: Trigger.Trigger): Trigger.Trigger => ({
  id: trigger.id,
  flowId: trigger.flowId,
  input: trigger.input,
  cron: trigger.cron,
  ...(trigger.timezone === undefined ? {} : { timezone: trigger.timezone }),
  overlap: trigger.overlap,
  catchUp: trigger.catchUp,
  maxCatchUp: trigger.maxCatchUp,
  enabled: trigger.enabled
})

/** The launch of a trigger a `PACKAGE.ts` declared, or none for any other trigger. */
const declaredLaunch = (trigger: Trigger.Trigger): Option.Option<TargetRuns.Launch> =>
  trigger.flowId !== TargetRuns.flowId
    ? Option.none()
    : Schema.decodeUnknownOption(TargetRuns.Launch)(trigger.input).pipe(
      Option.filter((launch) => launch.declaredBy !== undefined)
    )

/**
 * What one {@link sync} changed, as trigger ids.
 * @category models
 * @since 1.0.0
 */
export interface Synced {
  /** Declarations registered for the first time or updated. */
  readonly registered: ReadonlyArray<string>
  /** Declarations already registered as declared. */
  readonly unchanged: ReadonlyArray<string>
  /** Registrations disabled because their declaration was removed. */
  readonly withdrawn: ReadonlyArray<string>
}

/**
 * Makes the trigger store match the project's `S.Cron` declarations.
 *
 * A new declaration is registered enabled. A changed one is updated and keeps
 * the enablement an operator gave it. A registration whose declaration was
 * removed is disabled, not deleted, so its fire history stays; declaring it
 * again enables it. Triggers registered by hand are never touched.
 *
 * @category commands
 * @since 1.0.0
 */
export const sync = (root: string) =>
  Effect.gen(function*() {
    const store = yield* TriggerStore.TriggerStore
    const wanted = yield* declared(root)
    const stored = new Map<string, Trigger.Trigger>()
    // A row that does not decode is not a declaration this sync can own.
    for (const row of yield* store.list()) {
      if (Result.isSuccess(row.trigger)) stored.set(row.triggerId, row.trigger.success)
    }
    const registered: Array<string> = []
    const unchanged: Array<string> = []
    const withdrawn: Array<string> = []
    for (const declaration of wanted) {
      const current = stored.get(declaration.id)
      const launch = current === undefined ? Option.none() : declaredLaunch(current)
      const kept = current !== undefined && !(Option.isSome(launch) && launch.value.withdrawn === true)
      const next = declarationOf({ ...declaration, enabled: kept ? current.enabled : true })
      if (current !== undefined && canonicalize(declarationOf(current)) === canonicalize(next)) {
        unchanged.push(declaration.id)
        continue
      }
      yield* store.register(next)
      registered.push(declaration.id)
    }
    const declaredIds = new Set(wanted.map((declaration) => declaration.id))
    for (const [id, current] of stored) {
      const launch = declaredLaunch(current)
      if (declaredIds.has(id) || Option.isNone(launch) || launch.value.withdrawn === true) continue
      yield* store.register({
        ...declarationOf(current),
        enabled: false,
        // The input decoded as a launch, so it is a JSON object.
        input: { ...(current.input as { readonly [key: string]: Schema.Json }), withdrawn: true }
      })
      withdrawn.push(id)
    }
    return { registered, unchanged, withdrawn } satisfies Synced
  })
