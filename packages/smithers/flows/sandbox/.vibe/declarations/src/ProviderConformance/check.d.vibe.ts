/**
 * Runs the provider conformance suite.
 *
 * @since 0.1.0
 */
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { Provider } from "../../../../src/RemoteChildProcessSpawner/Provider.ts";
import { type Commands } from "./Commands.vibe";
import type { Violation } from "../../../../src/ProviderConformance/Violation.ts";
/**
 * Bounds how long the suite waits on a provider that does not answer.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckOptions {
    /**
     * How long any single check may take, session acquisition included, before
     * it is convicted as hung. Default 10 seconds. Raise it explicitly for slow
     * machine provisioning and size the test budget for the whole suite.
     */
    readonly checkTimeout?: Duration.Input | undefined;
}
/**
 * Checks one provider against the `Provider` contract.
 *
 * A plugin that ships a provider runs this in its own test suite and asserts
 * the result is empty. The suite is the contract in executable form: what the
 * prose in `RemoteChildProcessSpawner` promises callers, stated as behavior an
 * adapter has to produce. It runs the checks through the real adapter layer,
 * because a provider that satisfies the interface but not the adapter is of no
 * use to a caller.
 *
 * The optional capabilities are checked only when the provider declares them.
 * A provider without `ping` is not asked to answer one, a provider without
 * `kill` is not asked to signal, and a provider that does not declare `stdin`
 * is not asked to deliver any: those are documented absences, not defects. A
 * provider that DOES declare one is held to it, `stdin` included — the flag is
 * what makes the adapter hand the bytes over, so a suite that took it at its
 * word would pass an adapter that sets it and drops them.
 *
 * Every check runs under {@link CheckOptions.checkTimeout} on the platform
 * timer rather than the ambient `Clock`, so an adapter that never answers
 * yields a named violation instead of a hang, under a frozen test clock too.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const check: (provider: Provider, commands: Commands, options?: CheckOptions) => Effect.Effect<ReadonlyArray<Violation>>;
