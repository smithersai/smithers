import { Config, Effect, Layer, Option } from "effect";
import type { HttpClient } from "effect/http";
import { DomainProvider, type Provider } from "./Provider.vibe";
/** The zone the `dns` provider reserves under `alchemy dev` when DOMAINS_ZONE is unset. */
export declare const DEV_ZONE = "localhost";
/** The provider `DOMAINS_PROVIDER` names, over the `HttpClient` in context; with `dev`, `dns` when it names none. */
export declare const provider: (options?: {
    readonly dev?: boolean;
}) => Effect.Effect<Option.Option<Provider>, Config.ConfigError, HttpClient.HttpClient>;
/** `provider` as the `DomainProvider` layer. */
export declare const layer: (options?: {
    readonly dev?: boolean;
}) => Layer.Layer<DomainProvider, Config.ConfigError, HttpClient.HttpClient>;
