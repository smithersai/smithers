# Repository waitlist

People can request hosting for a repository that is not on Smithers yet through `POST /api/waitlist/join`. [Decision 0172](../decisions/0172-ux-ui-workbench-and-minimal-text.md) records the intent-triggered UX.

## Contract

- **Route:** `POST /api/waitlist/join` with `{ repoUrl, workflowNote? }`.
- **Body limit:** `4,096` bytes enforced at admission (`worker/BodyLimits.ts`) before JSON parsing.
- **Rate limit:** dedicated `WAITLIST_LIMIT` bucket (60 requests per network per minute) in `worker/Throttle.ts`. Fails closed with `503` if the limiter errors.
- **Normalization:** HTTPS URLs only, no embedded credentials, no non-default ports, query and fragment dropped. GitHub URLs require a canonical two-segment root (`https://github.com/<owner>/<repo>`).
- **Auth boundary:** delegated run credentials return `403 person_only`. Refused `Authorization` or device-principal headers return `401 authentication` instead of falling back to anonymous writes.
- **Storage:** Postgres table `waitlist_entries` (migration `0134_waitlist_entries.ts`), unique on `(normalized_url, requester)`. Resubmission returns the same `position`. Anonymous rows never store free-form notes.
- **Observability:** span `waitlist.join` and counter `smithers_waitlist_joins` by `outcome`. No credentials or raw payloads are logged.
