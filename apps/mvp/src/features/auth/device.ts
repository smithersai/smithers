import { Context, Data, Effect, Layer } from "effect"

// This device, as sign-out wipes it (decision 0008 §4.6): what the device holds of the session it ended, its synced
// rows and its outbox, must not outlive it on a shared device. The host does the wiping: main.tsx's browser host
// marks the wipe and reloads, and the next boot deletes the device's databases before opening them; a test's Node host
// deletes its SQLite file and empties its outbox.

/** The host couldn't wipe the device. */
export class WipeFailed extends Data.TaggedError("WipeFailed")<{}> {}

/** Wipes this device's synced data and outbox. */
export class DeviceWipe extends Context.Service<DeviceWipe, {
  readonly wipe: Effect.Effect<void, WipeFailed>
  /** Releases the host's guard when the whole sign-out action ends, including local failures before wipe. */
  readonly finishSignOut: Effect.Effect<void>
}>()(
  "@smthrs/mvp/auth/DeviceWipe",
) {
  /** The device whose wipe is the host's `wipe` (`Host.wipe` in src/boot.ts). */
  static readonly layer = (wipe: () => Promise<void>, finishSignOut: () => Promise<void> = async () => {}) =>
    Layer.succeed(DeviceWipe, DeviceWipe.of({
      wipe: Effect.tryPromise({ try: wipe, catch: () => new WipeFailed() }),
      finishSignOut: Effect.promise(finishSignOut),
    }))
}
