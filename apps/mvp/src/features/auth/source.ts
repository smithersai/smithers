import { ShapeSource } from "@smthrs/effect-electric"
import { Stream } from "effect"
import type { AuthStore } from "./store"

// Which shapes a device opens before anyone signs in (decisions 0110, 0112): a person's own rows are theirs to sync, so
// a tab signed out never asks for them, and sign-in opens them without a reload. Sign-out wipes the device's collections.

/** Whether someone is signed in on this device, from sign-in's session: the current answer first, then each change. */
export const signedInChanges = (auth: AuthStore["Service"]): Stream.Stream<boolean> =>
  auth.sessionState.rows.pipe(
    Stream.map((rows) => rows.some((row) => row.status === "signed_in")),
    Stream.changes,
  )

/** `source`, each request waiting while no one is signed in. The server still answers a signed-out request no rows. */
export const signedInShapeSource = (source: ShapeSource.Source, auth: AuthStore["Service"]): ShapeSource.Source =>
  ShapeSource.gated(source, signedInChanges(auth))
