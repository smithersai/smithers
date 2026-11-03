/**
 * The local host's half of a configured model (@smthrs/rpc/ConfiguredModel):
 * which credentials this machine resolves, the catalog it reports, and the
 * failure mapping every local call shares.
 *
 * A credential is read by NAME from the host keychain or the environment
 * record it was started with, at exactly one env key, and only after the
 * planner has pinned the request's origin to that name. The value is Redacted
 * at the read and is sent nowhere but the planned URL: redirects are never
 * followed, and no failure here carries provider text.
 *
 * @since 1.0.0-rc.0
 */
import { ConfiguredModel } from "@smthrs/rpc";
import { type Effect, Redacted } from "effect";
/**
 * Model values stay behind this host-only interface. Listing and planning
 * never hold one.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ModelCredentials {
    readonly refresh: () => Effect.Effect<void, unknown>;
    readonly list: () => ReadonlyArray<ConfiguredModel.ModelCredentialListing>;
    readonly read: (name: string) => Redacted.Redacted<string> | undefined;
}
/**
 * The value behind a credential NAME, Redacted at the read; undefined when unset or blank.
 *
 * @category credentials
 * @since 1.0.0-rc.0
 */
export declare const localModelCredential: (env: ConfiguredModel.ModelCredentialEnv, name: string) => Redacted.Redacted<string> | undefined;
/**
 * A binding this host agreed to serve, with the one secret its plan names.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type LocalPlanned = {
    readonly ok: true;
    readonly plan: ConfiguredModel.ModelPlan;
    readonly apiKey: Redacted.Redacted<string>;
} | {
    readonly ok: false;
    readonly failure: ConfiguredModel.ModelTestFailure;
};
/**
 * Plans an untrusted binding against THIS host's table, then reads the secret the plan names and no other.
 *
 * @category planning
 * @since 1.0.0-rc.0
 */
export declare const planOnLocal: (input: unknown, env: ConfiguredModel.ModelCredentialEnv, options?: ConfiguredModel.ModelPlanOptions, credentials?: ModelCredentials) => LocalPlanned;
/**
 * GET /api/model/catalog on this host: names, presence and origins. Never a
 * value. `options` are the ones this host's Test plans with, so an offline
 * host lists no row it could not reach.
 *
 * @category planning
 * @since 1.0.0-rc.0
 */
export declare const localModelCatalog: (env: ConfiguredModel.ModelCredentialEnv, options?: ConfiguredModel.ModelPlanOptions, stored?: ModelCredentials) => ConfiguredModel.ModelCatalog;
/**
 * The ONLY mapping from a provider failure to the contract's union. It reads
 * codes and numbers and never a message: a provider's words, and a transport
 * error's URL, stop here.
 *
 * @category failures
 * @since 1.0.0-rc.0
 */
export declare const modelFailureOf: (error: unknown, deadlineMs?: number) => ConfiguredModel.ModelTestFailure;
