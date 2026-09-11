# Launch checklist driver

Run `bun scripts/launch-checklist.ts --target https://your-target.example` from
`apps/app`. `--dry-run` exercises report generation without network or browser
access. `--out <dir>` selects the report directory.

Each session-cookie identity, including the signed-out identity, gets an isolated
Chrome browser context. Pages are cached per identity for the run. The driver
installs host-only cookies using the explicit target URL, path `/`, Secure and
HttpOnly. It never sets a page-wide Cookie header. Cookies follow browser host
and transport rules on subresources and redirects; they do not authenticate
external hosts or subdomains. Secure cookies require a secure target (subject to
Chrome's localhost exception). Cookie scope does not isolate ports on one host.

The driver connects to Chrome's browser DevTools endpoint and attaches to each
context's page using a flattened CDP session. Socket opening and each CDP request
have a 30-second deadline, configurable through `requestTimeoutMs` in the driver
options. Protocol failures reject with the method, request ID and CDP error code.
Socket close or error rejects all pending requests and subsequent sends.
Evaluation rejects malformed responses and page exceptions; a valid CDP
`undefined` result still returns JavaScript `undefined`.

Each checklist row has a 120-second budget for its probe, the row's single
lifecycle. Library callers can set `runChecklist({ rowTimeoutMs, ... })`. Expiry
records a failed row and continues to the next row, even if the probe ignores
cancellation. A row that must undo state left by an earlier run does that inside
its probe and reports one outcome. The row signal reaches fetch, streamed
response bodies, browser startup, page calls and sleeps. Custom probes should use
these context methods and `ctx.signal` for additional work. The signal is also
aborted when the row finishes to cancel leftover operations.

The CLI writes JSON and Markdown reports before the first row and after every
completed row through `onProgress`. Reports during a run contain completed rows
only. Earlier results therefore remain on disk while a later row is pending.
The browser is closed in `finally`, including when report writing fails.

B-1 submits a unique prompt and observes the associated reply grow while the
transcript's `aria-busy` projection of `session.phase` is true. It then reloads
the page and requires a new navigation time origin, the same prompt and partial
reply, an idle session, and that reply's app-closed interruption note. An old prompt,
a pending indicator alone, or a reply that completed before interruption does
not prove recovery.

E-3 requires `CHECKLIST_BILLING_UPSTREAM_URL`, `CHECKLIST_BILLING_ADMIN_TOKEN`,
and `CHECKLIST_BILLING_PRODUCT_SERVICE_TOKEN`. It creates a unique synthetic
account name for each invocation and grants that account $1 with an
`admin:`-prefixed grant ID. The admin token authenticates the write through
`x-smithers-admin-token`; the product service token authenticates the isolated
account reads through `x-smithers-service-token` and `x-user-login`.

E-3 reads `/api/billing/balance` without caching before the grant, after the
first grant, and after its identical replay. Each response must name the
isolated user and expose `balance.totalNanos` and `credits`. The first grant
must add exactly one dollar and one credit with the requested attribution and
timestamp. Replay must leave both the balance and all durable credit records
unchanged. HTTP 201 followed by HTTP 200 with `duplicate: true` is insufficient.
The synthetic account retains the grant and its audit record after the probe.
