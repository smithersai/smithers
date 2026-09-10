# status.smithers.sh

The public status page. Everything it shows lives in [`site/status.json`](site/status.json);
[`site/index.html`](site/index.html) fetches that file and renders it.

`/status.json` allows cross-origin reads on success and error responses. The page
revalidates on every load with `cache: "no-cache"`; other clients may cache the
feed for 60 seconds. Asset ETags and 304 responses are preserved. Refused feeds
return an uncached JSON 404 with `error: "status feed unavailable"` and a `reason`:
`missing` for an asset 404, `not-json` for a non-JSON 200, or `unexpected-status`
for other statuses. A warning records the asset status, content type, and pathname.

The page is served with a Content-Security-Policy that allows only the inline
script in `index.html` by SHA-256 hash, plus `referrer-policy` and
`frame-ancestors 'none'`. `tests/worker.test.ts` recomputes the hash from the
file, so editing the script means updating the constant in `src/worker.ts` in
the same commit. Only a non-HTML 200 under `/assets/` is cached as immutable;
the SPA fallback page keeps the five-minute page policy, and any status outside
200/304 is `no-store`, so a broken deploy is gone as soon as the next one lands.

## Truth rules

`tests/worker.test.ts` enforces these, so breaking one fails the build:

- A day with no entry in `history` renders as **no data**, never as operational.
  Days before `monitoringSince` are no data by definition.
- No SLA, no uptime percentage, no 24/7 support claim in `index.html` or in
  the copy `status.json` carries (`overallNote`, descriptions, history notes,
  incident bodies).
- No subscribe box, because nothing is wired up behind one.
- `index.html` ships a static copy of the banner, the `Last updated` stamp,
  the overall note and the component rows so readers without JavaScript see
  real state. The test reads that markup without running the script and
  compares it to `status.json`: banner class and heading, stamp date against
  `updatedAt`, note against `overallNote`, and each row's name, description,
  state class and badge label. **Edit both files in the same commit.**

Review conventions the tests only partly cover:

- Only components that actually exist and were verified get listed. The test
  rejects a `docs` component; everything else is checked by the reviewer and by
  `tests/rcSurfaces.test.ts` below.

`tests/rcSurfaces.test.ts` adds the half `worker.test.ts` cannot see: it reads
this repository's own manifests, so a component that still names a renamed
package fails even though the page and the feed agree with each other.

## Change a component's state

1. Edit the component's `status` in `site/status.json` (`operational`,
   `degraded`, `outage`, `maintenance`).
2. Set the top-level `overall` to the worst state you want the banner to show,
   bump `updatedAt` to now (UTC, ISO 8601), and reword `overallNote` if the
   situation changed.
3. Add or update today's entry under `history`, keyed `YYYY-MM-DD`.
4. Mirror the banner class and heading, the `Last updated` stamp (the date part
   of `updatedAt`), the note and the component rows with their badge labels into
   the static block in `site/index.html` (the tests tell you exactly what to
   change).
5. `pnpm -C apps/status-site test && pnpm -C apps/status-site deploy`

## File an incident

Prepend to the `incidents` array (the page also sorts newest-first):

```json
{
  "id": "2026-08-09-plugin-registry-500s",
  "title": "Plugin registry returning 500s",
  "status": "investigating",
  "startedAt": "2026-08-09T14:02:00Z",
  "resolvedAt": null,
  "components": ["plugins"],
  "updates": [
    { "at": "2026-08-09T14:02:00Z", "status": "Investigating", "body": "We are looking into elevated errors on plugins.smithers.sh." }
  ]
}
```

Post progress by appending to `updates`. When it is over, set `status` to
`"resolved"` and `resolvedAt`, and put the day's real state into `history`.

## Deploy

Not run by CI. Authenticate once with `wrangler login` (OAuth, no long-lived
token on disk), then:

```sh
pnpm -C apps/status-site test
pnpm -C apps/status-site deploy
```

For CI or a non-interactive shell, configure `CLOUDFLARE_API_TOKEN` through
your usual secret mechanism (a gitignored `.env`, or the runner's secret
store). Never type the token on the command line: shell history keeps it in
plaintext, and it can replace the public status page.

Every request runs the Worker (`run_worker_first: true`) because the cache and
page policy depends on the response, not on the path: under the
single-page-application fallback a request below `/assets/` can come back as the
index page, and a `site/_headers` file is matched against the request URL and is
attached to error responses too, so it can express neither rule.

`wrangler.jsonc` claims `status.smithers.sh` as a custom domain.
`alchemy.run.ts` is the alternative deploy path; `apps/bug-worker/alchemy.run.ts`
uses the same pattern for `bug.smithers.sh`.
