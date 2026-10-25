import { Egress } from "@smthrs/secrets"
import { Effect, Layer, Metric } from "effect"
import type { HttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SandboxBranch } from "./Sandboxes.ts"

// A box's registry egress (ruling ARCH-15, docs/features/sandbox-tools.md#the-machine): what the outbound HTTP and HTTPS
// of a branch's, a TODO's or a check job's box reach when it holds no secret. Most repositories install packages and
// toolchains before they build, so every box reaches the package registries below, and nothing else: no other host, and
// never a secret, since the policy names none. With SANDBOX_SECRETS on, a branch's or a TODO's box gets the secrets
// egress instead, which allows these hosts too (worker/secrets/SandboxEgress.ts `allowHosts`); a check job's box never
// does. Wired by the box's `SandboxObject` (worker/BranchSandboxes.ts), which routes every outbound request but the
// forge's here; `@smthrs/secrets`' `Egress.forward` decides each one under a policy with no secrets, never follows a
// redirect, and logs `secrets.egress` per request.

/**
 * The hosts every box reaches, by exact name: npm's registry and Yarn's copy of it, PyPI's index and files, crates.io's
 * API, index and downloads, Go's module proxy and checksum database, GitHub and its release downloads (a download
 * answers with a redirect to an asset host, which the box's own client follows), and dprint's plugins.
 */
export const HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "plugins.dprint.dev",
] as const

/**
 * Whether `branch`'s box gets the secrets egress rather than this one: SANDBOX_SECRETS is on (`secretsOn`) and the box
 * isn't a check job's (`kind: "job"`), which never holds a placeholder.
 */
export const secretsEgress = (branch: SandboxBranch | undefined, secretsOn: boolean): boolean =>
  secretsOn && branch?.kind !== "job"

/**
 * What every box's commands get so their tools trust the egress's CA `ca`, which signs the HTTPS the egress reads: Node
 * (npm, pnpm) through `NODE_EXTRA_CA_CERTS`, and dprint, whose own TLS stack reads `DPRINT_CERT`. Everything that reads
 * the system store (curl, git, pip, Go) trusts it from the wake (worker/secrets/SandboxEgress.ts `TRUST`), which also
 * exports these to every login shell.
 */
export const trustOf = (ca: string): Readonly<Record<string, string>> => ({ NODE_EXTRA_CA_CERTS: ca, DPRINT_CERT: ca })

/** The policy a box without secrets is held to: no secret, and only `HOSTS`. */
export const POLICY: Egress.Policy = { secrets: [], allow: HOSTS }

/** Requests boxes made through the registry egress, by `outcome`: `forwarded`, or the refusal's code. */
export const requests = Metric.counter("smithers_registry_egress_requests", {
  description: "Outbound requests from sandbox machines through the registry egress, by outcome",
  incremental: true,
})

// No secret is ever revealed: the policy names none, so the vault is never asked.
const vault = Layer.succeed(
  Egress.Vault,
  Egress.Vault.of({ reveal: (name) => Effect.fail(new Egress.SecretUnavailable({ name })) }),
)

// Decisions are counted, not stored: they reveal no secret, so `secret_events` has nothing to keep, and a package
// install makes hundreds.
const audit = Layer.succeed(
  Egress.Audit,
  Egress.Audit.of({ record: (entry) => Metric.update(Metric.withAttributes(requests, { outcome: entry.outcome }), 1) }),
)

/** The forwarder's vault and audit: no secret to reveal, decisions counted. */
export const services = Layer.merge(vault, audit)

/** Answers one of a box's outbound requests: forwarded to a registry host, else refused (403). */
export const forward = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpClient.HttpClient> =>
  Egress.forward(request, POLICY).pipe(
    Effect.provide(services),
    Effect.withSpan("sandbox.registry.egress"),
  )
