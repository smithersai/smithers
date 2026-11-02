import { Layer } from "effect";
/**
 * The native coding host's request executor, naming the engine dispatch each
 * model call runs under on requests to the install's metered proxy (T-FLW-07).
 * The attribution itself is shared with the host's judge client
 * (packages/smithers/src/internal/MeteredDispatch.ts).
 */
import * as RequestExecutor from "@smthrs/model/RequestExecutor";
import * as MeteredDispatch from "../../../../../packages/smithers/src/internal/MeteredDispatch.ts";
/** The proxy reads this header only from a flow host credential. */
export declare const header = "X-Smithers-Native-Step";
/** `executor`, naming the current dispatch on every request to `proxy`. */
export declare const attribute: typeof MeteredDispatch.attributeExecutor;
/** `base`, attributed to the proxy the host's environment names. */
export declare const layer: (base: Layer.Layer<RequestExecutor.RequestExecutor>, proxy: string | undefined) => Layer.Layer<RequestExecutor.RequestExecutor>;
