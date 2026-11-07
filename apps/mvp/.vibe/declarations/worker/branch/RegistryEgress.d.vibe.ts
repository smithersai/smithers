import { Egress } from "@smthrs/secrets";
import { Effect, Layer, Metric } from "effect";
import type { HttpClient, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { SandboxBranch } from "./Sandboxes.vibe";
/**
 * The hosts every box reaches, by exact name: npm's registry and Yarn's copy of it, PyPI's index and files, crates.io's
 * API, index and downloads, Go's module proxy and checksum database, GitHub and its release downloads (a download
 * answers with a redirect to an asset host, which the box's own client follows), and dprint's plugins.
 */
export declare const HOSTS: readonly ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "crates.io", "index.crates.io", "static.crates.io", "proxy.golang.org", "sum.golang.org", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "plugins.dprint.dev"];
/**
 * Whether `branch`'s box gets the secrets egress rather than this one: SANDBOX_SECRETS is on (`secretsOn`) and the box
 * isn't a check job's (`kind: "job"`), which never holds a placeholder.
 */
export declare const secretsEgress: (branch: SandboxBranch | undefined, secretsOn: boolean) => boolean;
/**
 * What every box's commands get so their tools trust the egress's CA `ca`, which signs the HTTPS the egress reads: Node
 * (npm, pnpm) through `NODE_EXTRA_CA_CERTS`, and dprint, whose own TLS stack reads `DPRINT_CERT`. Everything that reads
 * the system store (curl, git, pip, Go) trusts it from the wake (worker/secrets/SandboxEgress.ts `TRUST`), which also
 * exports these to every login shell.
 */
export declare const trustOf: (ca: string) => Readonly<Record<string, string>>;
/** The policy a box without secrets is held to: no secret, and only `HOSTS`. */
export declare const POLICY: Egress.Policy;
/** Requests boxes made through the registry egress, by `outcome`: `forwarded`, or the refusal's code. */
export declare const requests: Metric.Counter<number>;
/** The forwarder's vault and audit: no secret to reveal, decisions counted. */
export declare const services: Layer.Layer<Egress.Audit | Egress.Vault, never, never>;
/** Answers one of a box's outbound requests: forwarded to a registry host, else refused (403). */
export declare const forward: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpClient.HttpClient>;
