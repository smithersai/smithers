# Browser fetch deadline

`browserFetch` uses one `timeoutMs` deadline for DNS resolution, response headers,
redirect hops and body reads. The default is 10,000 ms. A deadline returns
`{ ok: false }` with a message that reading the current host took too long.

The deadline bounds caller settlement. Transport cleanup is best-effort and
fire-and-forget: redirect bodies, capped readers and interrupted readers are
cancelled without waiting for cancellation to settle. Cancellation rejections are
ignored. A stalled cancellation cannot delay a redirect, a capped result or a
deadline failure. An errored redirect body does not prevent processing its status
and location.

## Resolution and framing answers

A hostname whose resolver returns no addresses fails with
`The host <name> could not be resolved.` A resolver that errors, including a
non-2xx answer from the DNS-over-HTTPS endpoint, fails with
`The name resolver did not answer (<cause>); try again.` so an outage is never
mistaken for an unknown name.

Every delivered `Content-Security-Policy` is enforced on its own. If any policy
carries a `frame-ancestors` directive that does not admit every origin, the page
is reported as unframeable and `blockReason` names that directive.
