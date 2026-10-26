import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import { Context, Deferred, Effect, Layer, Metric, Queue, Schema, Stream } from "effect"
import type { Handlers } from "../../flows/tabPort"
import type { ThemeMode } from "./contract"
import { Preferences, WriteTheme } from "./flows"
import { Mode, Preference, THEME } from "./schema"

// This device's theme (docs/features/flows.md#the-theme): the `preferences` collection, kept on the device, and a
// follower that projects it onto the page. No component owns the theme: `app/theme/set` writes the collection, and
// the follower paints `<html data-theme>` and mirrors the mode into `localStorage`, which index.html paints from before
// the store opens. Another tab of this device sees the write through the device store and paints it the same way.

/** What the browser gives the theme: the page to paint, the mirror, and what the page shows without a preference. */
export interface ThemeHost {
  /** Sets `<html data-theme>` to `mode`, or removes it to follow the system. */
  readonly paint: (mode: ThemeMode | undefined) => void
  /** Writes the mode to `localStorage`, or removes the mirror to follow the system. */
  readonly mirror: (mode: ThemeMode | undefined) => void
  /** The system's mode (`prefers-color-scheme`): what the page shows while there is no preference. */
  readonly system: () => ThemeMode
  /** Host notifications when the system color scheme changes. */
  readonly systemChanges?: EventTarget
  /**
   * The mode `<html data-theme>` holds, if any: what index.html painted from the mirror before the store opened, or
   * what the follower painted since.
   */
  readonly painted: () => ThemeMode | undefined
}

/** This device's preference, if it has one: what frontends read. */
export const themeQuery = (preferences: Collection.Collection<Preference, string>) =>
  LiveQuery.make((q) => q.from({ preference: preferences.tanstack }).findOne())

export const systemChanges = Metric.counter("smithers_theme_system_changes", { incremental: true })

type Query<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/**
 * The theme's state for one tab:
 * - `preferences`: this device's preferences, kept on the device; the theme's row is `{ id: "theme", mode }`.
 * - `theme`: the live query of that row.
 * - `current`: the mode the page shows now: the preference once the device's rows are restored, else `shown`.
 * - `shown`: what the page shows while the query has no row, as before the device's rows are restored: the painted
 *   mode, else the system's.
 * - `write`: sets the preference, which the follower then paints, and returns once the device has stored it.
 */
export class ThemeStore extends Context.Service<
  ThemeStore,
  {
    readonly preferences: Collection.Collection<Preference, string>
    readonly theme: Query<typeof themeQuery>
    readonly current: Effect.Effect<ThemeMode>
    readonly shownMode: Query<typeof themeQuery>
    /** What the page shows while the query has no row: the painted mode, else the system's. */
    readonly shown: () => ThemeMode
    readonly write: (mode: ThemeMode) => Effect.Effect<void>
  }
>()("@smthrs/mvp/theme/ThemeStore") {
  /** The store, with its follower running until the scope closes. */
  static readonly layer = (host: ThemeHost) =>
    Layer.effect(
      ThemeStore,
      Effect.gen(function* () {
        const preferences = yield* Collection.persisted({
          id: "preferences",
          schema: Preference,
          getKey: (row): string => row.id,
          schemaVersion: 1,
        })
        const theme = yield* themeQuery(preferences)
        // Transient projection only: system changes must never create a saved preference.
        const display = yield* Collection.local({ id: "theme-display", schema: Preference, getKey: (row): string => row.id })
        yield* display.insert({ id: THEME, mode: host.painted() ?? host.system() })
        const shownMode = yield* themeQuery(display)
        const paint = (mode: ThemeMode | undefined) => Effect.sync(() => host.paint(mode)).pipe(
          Effect.andThen(() => display.update(THEME, (draft) => { draft.mode = mode ?? host.system() })),
        )
        if (host.systemChanges !== undefined) {
          const target = host.systemChanges
          const listening = yield* Deferred.make<void>()
          yield* Stream.callback<void>((queue) => Effect.acquireRelease(
            Effect.sync(() => {
              const changed = () => { Queue.offerUnsafe(queue, undefined) }
              target.addEventListener("change", changed)
              return changed
            }),
            (changed) => Effect.sync(() => target.removeEventListener("change", changed)),
          ).pipe(Effect.andThen(Deferred.succeed(listening, undefined)))).pipe(
            Stream.runForEach(() => preferences.get(THEME).pipe(
              Effect.flatMap((row) => row._tag === "Some" ? Effect.void : paint(undefined).pipe(
                Effect.andThen(Metric.update(systemChanges, 1)),
                Effect.andThen(Effect.logInfo("theme.system_changed")),
                Effect.withSpan("theme.system_changed"),
              )),
            )),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(listening)
        }
        yield* preferences.changes({ initial: true }).pipe(
          Stream.runForEach((changes) =>
            Effect.forEach(changes, (change) => Effect.gen(function* () {
              // Without a preference the page follows the system again.
              const mode = change.type === "delete" ? undefined : change.value.mode
              yield* paint(mode)
              yield* Effect.sync(() => host.mirror(mode))
            }))
          ),
          Effect.forkScoped,
        )
        // Without a row, what the page shows: the mirror's paint, or the system's mode. A toggle flips what the person
        // sees, even when the device lost the row the mirror came from.
        const shown = () => host.painted() ?? host.system()
        const current = preferences.restored.pipe(
          // expected: restore failures are logged by Collection
          Effect.ignore,
          Effect.andThen(preferences.get(THEME)),
          Effect.map((row) => (row._tag === "Some" ? row.value.mode : shown())),
        )
        const write = (mode: ThemeMode) =>
          Effect.gen(function* () {
            const existing = yield* preferences.get(THEME)
            const written = yield* existing._tag === "Some"
              ? preferences.update(THEME, (draft) => {
                draft.mode = mode
              })
              : preferences.insert({ id: THEME, mode })
            // The step that set the mode ends once the device has it: a reload right after keeps it.
            yield* written.persisted
          }).pipe(
            // A local collection refuses only a row its own schema rejects, which a mode never is, and a device that
            // can't store it is the store's failure, logged where it happens: a bug, not a state of the theme.
            Effect.orDie,
            Effect.asVoid,
          )
        return ThemeStore.of({ preferences, theme, shownMode, current, shown, write })
      }),
    )
}

/** This tab's `Preferences`: the store's own write. The tab answers the engine worker's theme writes with it. */
export const tabPreferences = Layer.effect(
  Preferences,
  Effect.gen(function* () {
    const store = yield* ThemeStore
    return Preferences.of({ setTheme: store.write })
  }),
)

const decodeWrite = Schema.decodeUnknownEffect(Schema.Struct({ mode: Mode }))

/** What this tab answers its engine worker's theme writes with: the store's own write (src/flows/tabPort.ts). */
export const tabHandlers = Effect.gen(function* () {
  const store = yield* ThemeStore
  return {
    [WriteTheme.name]: (input) =>
      decodeWrite(input).pipe(Effect.flatMap(({ mode }) => store.write(mode)), Effect.as(null)),
  } satisfies Handlers
})
