/**
 * The webhook alert sink: one POST per alert, keyed so the receiver can
 * dedupe on it.
 *
 * The transport rules live here rather than beside the policy, because which
 * endpoint is paged, over which scheme, carrying which credential is a
 * deployment's decision and the delays are not.
 *
 * @since 1.0.0
 */
import { Duration, Layer } from "effect";
import { Sink } from "./AlertSink.vibe";
/**
 * How long the webhook sink waits for an answer before it calls the page
 * refused.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const defaultWebhookTimeout: Duration.Duration;
/**
 * A sink that POSTs each alert to one webhook.
 *
 * The body is the alert plus its {@link alertId}, and the same id is sent as
 * an `Idempotency-Key` header, because the package requires the receiver to
 * dedupe on it and a body without it cannot. The header is set after the
 * caller's headers, so it is the one this sink sends.
 *
 * The endpoint must be an absolute `http:` or `https:` URL, checked when the
 * layer is built, and the request is made with redirect following disabled:
 * the caller's headers can carry a credential, and a followed redirect would
 * re-send them to an origin the deployment never named. A 3xx answer is a
 * refusal like any other non-2xx, not a forwarding instruction. The sink owns
 * its Fetch transport; an externally supplied `HttpClient` is not used.
 * Each delivery has its own scope, which aborts the request and releases any
 * unread response body on completion, failure, timeout, or interruption.
 *
 * The url is treated as a credential, because a webhook's secret usually is
 * its path or query. The delivery's HTTP span is named for the method and
 * records the scheme, host, port and answering status, never the path, the
 * query or userinfo, and it fails with the same url-free reason the sink
 * returns. A host that records HTTP headers on spans gets every name in
 * `headers`, and a redirect's `location`, as `<redacted>`.
 *
 * A non-2xx response is a failure, not a delivery, and an endpoint that never
 * answers is a failure after `timeout`. Paging is exactly the case where a
 * silently dropped request is worse than a retry, and a hung request is worse
 * than either: it is indistinguishable from silence, so it must not be
 * possible to wait on one forever.
 *
 * @param options the endpoint, any headers it needs, and how long to wait
 * @category layers
 * @since 0.1.0
 */
export declare const layerWebhook: (options: {
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly timeout?: Duration.Duration | undefined;
}) => Layer.Layer<Sink>;
