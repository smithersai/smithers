/**
 * The installation-specific values of the bug Worker's stack, read from the
 * environment while the stack is evaluated. Defaults name a fresh, generic
 * installation; a hosted installation keeps its own values with its private
 * deployment configuration. See README.md#deployment-configuration.
 */
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

/** One DNS label sequence with at least one dot, lowercase. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
/** A Cloudflare zone ID: 32 lowercase hex digits. */
const ZONE_ID = /^[0-9a-f]{32}$/
/** A Worker or KV namespace name Cloudflare accepts. */
const RESOURCE_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/

/** A deployment value that cannot be what its variable names. */
export class BugWorkerDeploymentInvalid extends Data.TaggedError("BugWorkerDeploymentInvalid")<{
  readonly variable: string
  readonly value: string
}> {
  override get message() {
    return `${this.variable} is not valid: ${JSON.stringify(this.value)}`
  }
}

/** The custom domain the Worker serves, with extra hostnames and an optional pinned zone. */
export interface BugWorkerHost {
  readonly name: string
  readonly aliases: ReadonlyArray<string>
  readonly zoneId: string | undefined
}

export interface BugWorkerDeployment {
  /** The Worker's physical name. */
  readonly workerName: string
  /** The KV namespace title. */
  readonly reportsNamespace: string
  /** The custom domain; none answers on workers.dev. */
  readonly host: BugWorkerHost | undefined
}

const optional = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map(Option.flatMap((value) => {
      const trimmed = value.trim()
      return trimmed === "" ? Option.none() : Option.some(trimmed)
    }))
  )

const named = (variable: string, fallback: string) =>
  Effect.gen(function*() {
    const value = Option.getOrElse(yield* optional(variable), () => fallback)
    if (!RESOURCE_NAME.test(value)) return yield* new BugWorkerDeploymentInvalid({ variable, value })
    return value
  })

/**
 * Read `BUG_WORKER_NAME`, `BUG_REPORTS_NAMESPACE`, `BUG_WORKER_DOMAIN`,
 * `BUG_WORKER_DOMAIN_ALIASES` and `BUG_WORKER_ZONE_ID`. Fails with
 * {@link BugWorkerDeploymentInvalid} on a value that cannot be a name,
 * hostname or zone ID, and on aliases or a zone without a domain.
 */
export const BugWorkerDeployment: Effect.Effect<
  BugWorkerDeployment,
  BugWorkerDeploymentInvalid | Config.ConfigError
> = Effect.gen(function*() {
  const workerName = yield* named("BUG_WORKER_NAME", "smithers-bug-worker")
  const reportsNamespace = yield* named("BUG_REPORTS_NAMESPACE", "smithers-bug-reports")
  const domain = yield* optional("BUG_WORKER_DOMAIN")
  const aliasList = yield* optional("BUG_WORKER_DOMAIN_ALIASES")
  const zoneId = yield* optional("BUG_WORKER_ZONE_ID")
  if (Option.isNone(domain)) {
    if (Option.isSome(aliasList)) {
      return yield* new BugWorkerDeploymentInvalid({ variable: "BUG_WORKER_DOMAIN_ALIASES", value: aliasList.value })
    }
    if (Option.isSome(zoneId)) {
      return yield* new BugWorkerDeploymentInvalid({ variable: "BUG_WORKER_ZONE_ID", value: zoneId.value })
    }
    return { workerName, reportsNamespace, host: undefined }
  }
  if (!HOSTNAME.test(domain.value)) {
    return yield* new BugWorkerDeploymentInvalid({ variable: "BUG_WORKER_DOMAIN", value: domain.value })
  }
  const aliases = Option.match(aliasList, {
    onNone: () => [],
    onSome: (list) => list.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")
  })
  const wrong = aliases.find((alias) => !HOSTNAME.test(alias) || alias === domain.value)
  if (wrong !== undefined) {
    return yield* new BugWorkerDeploymentInvalid({ variable: "BUG_WORKER_DOMAIN_ALIASES", value: wrong })
  }
  if (Option.isSome(zoneId) && !ZONE_ID.test(zoneId.value)) {
    return yield* new BugWorkerDeploymentInvalid({ variable: "BUG_WORKER_ZONE_ID", value: zoneId.value })
  }
  return {
    workerName,
    reportsNamespace,
    host: { name: domain.value, aliases, zoneId: Option.getOrUndefined(zoneId) }
  }
})

/**
 * The Worker's `domain` for Alchemy, or `undefined` to leave custom domains
 * unmanaged on an installation without one. A declared domain detaches every
 * live hostname it does not list.
 */
export const bugWorkerDomain = (deployment: BugWorkerDeployment) =>
  deployment.host === undefined
    ? undefined
    : {
      name: deployment.host.name,
      ...(deployment.host.aliases.length === 0 ? {} : { aliases: [...deployment.host.aliases] }),
      ...(deployment.host.zoneId === undefined ? {} : { zoneId: deployment.host.zoneId })
    }

/** The origin returned bug URLs start with: the custom domain, or the request's origin without one. */
export const publicBaseUrl = (deployment: BugWorkerDeployment): string | undefined =>
  deployment.host === undefined ? undefined : `https://${deployment.host.name}`
