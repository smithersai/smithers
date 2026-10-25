import { Binding, Egress } from "@smthrs/secrets"
import { Config, Effect, Layer, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { repoId } from "../../src/features/repo/contract.ts"
import * as RegistryEgress from "../branch/RegistryEgress.ts"
import { type Keys, SecretKeys } from "./Keys.ts"
import * as Store from "./Store.ts"

// A branch sandbox's egress (decision 0005 §4, docs/features/secrets.md#the-egress): what the box's outbound HTTP
// reaches, outside the box. The box holds placeholders only (`environment`, written into it when it wakes); its
// requests come here, and `@smthrs/secrets`' `Egress.forward` swaps each placeholder for its value only for that
// secret's own hosts and methods, never follows a redirect, records each decision in `secret_events` before sending,
// and scrubs echoes from the answer.
//
// Placeholders are derived per guest, a repository's branch at one generation of its machine, so a new generation's box
// gets new ones and the old ones are refused. Values are opened per request, in memory, from the sealed rows.
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

/** The guest a request comes from: a repository's branch, at one generation of its machine. */
export interface Guest {
  readonly repoId: string
  readonly branchId: string
  readonly generation: number
}

/**
 * The guest a branch's box is at `generation`: its repository's row id, which is lowercase (`repoId`) as the secrets'
 * rows are, so a branch of `octocat/Spoon-Knife` reaches the secrets an Admin stored for it.
 */
export const guestOf = (
  branch: { readonly owner: string; readonly name: string; readonly branchId: string },
  generation: number,
): Guest => ({ repoId: repoId(branch.owner, branch.name), branchId: branch.branchId, generation })

/** The scope a guest's placeholders are derived in: the repository, the branch and the generation. */
export const scopeOf = (guest: Guest): string => JSON.stringify([guest.repoId, guest.branchId, guest.generation])

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

/** The guest's policy: every secret of its repository with the placeholder derived for it, and `allow`. */
export const policyFor = (guest: Guest, keys: Keys, allow: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const scope = scopeOf(guest)
    const secrets = yield* Effect.forEach(yield* Store.bindings(guest.repoId), (binding) =>
      Effect.map(keys.minter.derive(scope, binding.name), (placeholder): Egress.Secret => ({
        name: binding.name,
        placeholder,
        hosts: binding.hosts,
        ...(binding.methods === null ? {} : { methods: binding.methods }),
      })))
    return { secrets, allow } satisfies Egress.Policy
  })

/**
 * The box's environment file: one `NAME=placeholder` line per secret, for its machine to write when it wakes. Empty when
 * secrets are off.
 */
export const environment = (guest: Guest) =>
  Effect.gen(function* () {
    const keys = yield* SecretKeys
    if (Option.isNone(keys)) return ""
    const { secrets } = yield* policyFor(guest, keys.value, [])
    return secrets.map((secret) => `${secret.name}=${secret.placeholder}\n`).join("")
  })

/** Opens a guest's values from their sealed rows, one per request, through `sql`. */
const vault = (guest: Guest, keys: Keys, sql: SqlClient.SqlClient) =>
  Layer.succeed(
    Egress.Vault,
    Egress.Vault.of({
      reveal: (name) =>
        Effect.gen(function* () {
          const sealed = yield* Store.sealed(guest.repoId, name)
          return yield* keys.cipher.open(sealed, { id: guest.repoId, name, version: sealed.keyVersion })
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch(() => Effect.fail(new Egress.SecretUnavailable({ name }))),
        ),
    }),
  )

/** Records a guest's decisions in `secret_events`, through `sql`. */
const audit = (guest: Guest, sql: SqlClient.SqlClient) =>
  Layer.succeed(
    Egress.Audit,
    Egress.Audit.of({
      record: (entry) =>
        Store.recordUse({
          repoId: guest.repoId,
          scope: `${guest.branchId}:${guest.generation}`,
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
 * Answers one of the guest's outbound requests: `Egress.forward` under its policy, with values opened and decisions
 * recorded through `database`'s `SqlClient` in the caller's context. `off` (503) when secrets are off, `unavailable`
 * (503) when its policy can't be read.
 */
export const forward = (guest: Guest, allow: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const keys = yield* SecretKeys
    if (Option.isNone(keys)) return HttpServerResponse.text("off", { status: 503 })
    const policy = yield* policyFor(guest, keys.value, allow).pipe(Effect.option)
    if (Option.isNone(policy)) {
      yield* Effect.logWarning("secrets.egress").pipe(Effect.annotateLogs({ outcome: "unavailable", errorCode: "policy" }))
      return HttpServerResponse.text("unavailable", { status: 503 })
    }
    const request = yield* HttpServerRequest.HttpServerRequest
    const sql = yield* SqlClient.SqlClient
    return yield* Egress.forward(request, policy.value).pipe(
      Effect.provide(Layer.merge(vault(guest, keys.value, sql), audit(guest, sql))),
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
