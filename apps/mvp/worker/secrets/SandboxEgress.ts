import { withUserAgent } from "../github/Http.ts"
import { Binding, Egress } from "@smthrs/secrets"
import { Config, Effect, Layer, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { KEY_REFUSALS } from "../../src/features/personal-model/contract.ts"
import { repoId } from "../../src/features/repo/contract.ts"
import * as RegistryEgress from "../branch/RegistryEgress.ts"
import * as Store_ from "../personal/Store.ts"
import * as Subscriptions from "../personal/Subscriptions.vibe"
import * as Overflow from "../runners/Overflow.ts"
import { type Keys, SecretKeys } from "./Keys.vibe"
import * as Store from "./Store.ts"

// A branch sandbox's egress (decision 0005 §4, docs/features/secrets.md#the-egress): what the box's outbound HTTP
// reaches, outside the box. The box holds placeholders only (`environment`, written into it when it wakes); its
// requests come here, and `@smthrs/secrets`' `Egress.forward` swaps each placeholder for its value only for that
// secret's own hosts and methods, never follows a redirect, records each decision in `secret_events` before sending,
// and scrubs echoes from the answer.
//
// Placeholders are derived per guest, a repository's branch at one generation of its machine, so a new generation's box
// gets new ones and the old ones are refused. Values are opened per request, in memory, from the sealed rows read with
// the request's policy.
//
// A box that runs for a plugin installation (decision 0017 §10, "The egress narrows to the grant") holds only what an
// Admin granted that installation: its policy is the repository's secrets its grant names and the origins its grant
// names, and its placeholders are derived in a scope that includes the installation. Every request of its box must
// name exactly one of its granted origins, scheme, host and port (`refusal`), before a secret row is read or a value
// opened; a secret is held only when the grant names both it and an origin of its binding. An installation with no
// grant binding holds no placeholder and reaches no host, and one installation's placeholder is refused from another's
// box. The guest's kind is explicit (`Guest`): a branch's machine builds branch guests, and nothing else is one.
//
// Wired by the branch's `SandboxObject` (worker/BranchSandboxes.ts) when SANDBOX_SECRETS is on, off by default: it routes
// the box's outbound HTTP and HTTPS here and writes `environment` into the box when it wakes. Off, no box reaches a
// secret: its requests go to the registry egress (worker/branch/RegistryEgress.ts), and a check job's always do.

/** Where Cloudflare puts the container's per-instance CA, which signs the HTTPS the egress decrypts. */
export const CONTAINER_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"

/**
 * The container's CA trusted when Cloudflare provides it: system-wide (curl, git, pip, Go), and through a profile every
 * login shell sources (tmux starts one), by Node and dprint (`RegistryEgress.trustOf`). Exit 2 when it couldn't be.
 */
const trustLines = [
  `[ -f ${CONTAINER_CA} ] || exit 0`,
  `printf '%s\\n' ${
    Object.entries(RegistryEgress.trustOf(CONTAINER_CA)).map(([name, value]) => `'export ${name}=${value}'`).join(" ")
  } >/etc/profile.d/smithers-trust.sh || exit 2`,
  `cp ${CONTAINER_CA} /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates || exit 2`,
  "exit 0",
]

/**
 * Run as root in a box without secrets on each wake: its tools trust the container's CA (`trustLines`), so its HTTPS
 * through the registry egress (worker/branch/RegistryEgress.ts) is trusted. It writes no environment file: the box
 * holds no placeholder. Exit 2 when the CA couldn't be trusted. It prints nothing, whatever fails: workerd reports a
 * command's exit only once its output is read or closed, and nobody reads this one's.
 */
export const TRUST = ["exec >/dev/null 2>&1", "umask 022", ...trustLines].join("\n")

/**
 * Run as root in a box on each wake with the egress on: the box's environment file (`environment`) from stdin, readable
 * by every user and sourced by every login shell (tmux starts one), then the container's CA trusted as `TRUST` trusts
 * it; exit 1 without the environment, 2 when the CA couldn't be trusted. It prints nothing, as `TRUST` doesn't.
 */
export const SETUP = [
  "exec >/dev/null 2>&1",
  "umask 022",
  "mkdir -p /run/smithers && cat >/run/smithers/env.tmp && mv -f /run/smithers/env.tmp /run/smithers/env || exit 1",
  `printf '%s\\n' '[ -r /run/smithers/env ] && { set -a; . /run/smithers/env; set +a; }' >/etc/profile.d/smithers-env.sh || exit 1`,
  ...trustLines,
].join("\n")

/** Where a box runs: a repository's branch, at one generation of its machine. */
interface Place {
  readonly repoId: string
  readonly branchId: string
  readonly generation: number
}

/** A branch's own box: it holds its repository's secrets and reaches the deployment's allowed hosts. */
export interface BranchGuest extends Place {
  readonly kind: "branch"
}

/**
 * What an Admin granted one plugin installation, read by the host that assigned the box: the secret names it may hold
 * and the origins (`https://host`, scheme and port included) it may reach. Never read from the box.
 */
export interface Grant {
  readonly secrets: ReadonlySet<string>
  readonly origins: ReadonlySet<string>
}

/**
 * A box running for one plugin installation. `grant` is the installation's active Admin grant as the host bound it to
 * this box; `undefined` is a box with no grant binding, which holds nothing and whose every request is refused.
 */
export interface InstallationGuest extends Place {
  readonly kind: "installation"
  readonly installationId: string
  readonly grant: Grant | undefined
}

/**
 * The guest a request comes from. The two kinds are told apart by `kind`, never by a missing field: a guest that says
 * nothing of an installation is not thereby a branch's own box.
 */
export type Guest = BranchGuest | InstallationGuest

/**
 * The guest a branch's own box is at `generation`: its repository's row id, which is lowercase (`repoId`) as the
 * secrets' rows are, so a branch of `octocat/Spoon-Knife` reaches the secrets an Admin stored for it.
 */
export const guestOf = (
  branch: { readonly owner: string; readonly name: string; readonly branchId: string },
  generation: number,
): BranchGuest => ({ kind: "branch", repoId: repoId(branch.owner, branch.name), branchId: branch.branchId, generation })

/**
 * The guest a box is when it runs for the plugin installation `installationId` under `grant`, the grant the host bound
 * to the box's assignment. No production caller builds one yet: no Admin grant store exists, so a branch's machine
 * (worker/BranchSandboxes.ts) builds branch guests only. A caller that has no grant to pass passes `undefined`, and
 * the box fails closed.
 */
export const installationGuestOf = (
  branch: { readonly owner: string; readonly name: string; readonly branchId: string },
  generation: number,
  installationId: string,
  grant: Grant | undefined,
): InstallationGuest => ({
  kind: "installation",
  repoId: repoId(branch.owner, branch.name),
  branchId: branch.branchId,
  generation,
  installationId,
  grant,
})

/**
 * The scope a guest's placeholders are derived in: the repository, the branch and the generation, and the plugin
 * installation when it runs for one, so no two installations derive the same placeholder for a name.
 */
export const scopeOf = (guest: Guest): string =>
  JSON.stringify([
    guest.repoId,
    guest.branchId,
    guest.generation,
    ...(guest.kind === "branch" ? [] : [guest.installationId]),
  ])

/**
 * The canonical origin `text` names, scheme, host and effective port (`URL.origin`): `undefined` for anything but an
 * http or https URL with no credentials. `HTTPS://API.Example.com:443/v1` and `https://api.example.com` are one origin;
 * `http://api.example.com` and `https://api.example.com:8443` are two others.
 */
export const canonicalOrigin = (text: string): string | undefined => {
  const url = URL.parse(text)
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return undefined
  if (url.username !== "" || url.password !== "") return undefined
  return url.origin
}

/**
 * The origins a plugin installation's grant names, canonical. An entry that is not exactly an origin, a bare host, a
 * URL with a path, query or fragment, or one with credentials, grants nothing.
 */
export const grantedOrigins = (guest: InstallationGuest): ReadonlySet<string> =>
  new Set(
    [...(guest.grant?.origins ?? [])].flatMap((entry) => {
      const url = URL.parse(entry)
      const origin = canonicalOrigin(entry)
      return origin === undefined || url === null || url.pathname !== "/" || url.search !== "" || url.hash !== "" ? [] : [origin]
    }),
  )

/**
 * Whether the guest may hold the secret `name`: any of its repository's for a branch's own box; for a plugin
 * installation, only a name its grant holds, and none without a grant binding.
 */
export const grants = (guest: Guest, name: string): boolean =>
  guest.kind === "branch" || (guest.grant?.secrets.has(name) ?? false)

/**
 * The hosts the guest reaches with no secret: `allow` for a branch's own box; for a plugin installation, the hosts of
 * its granted origins alone, so the deployment's allowance never widens a grant. This is the host half only: `refusal`
 * has already required the request's exact origin, scheme and port included.
 */
export const reachable = (guest: Guest, allow: ReadonlyArray<string>): ReadonlyArray<string> =>
  guest.kind === "branch" ? allow : [...new Set([...grantedOrigins(guest)].map((origin) => new URL(origin).hostname))]

/**
 * The hosts a secret bound to `hosts` may be sent to from the guest's box: its binding's for a branch's own box; for a
 * plugin installation, only those its grant also names as an `https` origin on the default port, the one origin a
 * secret is ever sent to. A granted secret whose binding names no granted origin is bound to nowhere.
 */
export const boundHosts = (guest: Guest, hosts: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (guest.kind === "branch") return hosts
  const origins = grantedOrigins(guest)
  return hosts.filter((host) => origins.has(`https://${host}`))
}

/** Why a plugin installation's request is refused before any policy is read: a typed code, answered 403. */
export type GrantRefusal = "grant_missing" | "origin_not_granted"

/**
 * Whether the guest's request to `url` is refused by its grant, before any secret row is read, any value opened or
 * anything sent: never for a branch's own box; for a plugin installation, `grant_missing` when no grant is bound to its
 * box and `origin_not_granted` unless the request's canonical origin, scheme, host and port, is exactly one its grant
 * names.
 */
export const refusal = (guest: Guest, url: string): GrantRefusal | undefined => {
  if (guest.kind === "branch") return undefined
  if (guest.grant === undefined) return "grant_missing"
  const origin = canonicalOrigin(url)
  return origin !== undefined && grantedOrigins(guest).has(origin) ? undefined : "origin_not_granted"
}

/**
 * The hosts a box may reach with no secret: the package registries every box reaches (`RegistryEgress.HOSTS`), so
 * turning secrets on never loses them, and `EGRESS_ALLOW_HOSTS`, comma-separated, none by default; a host that isn't a
 * lowercase DNS name is dropped.
 */
export const allowHosts = Config.String("EGRESS_ALLOW_HOSTS").pipe(
  Config.withDefault(""),
  Config.map((hosts: string): ReadonlyArray<string> => [
    ...new Set([...RegistryEgress.HOSTS, ...hosts.split(",").map((host) => host.trim()).filter(Binding.isHost)]),
  ]),
)

/**
 * The guest's policy: every secret of its repository it may hold (`grants`) with the placeholder derived for it and
 * the hosts it may be sent to (`boundHosts`), and the hosts it reaches with none (`reachable`); and each of those
 * secrets' sealed value, read with its binding, which is the only value a request under this policy opens. A secret
 * outside a plugin installation's grant, or bound to no origin of it, is in neither.
 */
export const policyFor = (guest: Guest, keys: Keys, allow: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const scope = scopeOf(guest)
    // A box with no grant binding reads no row at all.
    if (guest.kind === "installation" && guest.grant === undefined) {
      return { policy: { secrets: [], allow: [] } satisfies Egress.Policy, sealed: new Map<string, Store.Sealed>() }
    }
    // The grant's secrets and the grant's origins, both: a granted secret bound to no granted origin is not held.
    const stored = (yield* Store.secrets(guest.repoId))
      .filter((secret) => grants(guest, secret.name))
      .map((secret) => ({ secret, hosts: boundHosts(guest, secret.hosts) }))
      .filter((held) => held.hosts.length > 0)
    const secrets = yield* Effect.forEach(stored, ({ secret: binding, hosts }) =>
      Effect.map(keys.minter.derive(scope, binding.name), (placeholder): Egress.Secret => ({
        name: binding.name,
        placeholder,
        hosts,
        ...(binding.methods === null ? {} : { methods: binding.methods }),
      })))
    const sealed: ReadonlyMap<string, Store.Sealed> = new Map(stored.map(({ secret }) => [secret.name, secret]))
    return { policy: { secrets, allow: reachable(guest, allow) } satisfies Egress.Policy, sealed }
  })

/**
 * The box's environment file: one `NAME=placeholder` line per secret, for its machine to write when it wakes. Empty when
 * secrets are off.
 */
export const environment = (guest: Guest) =>
  Effect.gen(function* () {
    const keys = yield* SecretKeys
    if (Option.isNone(keys)) return ""
    const { policy } = yield* policyFor(guest, keys.value, [])
    return policy.secrets.map((secret) => `${secret.name}=${secret.placeholder}\n`).join("")
  })

/** The name a person's subscription goes by in a box's policy and in `secret_events`: its connection, never a value. */
const subscriptionName = (subscription: Subscriptions.Subscription) => `connection:${subscription.connectionId}`

/** The placeholder the guest's box holds for `subscription`. */
export const subscriptionPlaceholder = (guest: Guest, keys: Keys, subscription: Subscriptions.Subscription) =>
  keys.minter.derive(scopeOf(guest), subscriptionName(subscription))

/**
 * Answers one request a `todo` box sent to its committer's vendor host: `Egress.forward` under the guest's own policy
 * plus the person's credential, so a repository secret bound to that host keeps working. The credential opens per
 * request from the sealed row and never enters the box (ARCH-16). Only a request that used it says anything of the
 * connection: the vendor's refusal marks it, its answer clears it. `unavailable` (503) when the policy can't be read.
 */
export const forwardSubscription = (
  guest: Guest,
  subscription: Subscriptions.Subscription,
  allow: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const keys = yield* SecretKeys
    if (Option.isNone(keys)) return HttpServerResponse.text("off", { status: 503 })
    const name = subscriptionName(subscription)
    const placeholder = yield* subscriptionPlaceholder(guest, keys.value, subscription)
    const request = yield* HttpServerRequest.HttpServerRequest
    const sql = yield* SqlClient.SqlClient
    const ungranted = yield* refuseUngranted(guest, request, sql)
    if (ungranted !== undefined) return ungranted
    const repository = yield* policyFor(guest, keys.value, allow).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.option,
    )
    if (Option.isNone(repository)) {
      yield* Effect.logWarning("secrets.egress").pipe(
        Effect.annotateLogs({ egress: "subscription", outcome: "unavailable", errorCode: "policy" }),
      )
      return HttpServerResponse.text("unavailable", { status: 503 })
    }
    // A plugin installation's box gets the person's credential only when its grant names it, and only toward the
    // vendor hosts its grant also names as origins.
    const vendorHosts = boundHosts(guest, subscription.hosts)
    const policy: Egress.Policy = {
      secrets: [
        ...repository.value.policy.secrets,
        ...(grants(guest, name) && vendorHosts.length > 0 ? [{ name, placeholder, hosts: vendorHosts }] : []),
      ],
      allow: repository.value.policy.allow,
    }
    const decision = Egress.decide({ method: request.method, url: request.originalUrl, headers: request.headers }, policy)
    const usedIt = decision._tag === "Allowed" && decision.used.some((secret) => secret.name === name)
    const repositoryValue = revealer(guest, keys.value, repository.value.sealed)
    const opened = Layer.succeed(
      Egress.Vault,
      Egress.Vault.of({
        reveal: (asked) =>
          asked !== name
            ? repositoryValue(asked)
            : Subscriptions.reveal(subscription.personId, subscription.connectionId, keys.value).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.flatMap(Option.match({
                onNone: () => Effect.fail(new Egress.SecretUnavailable({ name })),
                onSome: Effect.succeed,
              })),
              Effect.catch(() => Effect.fail(new Egress.SecretUnavailable({ name }))),
            ),
      }),
    )
    const response = yield* Egress.forward(request, policy).pipe((effect) => withUserAgent(effect, true), Effect.provide(Layer.merge(opened, audit(guest, sql))))
    const refused = KEY_REFUSALS.includes(response.status) && response.status !== 429
    if (usedIt && (refused || (response.status >= 200 && response.status < 300))) {
      yield* Store_.markConnection(subscription.personId, subscription.connectionId, refused ? response.status : undefined).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.ignore,
      )
    }
    return response
  }).pipe(Effect.withSpan("secrets.egress.subscription", { attributes: { "smithers.branch.id": guest.branchId } }))

/** The names a repository's overflow box's credentials go by in its policy and in `secret_events`: never a value. */
const OVERFLOW_TOKEN = "overflow:runner-token"

/** The overflow box's credentials: its runner's token and the Admin's API key, as `forwardOverflow` binds them. */
export interface OverflowCredentials {
  readonly repoId: string
  /** The deployment's origin: the runner token's one host. */
  readonly origin: string
  readonly token: { readonly ciphertext: string; readonly nonce: string; readonly keyVersion: number }
  /** The Admin's API-key connection, and its base URL: the key's one host. */
  readonly personId: string
  readonly connectionId: string
  readonly baseUrl: string
}

/** The placeholders an overflow box at `guest` holds: one for the runner's token, one for the API key. */
export const overflowPlaceholders = (guest: Guest, keys: Keys, overflow: Pick<OverflowCredentials, "connectionId">) =>
  Effect.all({
    token: keys.minter.derive(scopeOf(guest), OVERFLOW_TOKEN),
    key: keys.minter.derive(scopeOf(guest), `connection:${overflow.connectionId}`),
  })

/**
 * Answers one request a repository's overflow box sent (decision 0144): `Egress.forward` under a policy of the box's two
 * credentials alone, its runner's token bound to this deployment's host and the Admin's API key bound to its base URL's
 * host, plus `allow`. Each opens per request from its sealed row and never enters the box: the same placeholders,
 * substitution, refusals, scrubbing and audit as a subscription's (`forwardSubscription`), for a BYOK key. The box
 * gets no repository secret: it runs no branch's code. `unavailable` (503), logged as `secrets.egress`, when a stored
 * credential's URL names no host: nothing is forwarded under a policy that binds a credential to nowhere.
 */
export const forwardOverflow = (guest: Guest, overflow: OverflowCredentials, allow: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const keys = yield* SecretKeys
    if (Option.isNone(keys)) return HttpServerResponse.text("off", { status: 503 })
    // A stored URL that doesn't parse is a refusal with a record, never a defect.
    const tokenHost = URL.parse(overflow.origin)?.hostname ?? ""
    const keyHost = URL.parse(overflow.baseUrl)?.hostname ?? ""
    if (tokenHost === "" || keyHost === "") {
      yield* Effect.logWarning("secrets.egress").pipe(
        Effect.annotateLogs({
          egress: "overflow",
          outcome: "unavailable",
          errorCode: tokenHost === "" ? "overflow_origin" : "overflow_base_url",
        }),
      )
      return HttpServerResponse.text("unavailable", { status: 503 })
    }
    const request = yield* HttpServerRequest.HttpServerRequest
    const sql = yield* SqlClient.SqlClient
    const ungranted = yield* refuseUngranted(guest, request, sql)
    if (ungranted !== undefined) return ungranted
    const placeholders = yield* overflowPlaceholders(guest, keys.value, overflow)
    const keyName = `connection:${overflow.connectionId}`
    // An overflow box runs for no plugin installation; one that did would hold only what its grant names, bound only
    // to the origins its grant names.
    const policy: Egress.Policy = {
      secrets: [
        { name: OVERFLOW_TOKEN, placeholder: placeholders.token, hosts: boundHosts(guest, [tokenHost]) },
        { name: keyName, placeholder: placeholders.key, hosts: boundHosts(guest, [keyHost]) },
      ].filter((secret) => grants(guest, secret.name) && secret.hosts.length > 0),
      allow: reachable(guest, allow),
    }
    const unavailable = (name: string) => () => Effect.fail(new Egress.SecretUnavailable({ name }))
    const vault = Layer.succeed(
      Egress.Vault,
      Egress.Vault.of({
        reveal: (asked) =>
          asked === OVERFLOW_TOKEN
            ? keys.value.cipher.open(overflow.token, Overflow.tokenContext(overflow.repoId, overflow.token.keyVersion))
              .pipe(Effect.catch(unavailable(asked)))
            // Egress.forward reveals exactly policy.secrets: this private vault has only the token and this key.
            : Subscriptions.reveal(overflow.personId, overflow.connectionId, keys.value).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.flatMap(Option.match({ onNone: unavailable(asked), onSome: Effect.succeed })),
              Effect.catch(unavailable(asked)),
            ),
      }),
    )
    return yield* Egress.forward(request, policy).pipe((effect) => withUserAgent(effect, true), Effect.provide(Layer.merge(vault, audit(guest, sql))))
  }).pipe(Effect.withSpan("secrets.egress.overflow", { attributes: { "smithers.branch.id": guest.branchId } }))

/**
 * Opens one of a guest's values from the sealed row its policy read (`policyFor`), never a row read again: a secret
 * replaced since sends its old value to its old binding's hosts, never its new value there.
 */
const revealer = (guest: Guest, keys: Keys, sealed: ReadonlyMap<string, Store.Sealed>) => (name: string) =>
  Effect.fromNullishOr(sealed.get(name)).pipe(
    Effect.flatMap((row) => keys.cipher.open(row, { id: guest.repoId, name, version: row.keyVersion })),
    Effect.catch(() => Effect.fail(new Egress.SecretUnavailable({ name }))),
  )

/** Opens a guest's values from the sealed rows its policy read, one per request. */
const vault = (guest: Guest, keys: Keys, sealed: ReadonlyMap<string, Store.Sealed>) =>
  Layer.succeed(Egress.Vault, Egress.Vault.of({ reveal: revealer(guest, keys, sealed) }))

/** The scope a guest's decisions are recorded under: its branch and generation, and its plugin installation when it runs for one. */
export const auditScope = (guest: Guest): string =>
  [guest.branchId, guest.generation, ...(guest.kind === "branch" ? [] : [guest.installationId])].join(":")

/** Records a guest's decisions in `secret_events`, through `sql`. */
const audit = (guest: Guest, sql: SqlClient.SqlClient) =>
  Layer.succeed(
    Egress.Audit,
    Egress.Audit.of({
      record: (entry) =>
        Store.recordUse({
          repoId: guest.repoId,
          scope: auditScope(guest),
          host: entry.host,
          method: entry.method,
          outcome: entry.outcome,
          names: entry.secrets,
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch(() => Effect.fail(new Egress.AuditUnavailable())),
        ),
    }),
  )

/**
 * Answers a plugin installation's request its grant refuses (`refusal`), before its policy is read: the refusal's code
 * as text, 403, logged as `secrets.egress` and recorded in `secret_events` first, `unavailable` (503) when the record
 * can't be written. `undefined` when the grant admits the request, and always for a branch's own box.
 */
const refuseUngranted = (guest: Guest, request: HttpServerRequest.HttpServerRequest, sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const code = refusal(guest, request.originalUrl)
    if (code === undefined) return undefined
    yield* Effect.logWarning("secrets.egress").pipe(Effect.annotateLogs({ outcome: "refused", errorCode: code }))
    const recorded = yield* Store.recordUse({
      repoId: guest.repoId,
      scope: auditScope(guest),
      host: URL.parse(request.originalUrl)?.hostname ?? "",
      method: request.method,
      outcome: code,
      names: [],
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.as(true), Effect.catch(() => Effect.succeed(false)))
    return recorded ? HttpServerResponse.text(code, { status: 403 }) : HttpServerResponse.text("unavailable", { status: 503 })
  })

/**
 * Answers one of the guest's outbound requests: `Egress.forward` under its policy, with values opened and decisions
 * recorded through `database`'s `SqlClient` in the caller's context. `off` (503) when secrets are off, `unavailable`
 * (503) when its policy can't be read.
 */
export const forward = (guest: Guest, allow: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const keys = yield* SecretKeys
    if (Option.isNone(keys)) return HttpServerResponse.text("off", { status: 503 })
    const request = yield* HttpServerRequest.HttpServerRequest
    const sql = yield* SqlClient.SqlClient
    const ungranted = yield* refuseUngranted(guest, request, sql)
    if (ungranted !== undefined) return ungranted
    const read = yield* policyFor(guest, keys.value, allow).pipe(Effect.option)
    if (Option.isNone(read)) {
      yield* Effect.logWarning("secrets.egress").pipe(Effect.annotateLogs({ outcome: "unavailable", errorCode: "policy" }))
      return HttpServerResponse.text("unavailable", { status: 503 })
    }
    return yield* Egress.forward(request, read.value.policy).pipe(
      (effect) => withUserAgent(effect, true),
      Effect.provide(Layer.merge(vault(guest, keys.value, read.value.sealed), audit(guest, sql))),
    )
  }).pipe(
    Effect.withSpan("secrets.egress", {
      attributes: { "smithers.branch.id": guest.branchId, "smithers.sandbox.generation": guest.generation },
    }),
  ) satisfies Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | SecretKeys | SqlClient.SqlClient | HttpClient.HttpClient
  >
