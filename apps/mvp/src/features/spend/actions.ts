import { Effect, Exit, Metric, Option } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import type { AlertChannelName, SandboxLimitsRequest } from "./schema"
import { hidden, SpendStore } from "./store"

// What an Admin does about a spend alert (docs/features/spend-alerts.md): Hide, which marks it and every earlier alert
// seen on this device. It finishes at once; once the device stored the mark, it is a log line and a count.

/** Hides alert `id` and every earlier one on this device; a later alert still shows. */
export const hide = (id: string) =>
  Effect.gen(function* () {
    const { alerts, seen, scope } = yield* SpendStore
    const alert = yield* alerts.get(id)
    if (Option.isNone(alert)) return
    const { kind, createdAt } = alert.value
    const mark = yield* seen.get(kind)
    if (Option.isSome(mark) && mark.value.through >= createdAt) return
    const written = Option.isNone(mark)
      ? yield* seen.insert({ kind, through: createdAt })
      : yield* seen.update(kind, (draft) => Object.assign(draft, { through: createdAt }))
    // A mark the device couldn't store rolls back, and the collection logs it (`persisted write failed`).
    yield* written.persisted.pipe(
      Effect.andThen(Metric.update(hidden, 1)),
      Effect.andThen(Effect.logInfo("spend.alert.hidden").pipe(Effect.annotateLogs({ alertId: id }))),
      Effect.ignore,
      Effect.forkIn(scope),
    )
  }).pipe(
    // A device collection refuses only a row its own schema rejects, which these never are: a bug, not a state.
    Effect.orDie,
  )

/**
 * Sets where spend alerts go on `channel`: `destinations`, none to turn it off. It returns at once; the tab shows the
 * save until `alert/channel` (door `button`) ends, then the synced row, or the save failed, to be saved again.
 */
export const setChannel = (channel: AlertChannelName, destinations: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { saves, scope } = yield* SpendStore
    const flows = yield* FlowDispatch
    const held = yield* saves.get(channel)
    if (Option.isSome(held)) yield* saves.update(channel, (draft) => void (draft.state = "saving"))
    else yield* saves.insert({ channel, state: "saving" })
    yield* flows.dispatch("alert/channel", { channel, destinations: [...destinations] }, { door: "button" }).pipe(
      Effect.exit,
      // Done removes the save; ChatApi's refusal, or a flow that couldn't run, leaves it failed.
      Effect.flatMap((exit) =>
        Exit.isSuccess(exit) && exit.value._tag === "Done"
          ? saves.delete(channel)
          : saves.update(channel, (draft) => void (draft.state = "failed"))
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    )
  }).pipe(
    // A local collection refuses only a row its own schema rejects, which these never are: a bug, not a state.
    Effect.orDie,
  )

/**
 * Sets the sandbox limits (docs/features/sandbox-budgets.md#the-limits). It returns at once; the tab shows the save
 * until `sandbox/limits` (door `button`) ends, then the synced row, or the save failed, to be saved again.
 */
export const setLimits = (limits: SandboxLimitsRequest) =>
  Effect.gen(function* () {
    const { limitSaves, scope } = yield* SpendStore
    const flows = yield* FlowDispatch
    const held = yield* limitSaves.get("sandbox")
    if (Option.isSome(held)) yield* limitSaves.update("sandbox", (draft) => void (draft.state = "saving"))
    else yield* limitSaves.insert({ id: "sandbox", state: "saving" })
    yield* flows.dispatch("sandbox/limits", { ...limits }, { door: "button" }).pipe(
      Effect.exit,
      // Done removes the save; ChatApi's refusal, or a flow that couldn't run, leaves it failed.
      Effect.flatMap((exit) =>
        Exit.isSuccess(exit) && exit.value._tag === "Done"
          ? limitSaves.delete("sandbox")
          : limitSaves.update("sandbox", (draft) => void (draft.state = "failed"))
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    )
  }).pipe(
    // A local collection refuses only a row its own schema rejects, which these never are: a bug, not a state.
    Effect.orDie,
  )
