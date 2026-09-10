# Worker errors

Durable Object transport failures use the route's JSON contract:

- Turn-budget checks admit the call with the configured ceiling as remaining
  budget and log the cause. Unreadable responses use the same fallback.
- Turn registration and cancellation return HTTP 502 with `status: "error"`
  and a `message`. A failed registration never starts a model request. A
  failed cancellation does not establish whether the turn is still running.
- Admin client-error reads return HTTP 200 with `status: "ok"`, an empty log,
  and a `note` stating that the log is unavailable. The cause is logged.

Both Worker entrypoints catch unexpected route failures, log the cause, and
return HTTP 500 with `status: "error"`, a generic `message`, and the isolation
headers every JSON answer carries. A client that disconnects interrupts the
route's fiber — its finalizers run, the upstream fetch aborts — and reads
HTTP 499; an interruption is never restated as a 500. The native adapter
(`src/index.ts`) goes through `runRequest` and the deployed Worker
(`src/Worker.ts`) through `runFetch`; both map the fiber's exit with the same
`responseFromExit` in `src/Boundary.ts`, so the two paths answer identically.
This boundary covers response creation; errors after a streaming response
has been returned remain the stream handler's responsibility.

`UPSTREAM_TIMEOUT_MS` bounds upstream response headers, defaulting to 20,000
milliseconds when unset or invalid. The model turn and stream routes, admin
forwards and health reads, identity and billing proxies, and gateway calls
share `fetchWithDeadline` in `src/Http.ts`, read through
`ServerConfig.upstreamTimeoutMs` (`src/Config.ts`). The deadline covers
headers only: a streaming body continues past it, and caller cancellation
(fiber interruption) remains effective and aborts the upstream fetch.

Model and admin forward deadlines return HTTP 504 with `status: "error"`
and a `message` naming the effective duration in milliseconds:
`${seam} did not answer within ${timeoutMs}ms.` (`UpstreamTimeout` in
`src/Failures.ts`). Turn deadlines also settle the cancellation registry.
Client disconnects on model routes remain HTTP 499 (`src/Boundary.ts`).
Gateway deadlines retain the states and retry policy in
[gateway-retries.md](gateway-retries.md).

Admin health retains its HTTP 200 partial report: timed-out health checks
have `status: "failed"` and a detail naming the effective deadline. An
unavailable balance or request queue remains `null`.

Turn cancellation registrations carry a unique generation. Internal `/state`,
`/cancel`, and `/settle` calls require `x-turn-generation`; stale or absent
values cannot read or change a replacement registration. The public cancel
route still accepts `{ runId }`: it resolves the owner's current generation
through `/current` before attempting cancellation. A replacement between
those calls returns `not-found` instead of cancelling the replacement.

The terminal frame, headers deadline, disconnect, and stream finalization
share one settlement. Settlement runs under `waitUntil`, including when the
client disconnects; the deployed Worker (`src/Worker.ts`) hands the router
the platform execution context for that, and the native adapter in
`src/index.ts` takes it from workerd's `ctx`. Settlement failures are logged;
the ten-minute stale registration window remains the recovery backstop.

Silent turn polling backs off from 500 milliseconds to 5 seconds, resets on
upstream data, and stops after 96 registry reads. A monitoring failure or
exhausted poll allowance aborts upstream, settles the registration, and emits
a terminal `done` frame with `reason: "stop"` and an explanatory `error`.
Registry read failures and stream cleanup rejections are logged.
