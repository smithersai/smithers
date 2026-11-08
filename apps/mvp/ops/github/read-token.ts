// Operator credential boundary. Usage and audit contract: docs/features/machine-tokens.md#read-tokens.
import { Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { closeSync, constants, fchmodSync, fsyncSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
// @ts-expect-error: operator .mjs seam
import { readPrivateToken } from "../issues/githubRead.mjs"
// @ts-expect-error: operator .mjs seam
import { refuseUncheckedTls } from "../tls.mjs"

// githubRead registers the checkout's VibeLang loader before this public SDK import resolves its dependencies.
const { GitHub } = await import("@smthrs/integrations")

const PERMISSIONS = Object.freeze({ metadata: "read", issues: "read" } as const)
const NAME = /^[A-Za-z0-9_-]+$/
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
class Refused extends Error {}
type Options = {
  env?: Readonly<Record<string, string | undefined>>
  fetch?: typeof globalThis.fetch
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

/** One invocation; credentials stay inside the SDK and private files, never in an error or audit line. */
export const main = async (args = process.argv.slice(2), options: Options = {}): Promise<number> => {
  const env = options.env ?? process.env
  const fetch = options.fetch ?? globalThis.fetch
  const stdout = options.stdout ?? ((line: string) => console.log(line))
  const stderr = options.stderr ?? ((line: string) => console.error(line))
  const files: { path: string; fd: number }[] = []
  let complete = false
  let stage = "validate"
  try {
    refuseUncheckedTls(env)
    const { values } = parseArgs({ args, options: {
      owner: { type: "string" }, repo: { type: "string", multiple: true }, out: { type: "string" }, revoke: { type: "string" },
    } })
    if (values.revoke !== undefined) {
      stage = "revoke"
      const token = readPrivateToken(values.revoke)
      const response = await fetch("https://api.github.com/installation/token", {
        method: "DELETE", redirect: "manual", signal: AbortSignal.timeout(20_000),
        headers: { authorization: `token ${token}`, "user-agent": GitHub.GitHubClient.USER_AGENT,
          accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      })
      // Never read or print an error body: it could echo credentials.
      await response.body?.cancel()
      stdout(JSON.stringify({ status: response.status }))
      return response.status === 204 ? 0 : 1
    }
    const { owner, out } = values
    const repos = values.repo
    if (owner === undefined || !NAME.test(owner)) throw new Refused("--owner <owner> is required")
    if (out === undefined || out === "") throw new Refused("--out <file> is required")
    if (repos !== undefined && (repos.length > 500 || repos.some(name => !REPO.test(name)))) {
      throw new Refused("--repo must name repositories, at most 500")
    }
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Refused("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required")
    const parent = statSync(dirname(out))
    if (!parent.isDirectory() || (parent.mode & 0o022) !== 0) throw new Refused("output parent must not be group- or world-writable")
    // Reserve both new files before minting. O_EXCL refuses existing files and symlinks; cleanup touches only ours.
    for (const path of [out, `${out}.json`]) {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      files.push({ path, fd })
      fchmodSync(fd, 0o600)
    }
    stage = "authenticate"
    const issue = Effect.gen(function* () {
      const app = yield* GitHub.AppAuth.make({ appId: env.GITHUB_APP_ID!, privateKey: Redacted.make(env.GITHUB_APP_PRIVATE_KEY!) })
      const jwt = yield* app.jwt
      // Explicit empty environment: no ambient personal token or API-origin override can affect this command.
      const client = yield* GitHub.GitHubClient.make({ token: Redacted.value(jwt) }, {})
      const schema = Schema.Struct({ id: Schema.Number })
      stage = "installation"
      const installation = yield* client.request("GET", `/users/${owner}/installation`, undefined, { schema }).pipe(
        Effect.catch(error => error.details?.["status"] === 404
          ? client.request("GET", `/orgs/${owner}/installation`, undefined, { schema })
          : Effect.fail(error)),
      )
      if (!Number.isSafeInteger(installation.id) || installation.id <= 0) return yield* Effect.fail(new Refused("invalid installation response"))
      stage = "mint"
      const minted = yield* app.installationToken({ installationId: installation.id, repositories: repos, permissions: PERMISSIONS })
      return { installation: installation.id, minted }
    })
    const { installation, minted } = await Effect.runPromise(issue.pipe(
      Effect.provide(Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetch))),
    ))
    const audit = { owner, installation, repos: repos ?? null, permissions: PERMISSIONS, expires_at: new Date(minted.expiresAt).toISOString() }
    stage = "write"
    writeFileSync(files[0]!.fd, `${Redacted.value(minted.token)}\n`)
    writeFileSync(files[1]!.fd, `${JSON.stringify(audit)}\n`)
    for (const file of files) {
      fsyncSync(file.fd)
      closeSync(file.fd)
      file.fd = -1
    }
    complete = true
    stdout(JSON.stringify(audit))
    return 0
  } catch (error) {
    // A fetch, filesystem or crypto exception can include its arguments. Only our fixed validation messages are safe.
    const status = typeof error === "object" && error !== null && "details" in error
      ? (error.details as Record<string, unknown> | undefined)?.["status"] : undefined
    stderr(error instanceof Refused ? error.message : JSON.stringify({ event: "github_read_token.failed", stage,
      ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) }))
    return 1
  } finally {
    for (const file of files) {
      try {
        if (file.fd >= 0) closeSync(file.fd)
        if (!complete) unlinkSync(file.path)
      } catch {
        stderr("GitHub read token output cleanup failed")
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main()
