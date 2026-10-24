import { ShapeSource } from "@smthrs/effect-electric"
import { Effect, Stream } from "effect"
import type { AuthStore } from "../auth/store"

/**
 * `source`, each request waiting until sign-in says someone is signed in: a person's own row is theirs to sync, and a
 * tab signed out never asks for it. Sign-out wipes the device's collections.
 */
export const signedInShapeSource = (source: ShapeSource.Source, auth: AuthStore["Service"]): ShapeSource.Source => {
  const signedIn = auth.sessionState.rows.pipe(
    Stream.filter((rows) => rows.some((row) => row.status === "signed_in")),
    Stream.take(1),
    Stream.runDrain,
  )
  return ShapeSource.ShapeSource.of({
    cacheNamespace: source.cacheNamespace,
    request: (url, init) => Effect.andThen(signedIn, source.request(url, init)),
  })
}
