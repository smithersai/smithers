# Proxy budget admission

`POST /anthropic/v1/messages` accepts only models priced in
`src/server/proxy/modelPrices.ts`, including eight-digit snapshot suffixes.
Unknown models and context-window aliases return 400 before forwarding.

Requests must include integer `max_tokens` from 1 through 64000 and fit in
48000 UTF-8 bytes. Only text, thinking history and local tool calls/results
are supported. Images, documents, remote sources, server tools, one-hour
cache writes, beta headers, compressed bodies and extra top-level fields
return 400. These restrictions keep input below the long-context threshold
and exclude charges that the token price table cannot represent.

Admission reserves the output-token maximum plus a conservative input bound
of four tokens per serialized byte and 4096 framing tokens. All input is
reserved at the highest input/cache rate. A single conditional SQL insert
checks session spend and repository month-to-date spend plus all outstanding
reservations. API-key caps also include reservations. At most four requests
per repository may be outstanding. Insufficient headroom returns 402;
unavailable accounting returns 503. Small completed spend alone does not
imply enough headroom for another request.

Each admission generates a request ID. Settlement uses it as the usage-event
primary key and commits the session debit, event and reservation release in
one D1 batch. Replaying settlement records once. A failed batch retains the
hold and its persisted settlement payload; the next request for that repo
retries pending settlements before admission.

Definite upstream errors without usage release their holds. Transport errors,
redirect failures and successful responses without readable usage retain
their holds. Fifteen minutes after admission, three times the upstream
deadline, the next admission for that repository settles each unresolved hold
at its full reserved cost: a usage event of kind `expired_hold` (or a top-up
of the call's partial event) dated at admission, plus the session debit. The
charge bounds the call's real spend, stays in the month the call ran and
frees its in-flight slot. `review_reservations_held` on `/metrics` counts
outstanding holds per repository.

Upstream requests have a five-minute deadline covering headers and response
body. Request aborts and response cancellation stop upstream inference.
Streaming metering follows client backpressure, keeps only cumulative usage
and a bounded current SSE frame (64 KiB characters), and skips oversized
content frames. Interrupted streams persist usage from complete frames
already forwarded while retaining the full hold. The observed debit and hold
both count against admission until the hold expires. Incomplete streams that
reach EOF without final usage keep the hold. Non-streaming JSON metering is
limited to 1 MiB characters; larger responses still pass through and retain
their hold.

Operator API keys must authorize a registered repository. Their optional
spend cap is a threshold on that repository's cumulative UTC calendar-month
spend, including direct requests and sessions from any credential; it is not
a separate per-key ledger or a budget pooled across repositories. Proxy
admission also counts all outstanding repository reservations against it.

Sessions minted with an API key persist its hash. Minting rejects revoked or
exhausted keys before claiming PR quota and limits the session cap to the
smaller of the repository's per-session cap and the key's remaining monthly
budget. Every session authentication reloads its parent key: deletion,
revocation or removal of repository access invalidates the session. Proxy
admission enforces the live parent cap, including later reductions and other
sessions' spend and reservations. OIDC sessions and sessions issued before
this migration have no recorded parent; existing sessions expire within two
hours and cannot retroactively inherit a key identity.

Session minting, proxy admission and `GET /api/plan` use the same repository
monthly-cap check. At exhaustion they return 402 with `error` set to
`repo monthly spend cap exhausted` and fields `repo`, `month` (`YYYY-MM`
in UTC), `monthlyCapUsd` and `spentUsd`. Below the cap, the plan endpoint
returns its usual plan and quota data.
