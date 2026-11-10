/**
 * A GitHub repository as `@smthrs/jj`'s {@link Repository.Repository}: its
 * git objects through GitHub's Git database REST API, and its refs through
 * GraphQL, over the {@link GitHubClient} in context.
 *
 * - **Objects.** `POST /repos/{owner}/{repo}/git/blobs`, `git/trees` and
 *   `git/commits`, and their `GET`s. Each write's id is computed locally
 *   first, as git computes it, and GitHub's answer must be that id, so a write
 *   is idempotent and an answer for another object is refused `invalid`. A
 *   commit's author and committer dates are sent as UTC times, so GitHub
 *   stores exactly the commit hashed here; it does not sign it.
 * - **Refs.** `readRefs` is one GraphQL query; `updateRefs` is GraphQL's
 *   `updateRefs` mutation, which GitHub applies atomically and only when every
 *   ref holds its `beforeOid`. Every update is sent with `force: true`: the old
 *   value is the fence, so a rewrite that is not a fast-forward still moves
 *   only from the value its caller read.
 * - **A refused or lost update is read back.** GitHub answers a `beforeOid`
 *   mismatch with a generic GraphQL error, and a lost answer says nothing, so
 *   after any failure the refs are read: a ref that left its old value is a
 *   `conflict`; every ref at its new value is the update having landed; every
 *   ref still at its old value is `unavailable`, and retrying is safe.
 * - **Capability.** A GitHub without the `updateRefs` mutation fails
 *   `unsupported`; refs are never moved one request at a time.
 *
 * Errors map from {@link IntegrationError}: 404 is `not_found`, 422
 * `invalid`, anything else `unavailable`.
 *
 * @since 1.0.0
 */

import * as Repository from "@smthrs/jj/Repository"
import { Effect, Layer, Schema } from "effect"
import type { IntegrationError } from "../core/IntegrationError.ts"
import { GitHubClient } from "./GitHubClient.ts"
import { requireRepositoryPath } from "./Repository.ts"

const ZERO = "0".repeat(40)

const ShaAnswer = Schema.Struct({ sha: Schema.String })
const BlobAnswer = Schema.Struct({ content: Schema.String, encoding: Schema.String })
const TreeAnswer = Schema.Struct({
  sha: Schema.String,
  truncated: Schema.Boolean,
  tree: Schema.Array(Schema.Struct({ path: Schema.String, mode: Schema.String, sha: Schema.String }))
})
const CommitAnswer = Schema.Struct({
  sha: Schema.String,
  message: Schema.String,
  tree: Schema.Struct({ sha: Schema.String }),
  parents: Schema.Array(Schema.Struct({ sha: Schema.String }))
})
const GraphQLErrors = Schema.optionalKey(
  Schema.Array(Schema.Struct({ message: Schema.String, type: Schema.optionalKey(Schema.String) }))
)
const ObjectAnswer = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    repository: Schema.NullOr(Schema.Struct({
      object: Schema.NullOr(Schema.Struct({ __typename: Schema.String, oid: Schema.String }))
    }))
  }))),
  errors: GraphQLErrors
})
const RefsAnswer = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    repository: Schema.NullOr(Schema.Record(
      Schema.String,
      Schema.NullOr(Schema.Struct({ target: Schema.NullOr(Schema.Struct({ oid: Schema.String })) }))
    ))
  }))),
  errors: GraphQLErrors
})
const IdAnswer = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    repository: Schema.NullOr(Schema.Struct({ id: Schema.String }))
  }))),
  errors: GraphQLErrors
})
const UpdateAnswer = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    updateRefs: Schema.NullOr(Schema.Struct({ clientMutationId: Schema.NullOr(Schema.String) }))
  }))),
  errors: GraphQLErrors
})

const fail = (
  code: Repository.RepositoryErrorCode,
  method: string,
  description: string,
  refs?: ReadonlyArray<string>
) => Effect.fail(Repository.repositoryError(code, method, description, refs))

const fromIntegration = (method: string) => (error: IntegrationError): Repository.RepositoryError => {
  const status = error.details?.["status"]
  const code = status === 404 ? "not_found" : status === 422 ? "invalid" : "unavailable"
  return Repository.repositoryError(code, method, error.message)
}

const MODES: ReadonlySet<string> = new Set(["100644", "100755", "120000", "040000", "160000"])
const typeOf = (mode: Repository.Mode) => mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob"

const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.000Z$/, "Z")
const person = (who: Repository.Person) => ({ name: who.name, email: who.email, date: iso(who.seconds) })

const base64Text = (content: string): string => {
  const bytes = Uint8Array.from(atob(content.replace(/\s/g, "")), (char) => char.charCodeAt(0))
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

// A GraphQL error saying the server has no `updateRefs` mutation.
const missingMutation = (errors: ReadonlyArray<{ readonly message: string; readonly type?: string }>) =>
  errors.some((error) => /updateRefs/.test(error.message) && /doesn't exist|undefined/i.test(error.message))

/**
 * The repository `owner/repo` on GitHub as a {@link Repository.Repository},
 * over the client in context. Fails `invalid-config` when the path is not a
 * repository path.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  owner: string,
  repo: string
): Effect.Effect<Repository.Repository, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const path = yield* requireRepositoryPath(owner, repo)
    const attributes = { "github.owner": owner, "github.repo": repo }
    const traced = <A, E>(method: string, effect: Effect.Effect<A, E>) =>
      Effect.withSpan(effect, `GitHub.GitDatabase.${method}`, { attributes })
    const rest = <A>(method: string, verb: "GET" | "POST", url: string, body: unknown, schema: Schema.Schema<A>) =>
      client.request(verb, `/repos/${path}/${url}`, body, { schema: schema as Schema.Schema<any> }).pipe(
        Effect.map((answer) => answer as A),
        Effect.mapError(fromIntegration(method))
      )
    const graphql = <A>(method: string, query: string, variables: Record<string, unknown>, schema: Schema.Schema<A>) =>
      client.request("POST", "/graphql", { query, variables }, { schema: schema as Schema.Schema<any> }).pipe(
        Effect.map((answer) => answer as A),
        Effect.mapError(fromIntegration(method))
      )
    let repositoryId: string | undefined

    const readCommitById = (method: string, oid: string) =>
      Effect.map(rest(method, "GET", `git/commits/${oid}`, undefined, CommitAnswer), (commit) => ({
        oid: commit.sha,
        tree: commit.tree.sha,
        parents: commit.parents.map((parent) => parent.sha),
        message: commit.message
      }))

    const readRefs = (method: string, refs: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        yield* Repository.requireRefs(method, refs)
        const declared = refs.map((_, i) => `$r${i}: String!`).join(", ")
        const fields = refs.map((_, i) => `r${i}: ref(qualifiedName: $r${i}) { target { oid } }`).join(" ")
        const answer = yield* graphql(
          method,
          `query($owner: String!, $name: String!, ${declared}) { repository(owner: $owner, name: $name) { ${fields} } }`,
          { owner, name: repo, ...Object.fromEntries(refs.map((ref, i) => [`r${i}`, ref])) },
          RefsAnswer
        )
        const found = answer.data?.repository
        if (found === undefined || found === null) {
          return yield* fail("unavailable", method, "GitHub answered no repository")
        }
        return refs.map((ref, i): Repository.RefValue => ({ ref, oid: found[`r${i}`]?.target?.oid ?? null }))
      })

    return Repository.make({
      readBlob: (oid) =>
        traced(
          "readBlob",
          Effect.gen(function*() {
            const id = yield* Repository.requireObjectId("readBlob", oid)
            const blob = yield* rest("readBlob", "GET", `git/blobs/${id}`, undefined, BlobAnswer)
            return blob.encoding === "base64" ? base64Text(blob.content) : blob.content
          })
        ),
      writeBlob: (text) =>
        traced(
          "writeBlob",
          Effect.gen(function*() {
            if (typeof text !== "string") return yield* fail("invalid", "writeBlob", "a blob is text")
            const expected = yield* Repository.hashBlob(text)
            const answer = yield* rest(
              "writeBlob",
              "POST",
              "git/blobs",
              { content: text, encoding: "utf-8" },
              ShaAnswer
            )
            return yield* Repository.requireAnswer("writeBlob", expected, answer.sha)
          })
        ),
      readTree: (oid) =>
        traced(
          "readTree",
          Effect.gen(function*() {
            const id = yield* Repository.requireObjectId("readTree", oid)
            const tree = yield* rest("readTree", "GET", `git/trees/${id}`, undefined, TreeAnswer)
            if (tree.truncated) return yield* fail("unavailable", "readTree", "GitHub truncated the tree")
            if (!tree.tree.every((entry) => MODES.has(entry.mode))) {
              return yield* fail("unavailable", "readTree", "GitHub answered an unknown mode")
            }
            return tree.tree.map((entry): Repository.TreeEntry => ({
              name: entry.path,
              mode: entry.mode as Repository.Mode,
              oid: entry.sha
            }))
          })
        ),
      writeTree: (entries) =>
        traced(
          "writeTree",
          Effect.gen(function*() {
            yield* Repository.requireEntries("writeTree", entries)
            const expected = yield* Repository.hashTree(entries)
            // Git knows the empty tree without storing it; GitHub refuses to create one.
            if (entries.length === 0) return expected
            const tree = entries.map((entry) => ({
              path: entry.name,
              mode: entry.mode,
              type: typeOf(entry.mode),
              sha: entry.oid
            }))
            const answer = yield* rest("writeTree", "POST", "git/trees", { tree }, ShaAnswer)
            return yield* Repository.requireAnswer("writeTree", expected, answer.sha)
          })
        ),
      readCommit: (revision) =>
        traced(
          "readCommit",
          Effect.gen(function*() {
            const wanted = yield* Repository.requireRevision("readCommit", revision)
            if (Repository.isObjectId(wanted)) return yield* readCommitById("readCommit", wanted)
            const answer = yield* graphql(
              "readCommit",
              "query($owner: String!, $name: String!, $expression: String!) " +
                "{ repository(owner: $owner, name: $name) { object(expression: $expression) { __typename oid } } }",
              { owner, name: repo, expression: wanted },
              ObjectAnswer
            )
            const object = answer.data?.repository?.object
            if (object === undefined || object === null || object.__typename !== "Commit") {
              return yield* fail("not_found", "readCommit", "no commit has that id")
            }
            return yield* readCommitById("readCommit", object.oid)
          })
        ),
      writeCommit: (commit) =>
        traced(
          "writeCommit",
          Effect.gen(function*() {
            yield* Repository.requireCommit("writeCommit", commit)
            const expected = yield* Repository.hashCommit(commit)
            const answer = yield* rest("writeCommit", "POST", "git/commits", {
              message: commit.message,
              tree: commit.tree,
              parents: commit.parents,
              author: person(commit.author),
              committer: person(commit.committer)
            }, ShaAnswer)
            return yield* Repository.requireAnswer("writeCommit", expected, answer.sha)
          })
        ),
      readRefs: (refs) => traced("readRefs", readRefs("readRefs", refs)),
      updateRefs: (transaction) =>
        traced(
          "updateRefs",
          Effect.gen(function*() {
            const { operation, updates } = yield* Repository.requireTransaction("updateRefs", transaction)
            if (repositoryId === undefined) {
              const answer = yield* graphql(
                "updateRefs",
                "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }",
                { owner, name: repo },
                IdAnswer
              )
              const id = answer.data?.repository?.id
              if (id === undefined) return yield* fail("unavailable", "updateRefs", "GitHub answered no repository")
              repositoryId = id
            }
            const sent = yield* graphql(
              "updateRefs",
              "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
              {
                input: {
                  repositoryId,
                  clientMutationId: operation,
                  refUpdates: updates.map((update) => ({
                    name: update.ref,
                    beforeOid: update.before ?? ZERO,
                    afterOid: update.after ?? ZERO,
                    force: true
                  }))
                }
              },
              UpdateAnswer
            ).pipe(Effect.result)
            if (sent._tag === "Success") {
              const errors = sent.success.errors ?? []
              if (missingMutation(errors)) {
                return yield* fail("unsupported", "updateRefs", "this GitHub has no atomic updateRefs mutation")
              }
              if (
                errors.length === 0 && sent.success.data?.updateRefs !== undefined &&
                sent.success.data.updateRefs !== null
              ) {
                return
              }
            }
            // Refused or lost: what the refs hold now says which.
            const now = yield* readRefs("updateRefs", updates.map((update) => update.ref))
            const at = (ref: string) => now.find((value) => value.ref === ref)!.oid
            if (updates.every((update) => at(update.ref) === update.after)) return
            const moved = updates.filter((update) => at(update.ref) !== update.before).map((update) => update.ref)
            if (moved.length > 0) {
              return yield* fail("conflict", "updateRefs", "a ref no longer holds its old value", moved)
            }
            return yield* fail("unavailable", "updateRefs", "GitHub refused or lost the update; no ref moved")
          })
        )
    })
  }).pipe(Effect.withSpan("GitHub.GitDatabase.make", { attributes: { "github.owner": owner, "github.repo": repo } }))

/**
 * Provides {@link make} as the `Repository` layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  owner: string,
  repo: string
): Layer.Layer<Repository.Repository, IntegrationError, GitHubClient> =>
  Layer.effect(Repository.Repository)(make(owner, repo))
