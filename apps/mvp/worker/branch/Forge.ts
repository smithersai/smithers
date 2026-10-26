import { CreateRefused } from "./CreateRefused.ts"
export { CreateRefused } from "./CreateRefused.ts"
import { type CodeStorage, GitProxy, GitRemote } from "@smthrs/effect-code-storage"
import { Context, Effect, Layer, Metric, Option } from "effect"
import { type HttpClient, type HttpServerRequest, HttpServerResponse } from "effect/http"
import { repoId } from "../../src/features/repo/contract.ts"
import * as RepoConfig from "../RepoConfig.ts"

// Where a branch's git comes from (decision 0013 §2, docs/features/branch-workspace.md#the-forge): the remote and the
// read credential the host adds outside the sandbox. `branch/Track` reads a branch through it, and the branch sandbox's
// forge proxy clones through it (`GitProxy.uploadPack`). Two forges:
//
// - Code Storage, when this deployment has an organization: the repository's mirror, with a five-minute `git:read`
//   token for that one repository (`CodeStorage.gitRemote`). The repository must have been cloned, and a clone admits
//   only a public repository (docs/features/repo.md).
// - GitHub otherwise: the public repository itself, with no credential at all. `GITHUB_TOKEN` is never used here: it
//   would read every repository its owner can, private ones included, for anyone who names one. Private repositories
//   wait for per-repository GitHub App installation tokens (decision 0008 §5).

/** A GitHub repository, by its owner and name. */
export interface Repository {
  readonly owner: string
  readonly name: string
}

/**
 * The public repository on GitHub, read with no credential (`Forge.gitHub`). It can't create a branch, which needs a
 * credential this forge never holds.
 */
const gitHubForge = {
  upstream: ({ owner, name }: Repository): Effect.Effect<GitRemote.Upstream> =>
    Effect.succeed({ url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git` }),
  create: (): Effect.Effect<void, CreateRefused> => Effect.fail(new CreateRefused({ code: "not_configured" })),
  move: (): Effect.Effect<void, CreateRefused> => Effect.fail(new CreateRefused({ code: "not_configured" })),
  pull: (): Effect.Effect<void, CreateRefused> => Effect.fail(new CreateRefused({ code: "not_configured" })),
}

/** A Code Storage failure as the forge's refusal, keeping its safe cause. */
const refusedOf = (error: CodeStorage.CodeStorageError) =>
  new CreateRefused({
    errorTag: error._tag,
    errorCode: error.code,
    ...(error.status === undefined ? {} : { errorStatus: error.status }),
    code: error.status === 401 || error.status === 403
      ? "forbidden"
      : error.code === "conflict"
      ? "exists"
      : ["not_found", "repository_not_found", "ref_not_found", "branch_not_found"].includes(error.code)
      ? "not_found"
      : "unavailable",
  })

/** The remote a branch's git is read from, with its credential. */
export class Forge extends Context.Service<
  Forge,
  {
    readonly upstream: (repository: Repository, namespace?: CodeStorage.RefNamespace) => Effect.Effect<GitRemote.Upstream>
    /** Creates `branch` at the commit `from` names, on the forge. */
    readonly create: (repository: Repository, branch: string, from: string) => Effect.Effect<void, CreateRefused>
    /**
     * Moves ephemeral `branch` to commit `to`, fast-forward or not: a resync brings a Smithers branch to the head its
     * GitHub branch reached ([branch publish](../../docs/features/branch-publish.md#resync)). A commit the mirror hasn't
     * synced yet is `not_found`.
     */
    readonly move: (repository: Repository, branch: string, to: string) => Effect.Effect<void, CreateRefused>
    /** Starts the mirror's sync from GitHub. One already running is no failure. */
    readonly pull: (repository: Repository) => Effect.Effect<void, CreateRefused>
  }
>()("@smthrs/mvp/branch/Forge") {
  /**
   * The repository's Code Storage mirror: read with a `git:read` token, and a new branch made or moved there with a
   * `git:write` one in the ephemeral namespace (`CodeStorage.createBranch`). Ordinary mirror refs are read-only.
   * Nothing reaches GitHub until a person explicitly publishes (Will, 2026-10-23 14:09).
   */
  static readonly codeStorage = (client: CodeStorage.Client) =>
    Layer.succeed(
      Forge,
      Forge.of({
        upstream: ({ owner, name }, namespace) => client.gitRemote(repoId(owner, name), namespace),
        create: ({ owner, name }, branch, from) =>
          client.createBranch(repoId(owner, name), { branch, from, namespace: "ephemeral" }).pipe(
            Effect.asVoid,
            Effect.mapError(refusedOf),
          ),
        // The commit is any the repository holds: a mirror's GitHub branch shares its objects with the ephemeral refs.
        move: ({ owner, name }, branch, to) =>
          client.createBranch(repoId(owner, name), { branch, from: to, namespace: "ephemeral", force: true }).pipe(
            Effect.asVoid,
            Effect.mapError(refusedOf),
          ),
        pull: ({ owner, name }) =>
          client.pullUpstream(repoId(owner, name)).pipe(
            Effect.catchIf((error) => error.code === "sync_in_progress", () => Effect.void),
            Effect.mapError(refusedOf),
          ),
      }),
    )

  /**
   * The public repository on GitHub, read with no credential: GitHub answers a private one as missing. It can't create
   * a branch, which needs a credential this forge never holds.
   */
  static readonly gitHub = Layer.succeed(Forge, gitHubForge)

  /**
   * Code Storage when `CODE_STORAGE_ORG` and `CODE_STORAGE_KEY` are set, else GitHub with no credential. A branch that
   * lives on GitHub reads GitHub whichever this is (`forgeOf`).
   */
  static readonly layerConfig: Layer.Layer<Forge, never, HttpClient.HttpClient> = Layer.unwrap(
    Effect.map(RepoConfig.codeStorage, (client) => (Option.isSome(client) ? Forge.codeStorage(client.value) : Forge.gitHub)),
  )
}

/** A branch's commit on its forge, through the forge's credential: `ref_not_found` when it has no such branch. */
export const branchHead = (repository: Repository, branch: string, namespace: CodeStorage.RefNamespace = "default") =>
  Effect.flatMap(Forge, (forge) =>
    Effect.flatMap(forge.upstream(repository, namespace), (upstream) => GitRemote.ref(upstream, branch)))

/** Creates `branch` on the repository's forge at the commit `from` names. */
export const createBranch = (repository: Repository, branch: string, from: string) =>
  Effect.flatMap(Forge, (forge) => forge.create(repository, branch, from)).pipe(
    Effect.tapError((error) => {
      const fields = failureFields("create_ref", error)
      return Effect.annotateCurrentSpan(fields).pipe(
        Effect.andThen(Effect.logWarning("forge.createBranch").pipe(Effect.annotateLogs(fields))),
      )
    }),
    Effect.withSpan("forge.createBranch"),
  )

/** Safe typed error metadata only: never a URL, branch, credential, message or raw cause. */
export const failureFields = (
  operation: "default_branch" | "create_ref" | "refs_read",
  error: CreateRefused | GitRemote.GitRemoteError,
): Record<string, string | number> => {
  const cause = error instanceof CreateRefused
    ? { _tag: error.errorTag ?? error._tag, code: error.errorCode ?? error.code, status: error.errorStatus }
    : error
  return {
    forgeOperation: operation,
    forgeErrorTag: cause._tag,
    forgeErrorCode: cause.code,
    ...(cause.status === undefined ? {} : { forgeStatus: cause.status }),
  }
}

/** The repository's default branch on its forge. */
export const defaultBranch = (repository: Repository) =>
  Effect.flatMap(Forge, (forge) =>
    Effect.flatMap(forge.upstream(repository), (upstream) => GitRemote.head(upstream)))

/**
 * The forge a branch's machine checks `branch` out through: GitHub for what lives there (`forge: "github"`, a TODO's
 * attempt, which checks out its base commit, its branch made on GitHub only by `todo/Publish`), else `deployment`, the
 * deployment's own forge.
 * With Code Storage the deployment's forge is the mirror, which never holds a branch made on GitHub after its last pull.
 */
export const forgeOf = (deployment: Forge["Service"], branch: { readonly forge?: "github" | undefined; readonly namespace?: CodeStorage.RefNamespace | undefined }): Forge["Service"] =>
  branch.forge === "github" ? gitHubForge : {
    ...deployment,
    upstream: (repository) => deployment.upstream(repository, branch.namespace),
  }

/**
 * Guest Git traffic must not expose other conversations in a shared ephemeral namespace.
 * The SDK advertises only the persisted branch and authorizes its current tip. A missing branch
 * is refused before obtaining its credential.
 */
export const proxy = (
  request: HttpServerRequest.HttpServerRequest,
  deployment: Forge["Service"],
  branch: Repository & { readonly branch?: string | undefined; readonly forge?: "github" | undefined; readonly namespace?: CodeStorage.RefNamespace | undefined },
) => Effect.gen(function* () {
  if (branch.namespace === "ephemeral" && branch.branch === undefined) {
    const service = GitProxy.classify(request.method, request.url) ?? "refused"
    yield* Metric.update(Metric.withAttributes(GitProxy.requests, { service, outcome: "refused" }), 1)
    yield* Effect.annotateCurrentSpan({
      "git.proxy.service": service,
      "http.response.status_code": 403,
      outcome: "namespace_unscoped",
    })
    yield* Effect.logWarning("sandbox.forge").pipe(
      Effect.annotateLogs({ status: 403, outcome: "namespace_unscoped" }),
    )
    return HttpServerResponse.empty({ status: 403 })
  }
  const remote = yield* forgeOf(deployment, branch).upstream(branch)
  return yield* GitProxy.uploadPack(request, remote, branch.namespace === "ephemeral" ? branch.branch : undefined)
}).pipe(Effect.withSpan("sandbox.forge", { kind: "server" }))
