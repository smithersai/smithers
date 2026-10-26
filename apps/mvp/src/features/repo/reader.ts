import { Effect, Layer } from "effect"
import { RepoClient, type RepoRefused } from "./api"
import { textOf } from "./contract"
import { AboutReader, type FileRead, RepoNotFound, RepoReader, RepoReadsPaused, RepoReadUnavailable } from "./flows"

// The device's `RepoReader` (src/features/repo/flows.ts): the agent's `repo/tree`, `repo/read` and `repo/refs` steps,
// and `repo/copy`'s contents, read through RepoApi's GET routes, the same answers the view reads; and its `AboutReader`,
// `repo/about`'s. The key stays on the server.

/**
 * What a refused read means to a step: gone (404, or a request RepoApi refused as invalid), the read budget spent
 * (503 `capacity`), or worth trying again (anything else, after the server's `Retry-After` when it sent one), with
 * GitHub's reason when it rate limited or didn't answer About's read.
 */
export const readFailure = (refused: RepoRefused): RepoNotFound | RepoReadsPaused | RepoReadUnavailable =>
  refused.status === 404 || refused.status === 400
    ? new RepoNotFound()
    : refused.status === 503 && refused.code === "capacity"
    ? new RepoReadsPaused()
    : new RepoReadUnavailable({
      ...(refused.retryAfterMillis === undefined ? {} : { retryAfterMillis: refused.retryAfterMillis }),
      ...(refused.status === 503 && (refused.code === "rate_limited" || refused.code === "github_unavailable")
        ? { reason: refused.code }
        : {}),
    })

/** `AboutReader` over the browser's `RepoClient`: RepoApi's about route. */
export const aboutLayer = Layer.effect(
  AboutReader,
  Effect.map(RepoClient, (client) =>
    AboutReader.of({ about: (owner, name) => client.about(owner, name).pipe(Effect.mapError(readFailure)) })),
)

/** `RepoReader` over the browser's `RepoClient`. A file over RepoApi's limit reads as `too-large` with its size. */
export const readerLayer = Layer.effect(
  RepoReader,
  Effect.map(RepoClient, (client) =>
    RepoReader.of({
      tree: (owner, name, sha) => client.tree(owner, name, sha).pipe(Effect.mapError(readFailure)),
      refs: (owner, name) => client.refs(owner, name).pipe(Effect.mapError(readFailure)),
      read: (owner, name, sha, path) =>
        client.blob(owner, name, sha, path).pipe(
          Effect.map((blob): FileRead => {
            const contents = textOf(blob.bytes)
            const size = blob.bytes.byteLength
            return contents === undefined ? { state: "binary", size } : { state: "text", contents, size }
          }),
          // expected: a file too large to read is an answer; any other refusal fails the read
          Effect.catchTag("RepoRefused", (refused) =>
            refused.status === 413 && refused.size !== undefined
              ? Effect.succeed<FileRead>({ state: "too-large", size: refused.size })
              : Effect.fail(readFailure(refused))),
        ),
    })),
)
