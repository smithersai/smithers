import { Context, Effect, Layer } from "effect";
import { HttpClient, type HttpClientError, type HttpClientResponse } from "effect/http";
declare const PinClient_base: Context.ServiceClass<PinClient, "@smthrs/mvp/pins/PinClient", {
    readonly post: (payload: Readonly<Record<string, unknown>>, stamping: boolean) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
}>;
/** Captures the host's authenticated client before a run adds its own services. */
export declare class PinClient extends PinClient_base {
    static readonly layer: (origin: string) => Layer.Layer<PinClient, never, HttpClient.HttpClient>;
}
export {};
